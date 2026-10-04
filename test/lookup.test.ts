import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { createAnthropicProvider } from '../src/main/ai/anthropic.ts'
import type { FileSource } from '../src/main/ai/context.ts'
import { createFakeProvider, emptyEvaluation, type FakeScript } from '../src/main/ai/fake.ts'
import { createGeminiProvider } from '../src/main/ai/gemini.ts'
import { createReviewTools, type ReviewTools } from '../src/main/ai/lookup.ts'
import { createOpenAIChatProvider, createOpenAIResponsesProvider } from '../src/main/ai/openai.ts'
import type { ProviderRequest, ReviewProvider } from '../src/main/ai/provider.ts'
import { startRun, type RunnerOptions } from '../src/main/ai/runner.ts'
import type { AiRun, ChangedFile, Comparison } from '../src/shared/types.ts'

const CART_V1 = `export function total(items) {
  let sum = 0
  for (const i of items) sum += i.price
  return sum
}
`
const CART_V2 = `export function total(items, taxRate) {
  let sum = 0
  for (const i of items) sum += i.price
  return sum * (1 + taxRate)
}
`
const CHECKOUT = `import { total } from './cart'

export function checkout(items) {
  return total(items)
}
`

/** A repository with one commit on main and one on topic that changes cart.js; checkout.js calls it. */
function repo(): { root: string; baseSha: string; headSha: string } {
	const root = mkdtempSync(join(tmpdir(), 'review-lookup-'))
	const git = (...a: Array<string>): string =>
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
			cwd: root,
			encoding: 'utf8',
		}).trim()
	const write = (path: string, text: string): void => {
		mkdirSync(dirname(join(root, path)), { recursive: true })
		writeFileSync(join(root, path), text)
	}
	git('init', '-q', '-b', 'main')
	write('src/cart.js', CART_V1)
	write('src/checkout.js', CHECKOUT)
	write('README.md', '# Shop\n')
	git('add', '.')
	git('commit', '-q', '-m', 'base')
	const baseSha = git('rev-parse', 'HEAD')
	write('src/cart.js', CART_V2)
	git('commit', '-q', '-am', 'tax')
	// Uncommitted: never visible to lookups.
	write('src/secret.js', 'export const key = 1\n')
	return { root, baseSha, headSha: git('rev-parse', 'HEAD') }
}

const signal = new AbortController().signal

test('lookups read files at either commit, search and list the head commit, and never reach outside it', async () => {
	const r = repo()
	const tools = createReviewTools(r, { maxCalls: 20, maxChars: 100_000 })

	const head = await tools.call('read_file', { path: 'src/cart.js', version: 'head', start_line: 1, end_line: 2 }, signal)
	assert.equal(head.error, false)
	assert.match(head.text, /lines 1-2 of 5/)
	assert.match(head.text, /1 \| export function total\(items, taxRate\)/)
	assert.match(head.text, /lines 3-5 not shown/)
	const base = await tools.call('read_file', { path: './src/cart.js', version: 'base', start_line: null, end_line: null }, signal)
	assert.match(base.text, /export function total\(items\) \{/)
	assert.match(base.text, /return sum$/m)

	const search = await tools.call('search_code', { text: 'total(', path_prefix: null }, signal)
	assert.match(search.text, /src\/checkout\.js:4: return total\(items\)/)
	assert.match(search.text, /src\/cart\.js:1:/)
	const scoped = await tools.call('search_code', { text: 'total(', path_prefix: 'src/checkout.js' }, signal)
	assert.ok(!scoped.text.includes('src/cart.js'))
	const list = await tools.call('list_files', { directory: '' }, signal)
	assert.match(list.text, /README\.md\nsrc\//)

	// The working tree is never read, nor anything outside the repository.
	assert.equal(
		(await tools.call('read_file', { path: 'src/secret.js', version: 'head', start_line: null, end_line: null }, signal)).error,
		true,
	)
	for (const path of ['../etc/passwd', '/etc/passwd', 'src/../../x', 'C:/x']) {
		const res = await tools.call('read_file', { path, version: 'head', start_line: null, end_line: null }, signal)
		assert.equal(res.error, true, path)
	}
	assert.equal((await tools.call('search_code', { text: 'x', path_prefix: null }, signal)).error, true, 'too short')
	assert.equal((await tools.call('delete_file', {}, signal)).error, true)
	assert.deepEqual(tools.log.paths, ['src/cart.js', './'])
	assert.deepEqual(tools.log.searches, ['total(', 'total( (in src/checkout.js)'])
	assert.equal(tools.log.refused, 7)
})

test('a request stops offering lookups once its calls or characters are used up', async () => {
	const r = repo()
	const byCalls = createReviewTools(r, { maxCalls: 2, maxChars: 100_000 })
	await byCalls.call('list_files', { directory: 'src' }, signal)
	assert.equal(byCalls.exhausted(), false)
	await byCalls.call('list_files', { directory: 'src' }, signal)
	assert.equal(byCalls.exhausted(), true)
	const over = await byCalls.call('list_files', { directory: 'src' }, signal)
	assert.match(over.text, /limit for this request is used up/)
	assert.equal(byCalls.log.calls, 2)

	const byChars = createReviewTools(r, { maxCalls: 20, maxChars: 120 })
	const cut = await byChars.call('read_file', { path: 'src/cart.js', version: 'head', start_line: null, end_line: null }, signal)
	assert.ok(cut.text.length <= 120)
	assert.match(cut.text, /cut: the lookup limit/)
	assert.equal(byChars.exhausted(), true)
})

// ---- provider request loops, against mock servers ----

interface Seen {
	path: string
	body: Record<string, unknown>
}

async function server(respond: (req: Seen, n: number) => { status?: number; body: unknown }) {
	const seen: Array<Seen> = []
	const s = http.createServer((req, res) => {
		let raw = ''
		req.on('data', (c) => (raw += c))
		req.on('end', () => {
			const entry = { path: req.url ?? '', body: raw ? JSON.parse(raw) : {} }
			seen.push(entry)
			const { status, body } = respond(entry, seen.length - 1)
			res.statusCode = status ?? 200
			res.setHeader('content-type', 'application/json')
			res.end(JSON.stringify(body))
		})
	})
	await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
	return {
		seen,
		base: `http://127.0.0.1:${(s.address() as { port: number }).port}`,
		close: () => new Promise<void>((r) => s.close(() => r())),
	}
}

const FINAL = JSON.stringify({ findings: [], evaluation: emptyEvaluation(), unexplained_files: [], limitations: [] })
const LIMITS = { contextWindow: 200_000, maxOutputTokens: 8000 }

/** Records calls; one call allowed, so the round after it must ask for the final answer without tools. */
function stubTools(): ReviewTools & { got: Array<{ name: string; args: unknown }> } {
	const got: Array<{ name: string; args: unknown }> = []
	return {
		got,
		definitions: createReviewTools({ root: '', baseSha: '', headSha: '' }, { maxCalls: 0, maxChars: 0 }).definitions,
		log: { calls: 0, chars: 0, refused: 0, paths: [], searches: [], external: [] },
		exhausted: () => got.length >= 1,
		async call(name, args) {
			got.push({ name, args })
			return { text: 'FILE CONTENT 42', error: false }
		},
	}
}

function request(tools?: ReviewTools): ProviderRequest {
	return {
		instructions: 'review',
		input: 'the change',
		batch: { index: 0, excerpts: [], references: [], facts: [], fileKeys: [], overview: '', chars: 0 },
		tools,
	}
}

const ARGS = { path: 'src/a.ts', version: 'head', start_line: null, end_line: null }

const LOOPS: Array<{
	name: string
	make: (base: string) => ReviewProvider
	call: unknown // the response that asks for one read_file
	final: unknown
	check: (first: Record<string, unknown>, second: Record<string, unknown>) => void
	noTools: (body: Record<string, unknown>) => boolean
}> = [
	{
		name: 'Anthropic Messages',
		make: (base) =>
			createAnthropicProvider({
				apiKey: 'sk-ant-test',
				baseURL: base,
				timeoutMs: 5000,
				model: 'claude-x',
				limits: LIMITS,
				maxOutputTokens: 1000,
			}),
		call: {
			id: 'm1',
			type: 'message',
			role: 'assistant',
			model: 'claude-x',
			stop_reason: 'tool_use',
			content: [
				{ type: 'thinking', thinking: '', signature: 'sig' },
				{ type: 'tool_use', id: 'tu1', name: 'read_file', input: ARGS },
			],
			usage: { input_tokens: 100, output_tokens: 10 },
		},
		final: {
			id: 'm2',
			type: 'message',
			role: 'assistant',
			model: 'claude-x',
			stop_reason: 'end_turn',
			content: [{ type: 'text', text: FINAL }],
			usage: { input_tokens: 150, output_tokens: 20 },
		},
		check(first, second) {
			assert.deepEqual(first.tool_choice, { type: 'auto' })
			assert.deepEqual(first.cache_control, { type: 'ephemeral' })
			assert.equal((first.tools as Array<{ name: string }>).length, 3)
			assert.deepEqual(second.tool_choice, { type: 'none' })
			const msgs = second.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
			assert.equal(msgs[1].role, 'assistant')
			assert.equal(msgs[1].content[0].type, 'thinking', 'the reply goes back unchanged, thinking included')
			assert.deepEqual(msgs[2].content[0], { type: 'tool_result', tool_use_id: 'tu1', content: 'FILE CONTENT 42', is_error: false })
		},
		noTools: (b) => !('tools' in b),
	},
	{
		name: 'OpenAI Responses',
		make: (base) =>
			createOpenAIResponsesProvider({
				kind: 'openai',
				label: 'OpenAI',
				baseURL: base,
				apiKey: 'sk-test-123456',
				timeoutMs: 5000,
				model: 'gpt-x',
				limits: LIMITS,
				maxOutputTokens: 1000,
				allowJsonModeFallback: false,
			}),
		call: {
			id: 'r1',
			object: 'response',
			status: 'completed',
			output: [
				{ type: 'reasoning', id: 'rs1', summary: [] },
				{ type: 'function_call', id: 'fc1', call_id: 'c1', name: 'read_file', arguments: JSON.stringify(ARGS), status: 'completed' },
			],
			usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
		},
		final: {
			id: 'r2',
			object: 'response',
			status: 'completed',
			output: [{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: FINAL, annotations: [] }] }],
			usage: { input_tokens: 150, output_tokens: 20, total_tokens: 170 },
		},
		check(first, second) {
			assert.equal(first.tool_choice, 'auto')
			assert.equal((first.tools as Array<{ strict: boolean }>)[0].strict, true)
			assert.equal(second.tool_choice, 'none')
			const input = second.input as Array<Record<string, unknown>>
			assert.ok(!input.some((i) => i.type === 'reasoning'), 'reasoning items are not sent back with store: false')
			const call = input.find((i) => i.type === 'function_call')!
			assert.equal(call.call_id, 'c1')
			assert.ok(!('id' in call), 'item ids refer to stored state and are dropped')
			assert.deepEqual(
				input.find((i) => i.type === 'function_call_output'),
				{ type: 'function_call_output', call_id: 'c1', output: 'FILE CONTENT 42' },
			)
		},
		noTools: (b) => !('tools' in b),
	},
	{
		name: 'Chat Completions',
		make: (base) =>
			createOpenAIChatProvider({
				kind: 'custom',
				label: 'Local',
				baseURL: base,
				apiKey: null,
				timeoutMs: 5000,
				model: 'local-x',
				limits: LIMITS,
				maxOutputTokens: 1000,
				allowJsonModeFallback: true,
			}),
		call: {
			id: 'c1',
			object: 'chat.completion',
			choices: [
				{
					index: 0,
					finish_reason: 'tool_calls',
					message: {
						role: 'assistant',
						content: null,
						tool_calls: [{ id: 'call1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify(ARGS) } }],
					},
				},
			],
			usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
		},
		final: {
			id: 'c2',
			object: 'chat.completion',
			choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: FINAL } }],
			usage: { prompt_tokens: 150, completion_tokens: 20, total_tokens: 170 },
		},
		check(first, second) {
			assert.equal(first.tool_choice, 'auto')
			assert.equal(second.tool_choice, 'none')
			const msgs = second.messages as Array<Record<string, unknown>>
			assert.equal(msgs.length, 4)
			assert.equal((msgs[2].tool_calls as Array<{ id: string }>)[0].id, 'call1')
			assert.deepEqual(msgs[3], { role: 'tool', tool_call_id: 'call1', content: 'FILE CONTENT 42' })
		},
		noTools: (b) => !('tools' in b),
	},
	{
		name: 'Gemini',
		make: (base) =>
			createGeminiProvider({
				apiKey: 'AIzaTESTKEY123456',
				baseURL: base,
				timeoutMs: 5000,
				model: 'gemini-x',
				limits: LIMITS,
				maxOutputTokens: 1000,
			}),
		call: {
			candidates: [
				{
					finishReason: 'STOP',
					content: { role: 'model', parts: [{ functionCall: { id: 'g1', name: 'read_file', args: ARGS }, thoughtSignature: 'sig' }] },
				},
			],
			usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 },
		},
		final: {
			candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: FINAL }] } }],
			usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 20, totalTokenCount: 170 },
		},
		check(first, second) {
			const mode = (b: Record<string, unknown>) =>
				((b.toolConfig ?? (b.generationConfig as Record<string, unknown>)?.toolConfig) as { functionCallingConfig: { mode: string } })
					.functionCallingConfig.mode
			assert.equal(mode(first), 'AUTO')
			assert.equal(mode(second), 'NONE')
			const contents = second.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>
			assert.equal(contents[1].parts[0].thoughtSignature, 'sig', "the model's turn goes back unchanged")
			assert.deepEqual(contents[2].parts[0], { functionResponse: { id: 'g1', name: 'read_file', response: { output: 'FILE CONTENT 42' } } })
		},
		noTools: (b) => !('tools' in b),
	},
]

for (const loop of LOOPS) {
	test(`${loop.name}: runs the model's lookups, sends the results back, then asks for the answer without more calls`, async () => {
		const s = await server((_req, n) => ({ body: n === 0 ? loop.call : loop.final }))
		try {
			const tools = stubTools()
			const res = await loop.make(s.base).review(request(tools), signal)
			assert.deepEqual(tools.got, [{ name: 'read_file', args: ARGS }])
			assert.equal(s.seen.length, 2)
			loop.check(s.seen[0].body, s.seen[1].body)
			assert.deepEqual(res.output, JSON.parse(FINAL))
			assert.equal(res.usage?.inputTokens, 250, 'usage is summed over the rounds')
			assert.equal(res.usage?.outputTokens, 30)
			assert.equal(res.toolsRejected, undefined)
		} finally {
			await s.close()
		}
	})

	test(`${loop.name}: an endpoint that refuses tools is reviewed without them, and later requests skip them`, async () => {
		const s = await server((req) =>
			'tools' in req.body
				? { status: 400, body: { error: { type: 'invalid_request_error', message: 'tools are not supported by this model', code: 400 } } }
				: { body: loop.final },
		)
		try {
			const provider = loop.make(s.base)
			const tools = stubTools()
			const res = await provider.review(request(tools), signal)
			assert.match(res.toolsRejected ?? '', /tools are not supported/)
			assert.deepEqual(res.output, JSON.parse(FINAL))
			assert.equal(s.seen.length, 2)
			assert.ok(loop.noTools(s.seen[1].body))
			await provider.review(request(tools), signal)
			assert.equal(s.seen.length, 3, 'the next request goes straight out without tools')
			assert.ok(loop.noTools(s.seen[2].body))
			assert.deepEqual(tools.got, [])
		} finally {
			await s.close()
		}
	})
}

// ---- the runner ----

function changed(path: string): ChangedFile {
	return {
		key: path,
		status: 'modified',
		oldPath: path,
		newPath: path,
		oldMode: null,
		newMode: null,
		binary: false,
		additions: 1,
		deletions: 1,
		similarity: null,
	}
}

/** The tax change to cart.js: by default the new parameter (a changed definition); `bodyOnly` edits a line inside instead. */
function cartSources(r: ReturnType<typeof repo>, bodyOnly = false): { comparison: Comparison; sources: Array<FileSource> } {
	const file = changed('src/cart.js')
	const comparison: Comparison = {
		id: `${r.baseSha}..${r.headSha}`,
		repoId: 'repo',
		baseRef: 'main',
		baseTipSha: r.baseSha,
		baseSha: r.baseSha,
		headSha: r.headSha,
		headRef: 'topic',
		target: null,
		pr: null,
		files: [file],
	}
	const sources: Array<FileSource> = [
		{
			file,
			patch: {
				kind: 'text',
				hunks: [
					{
						oldStart: 1,
						oldLines: 1,
						newStart: 1,
						newLines: 1,
						section: '',
						lines: bodyOnly
							? [
									{ kind: 'del', oldNo: 4, newNo: null, text: '  return sum' },
									{ kind: 'add', oldNo: null, newNo: 4, text: '  return sum * (1 + taxRate)' },
								]
							: [
									{ kind: 'del', oldNo: 1, newNo: null, text: 'export function total(items) {' },
									{ kind: 'add', oldNo: null, newNo: 1, text: 'export function total(items, taxRate) {' },
								],
					},
				],
			},
			fullText: { kind: 'text', lines: CART_V2.trimEnd().split('\n') },
		} as FileSource,
	]
	return { comparison, sources }
}

async function runReview(
	script: FakeScript,
	lookups: boolean,
	bodyOnly = false,
): Promise<{ run: AiRun; requests: Array<ProviderRequest> }> {
	const r = repo()
	const { comparison, sources } = cartSources(r, bodyOnly)
	const requests: Array<ProviderRequest> = []
	const provider = createFakeProvider({
		script: (req, call, looked) => {
			requests.push(req)
			return script(req, call, looked)
		},
	})
	const options: RunnerOptions = {
		provider,
		limits: { contextLines: 5, maxBatchChars: 100_000, maxRunChars: 1_000_000, relatedCode: false, lookups },
		concurrency: 1,
		maxAttempts: 1,
		backoffMs: () => 0,
	}
	const handle = startRun(
		{
			reviewId: 'rev',
			comparison,
			scope: { kind: 'all' },
			loadSources: async () => sources,
			tools: (budget) => createReviewTools(r, budget),
			previousFindings: [],
		},
		options,
		() => {},
	)
	return { run: await handle.done, requests }
}

test('runner: the reviewer reads a caller and reports on the changed line; the run records what it looked up', async () => {
	const { run, requests } = await runReview((req, call, looked) => {
		if (call === 0) return { tool_calls: [{ name: 'search_code', args: { text: 'total(', path_prefix: null } }] }
		if (call === 1) {
			assert.match(looked[0].text, /src\/checkout\.js:4: return total\(items\)/)
			return { tool_calls: [{ name: 'read_file', args: { path: 'src/checkout.js', version: 'head', start_line: 1, end_line: 5 } }] }
		}
		assert.match(looked[1].text, /return total\(items\)/)
		const excerpt = req.batch.excerpts[0]
		return {
			findings: [
				{
					excerpt_id: excerpt.id,
					file_path: 'src/cart.js',
					side: 'new',
					start_line: 1,
					end_line: 1,
					category: 'breaking-change',
					signature: null,
					test_pattern: null,
					severity: 'should_fix',
					title: 'checkout() still calls total() without a tax rate',
					body: 'Checkout totals become NaN: src/checkout.js line 4 calls total(items) with no taxRate.',
					reasoning: 'The caller passes one argument.',
					disproof: null,
					background: null,
					evidence: 'export function total(items, taxRate) {',
				},
			],
			evaluation: emptyEvaluation(),
			unexplained_files: [],
			limitations: [],
		}
	}, true)
	assert.equal(run.status, 'completed', run.errors.join('; '))
	assert.equal(run.findings.length, 1)
	assert.equal(run.findings[0].anchor.fileKey, 'src/cart.js')
	assert.ok(requests[0].instructions.includes('# Looking things up'))
	assert.ok(requests[0].instructions.includes('Your only tools are the read-only lookups'))
	assert.equal(run.limitsUsed?.lookups, true)
	assert.deepEqual(run.coverage.lookups, {
		requests: 1,
		calls: 2,
		chars: run.coverage.lookups!.chars,
		refused: 0,
		paths: ['src/checkout.js'],
		searches: ['total('],
		unavailable: null,
	})
	assert.ok(run.coverage.lookups!.chars > 0)
})

test('runner: a request gets the lookups its riskiest file earns: 12 for high risk, 8 for medium', async () => {
	// Asks for one more lookup each time, until the request's limit is reached.
	const greedy: FakeScript = (req) =>
		req.tools!.exhausted()
			? { findings: [], evaluation: emptyEvaluation(), unexplained_files: [], limitations: [] }
			: { tool_calls: [{ name: 'list_files', args: { directory: 'src' } }] }
	const high = (await runReview(greedy, true)).run
	assert.equal(high.coverage.files[0].risk?.level, 'high', 'a changed definition')
	assert.equal(high.coverage.lookups?.calls, 12)
	const medium = (await runReview(greedy, true, true)).run
	assert.equal(medium.coverage.files[0].risk?.level, 'medium', 'an edit inside the function')
	assert.equal(medium.coverage.lookups?.calls, 8)
})

test('runner: with lookups turned off, no tools are offered and the prompt says so', async () => {
	const { run, requests } = await runReview((req) => {
		assert.equal(req.tools, undefined)
		return { findings: [], evaluation: emptyEvaluation(), unexplained_files: [], limitations: [] }
	}, false)
	assert.equal(run.status, 'completed', run.errors.join('; '))
	assert.ok(!requests[0].instructions.includes('# Looking things up'))
	assert.ok(requests[0].instructions.includes('You have no tools'))
	assert.equal(run.limitsUsed?.lookups, false)
	assert.equal(run.coverage.lookups, null)
})
