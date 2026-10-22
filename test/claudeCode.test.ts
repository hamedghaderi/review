import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { sdkAdapters } from '../src/main/ai/adapters.ts'
import { createClaudeCodeAccount, createClaudeCodeProvider, interpretResult, planLimit } from '../src/main/ai/claudeCode.ts'
import { ConnectionService, normaliseCommand } from '../src/main/ai/connections.ts'
import { CredentialService, type SecretCipher } from '../src/main/ai/credentials.ts'
import { ProviderError } from '../src/main/ai/provider.ts'
import type { ReviewTools } from '../src/main/ai/lookup.ts'

const cipher: SecretCipher = {
	isAsyncEncryptionAvailable: async () => true,
	encryptStringAsync: async (s) => Buffer.from(s),
	decryptStringAsync: async (b) => ({ result: b.toString(), shouldReEncrypt: false }),
	getSelectedStorageBackend: () => 'keychain',
}

const LIMITS = { contextWindow: 1_000_000, maxOutputTokens: 128_000 }
// Generous: on a busy machine a fake's exit has been seen to reach the app seconds late (cause unknown), which a
// tight limit would report as a timeout.
const TIMEOUT = 60_000
const BATCH = { index: 0, references: [], facts: [], fileKeys: [], overview: '', chars: 0, excerpts: [] }

const SDK = resolve('node_modules/@modelcontextprotocol/sdk/dist/cjs/client')

/**
 * A stand-in for the claude program: records its arguments, stdin, working directory and environment, then prints what
 * the test asked for. `auth status` answers with `status`. With `lookup`, it first acts as Claude Code's MCP client: it
 * reads the --mcp-config file, tries the server without the token, then lists the tools and makes the call.
 */
function fakeClaude(reply: {
	stdout?: string
	stderr?: string
	code?: number
	status?: unknown
	lookup?: { name: string; arguments: Record<string, unknown> }
}): { command: string; seen(): any } {
	const dir = mkdtempSync(join(tmpdir(), 'review-claude-'))
	const log = join(dir, 'seen.json')
	const command = join(dir, 'claude')
	const script = join(dir, 'claude.cjs')
	// Through sh: a shebang can't hold a node path with spaces in it ("Application Support").
	writeFileSync(command, `#!/bin/sh\nexec '${process.execPath.replace(/'/g, `'\\''`)}' '${script}' "$@"\n`)
	writeFileSync(
		script,
		`const fs = require('node:fs')
const { Client } = require(${JSON.stringify(join(SDK, 'index.js'))})
const { StreamableHTTPClientTransport } = require(${JSON.stringify(join(SDK, 'streamableHttp.js'))})
const args = process.argv.slice(2)
const input = fs.readFileSync(0, 'utf8')
const seen = { args, input, cwd: process.cwd(), env: Object.keys(process.env) }
const r = ${JSON.stringify(reply)}
;(async () => {
	if (args[0] === 'auth') return process.stdout.write(JSON.stringify(r.status ?? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }))
	if (r.lookup) {
		const server = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.review
		seen.withoutToken = (await fetch(server.url, { method: 'POST', body: '{}' })).status
		const client = new Client({ name: 'fake', version: '1' })
		await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }))
		seen.tools = (await client.listTools()).tools.map((t) => t.name)
		seen.result = await client.callTool(r.lookup)
		seen.serverUrl = server.url
		await client.close()
	}
	if (r.stderr) process.stderr.write(r.stderr)
	process.stdout.write(r.stdout ?? '')
})().finally(() => {
	fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(seen))
	process.exit(r.code ?? 0) // now: idle keep-alive sockets would hold it open for seconds
})
`,
	)
	chmodSync(command, 0o755)
	return { command, seen: () => JSON.parse(readFileSync(log, 'utf8')) }
}

const success = (extra: Record<string, unknown>) =>
	JSON.stringify({
		type: 'result',
		subtype: 'success',
		is_error: false,
		result: '',
		usage: {
			input_tokens: 2,
			cache_read_input_tokens: 10,
			cache_creation_input_tokens: 100,
			output_tokens: 40,
			output_tokens_details: { thinking_tokens: 7 },
		},
		...extra,
	})

test('Claude Code reviews run claude -p with no tools, no user config and the prompt on stdin, outside the repository', async () => {
	const fake = fakeClaude({ stdout: success({ structured_output: { findings: [] } }) })
	const provider = createClaudeCodeProvider({ command: fake.command, timeoutMs: TIMEOUT, model: 'claude-opus-5-5', limits: LIMITS })
	const response = await provider.review({ instructions: 'Review it.', input: 'the diff', batch: BATCH }, new AbortController().signal)
	assert.deepEqual(response.output, { findings: [] })
	assert.deepEqual(response.usage, {
		inputTokens: 112,
		cachedInputTokens: 10,
		cacheWriteTokens: 100,
		outputTokens: 40,
		reasoningTokens: 7,
		totalTokens: 0,
	})
	const seen = fake.seen()
	assert.equal(seen.input, 'the diff')
	assert.equal(seen.cwd.startsWith(process.cwd()), false)
	const flag = (name: string) => seen.args[seen.args.indexOf(name) + 1]
	assert.equal(seen.args[0], '-p')
	assert.equal(flag('--model'), 'claude-opus-5-5')
	assert.equal(flag('--tools'), '')
	assert.equal(flag('--system-prompt'), 'Review it.')
	assert.equal(flag('--output-format'), 'json')
	assert.ok(JSON.parse(flag('--json-schema')).properties.findings)
	// No settings files: the user's hooks, plugins and CLAUDE.md stay out. (--safe-mode would also drop the lookups.)
	assert.equal(flag('--setting-sources'), '')
	assert.ok(!seen.args.includes('--safe-mode'))
	for (const f of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(seen.args.includes(f), f)
	assert.ok(!seen.args.includes('--mcp-config'), 'no lookups asked for, no server')
	// An API key in the app's environment would bill the key instead of the plan.
	assert.ok(!seen.env.some((k: string) => k.startsWith('ANTHROPIC_')))
})

test('Claude Code lookups: served over MCP for the request only, behind a token, through the request’s own tools', async () => {
	const fake = fakeClaude({
		stdout: success({ result: 'Here you go:\n```json\n{"findings":[]}\n```' }),
		lookup: { name: 'read_file', arguments: { path: 'src/a.ts' } },
	})
	const provider = createClaudeCodeProvider({ command: fake.command, timeoutMs: TIMEOUT, model: 'claude-sonnet-5-5', limits: LIMITS })
	const calls: Array<[string, unknown]> = []
	const tools: ReviewTools = {
		definitions: [
			{ name: 'read_file', description: 'Reads a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
		],
		async call(name, args) {
			calls.push([name, args])
			return { text: 'export const a = 1', error: false }
		},
		exhausted: () => false,
		log: { calls: 0, chars: 0, refused: 0, paths: [], searches: [], external: [], seen: [] },
	}
	const r = await provider.review({ instructions: 'x', input: 'y', batch: BATCH, tools }, new AbortController().signal)
	assert.deepEqual(r.output, { findings: [] }) // read from the text when structured_output is missing
	assert.equal(r.toolsRejected, undefined)
	const seen = fake.seen()
	assert.equal(seen.withoutToken, 401)
	assert.deepEqual(seen.tools, ['read_file'])
	assert.deepEqual(seen.result.content, [{ type: 'text', text: 'export const a = 1' }])
	assert.deepEqual(calls, [['read_file', { path: 'src/a.ts' }]])
	const flag = (name: string) => seen.args[seen.args.indexOf(name) + 1]
	assert.equal(flag('--allowedTools'), 'mcp__review__read_file')
	assert.ok(Number(flag('--max-turns')) > 1)
	// Gone once the request is answered: the config file with its token, and the server.
	assert.throws(() => readFileSync(flag('--mcp-config')))
	await assert.rejects(fetch(seen.serverUrl, { method: 'POST', body: '{}' }))
})

test('Claude Code doesn’t send images yet: the runner sends the request again without them and says so', async () => {
	const provider = createClaudeCodeProvider({ command: fakeClaude({}).command, timeoutMs: TIMEOUT, model: 'm', limits: LIMITS })
	await assert.rejects(
		provider.review(
			{ instructions: 'x', input: 'y', batch: BATCH, images: [{ name: 'a', mediaType: 'image/png', data: '' }] },
			new AbortController().signal,
		),
		(e: ProviderError) => e.kind === 'unsupported',
	)
})

test('Claude Code errors map to the kinds the runner acts on', async () => {
	const kind = (stdout: string, stderr = '', code: number | null = 1) => {
		try {
			interpretResult(stdout, stderr, code, 'claude-opus-5-5')
			return 'ok'
		} catch (e) {
			return (e as ProviderError).kind
		}
	}
	const failed = (result: string, status: number | null = null) =>
		JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result, api_error_status: status })
	assert.equal(kind(failed('Claude AI usage limit reached|1761152400')), 'quota')
	assert.equal(kind(failed('You’ve hit your limit · resets 6pm (Europe/Amsterdam)', 429)), 'quota')
	assert.equal(kind(failed('Rate limited', 429)), 'rate-limit')
	assert.equal(kind(failed('Invalid API key · Please run /login')), 'auth')
	assert.equal(kind(failed('Prompt is too long')), 'context-exceeded')
	assert.equal(kind(failed('Internal error', 500)), 'server')
	assert.equal(kind('', 'Error: model claude-nope not found'), 'model-unavailable')
	assert.equal(kind(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '' })), 'invalid-output')
	assert.equal(kind(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true })), 'incomplete')

	const missing = createClaudeCodeProvider({ command: '/nonexistent/claude', timeoutMs: TIMEOUT, model: 'm', limits: LIMITS })
	await assert.rejects(
		missing.review({ instructions: 'x', input: 'y', batch: BATCH }, new AbortController().signal),
		(e: ProviderError) => e.kind === 'unsupported' && /not found/.test(e.message),
	)
})

test('Test connection accepts Claude Code only when it is signed in with a Claude plan', async () => {
	const models = (status: unknown) =>
		createClaudeCodeAccount({ command: fakeClaude({ status }).command, timeoutMs: TIMEOUT }).listModels(new AbortController().signal)
	const listed = await models({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })
	assert.ok(listed.length > 0 && listed.every((m) => m.structuredOutput === 'yes'))
	await assert.rejects(models({ loggedIn: false }), (e: ProviderError) => e.kind === 'auth' && /not signed in/.test(e.message))
	await assert.rejects(models({ loggedIn: true, authMethod: 'api_key' }), /not a Claude plan/)
	await assert.rejects(models({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' }), /not a Claude plan/)
})

test('a Claude Code connection: a program not a URL, priced as the plan, never asked questions', async () => {
	assert.equal(normaliseCommand('', 'claude'), 'claude')
	assert.equal(normaliseCommand(' /opt/homebrew/bin/claude ', 'claude'), '/opt/homebrew/bin/claude')
	assert.throws(() => normaliseCommand('claude; rm -rf ~', 'claude'), /full path/)
	assert.throws(() => normaliseCommand('https://example.com', 'claude'), /full path/)

	const dir = mkdtempSync(join(tmpdir(), 'review-cc-'))
	const credentials = new CredentialService(dir, cipher)
	await credentials.load()
	const connections = new ConnectionService(dir, credentials, sdkAdapters, { showDevelopment: true })
	await connections.load()
	const fake = fakeClaude({})
	const cc = await connections.create({ kind: 'claude-code', baseUrl: fake.command })
	assert.equal(cc.baseUrl, fake.command)
	assert.equal(cc.credential, 'not-required')
	await connections.test(cc.id)
	const view = connections.view().connections.find((c) => c.id === cc.id)!
	assert.equal(view.status, 'connected')
	const opus = view.models.find((m) => m.id === 'claude-opus-5-5')!
	assert.equal(opus.price?.source, 'subscription')

	// Chosen for reviews, it is not the default for questions, and can't be picked for them.
	await connections.select({ connectionId: cc.id, modelId: opus.id })
	assert.deepEqual(connections.view().selection, { connectionId: cc.id, modelId: opus.id })
	assert.equal(connections.view().questionModel, null)
	await assert.rejects(connections.selectAskModel({ connectionId: cc.id, modelId: opus.id }), /reviews only/)

	// A model at another effort, added by hand: named and sized after the model it runs, usable in a team like any other.
	await connections.addModel(cc.id, 'claude-opus-5-5-max')
	const max = connections.view().connections[0].models.find((m) => m.id === 'claude-opus-5-5-max')!
	assert.equal(max.label, 'Claude Opus 5.5 · max')
	assert.equal(max.price?.source, 'subscription')
	assert.equal(connections.modelInfo({ connectionId: cc.id, modelId: max.id })?.limits.contextWindow, 1_000_000)
})

test('a Claude Code model named with an effort runs the model at that effort; other names run as they are', async () => {
	const args = async (model: string) => {
		const fake = fakeClaude({ stdout: success({ structured_output: { findings: [] } }) })
		const p = createClaudeCodeProvider({ command: fake.command, timeoutMs: TIMEOUT, model, limits: LIMITS })
		await p.review({ instructions: 'x', input: 'y', batch: BATCH }, new AbortController().signal)
		const a: Array<string> = fake.seen().args
		return { model: a[a.indexOf('--model') + 1], effort: a.includes('--effort') ? a[a.indexOf('--effort') + 1] : null }
	}
	assert.deepEqual(await args('claude-opus-5-5-max'), { model: 'claude-opus-5-5', effort: 'max' })
	assert.deepEqual(await args('claude-opus-5-5'), { model: 'claude-opus-5-5', effort: null })
	assert.deepEqual(await args('claude-opus-5-5-ultra'), { model: 'claude-opus-5-5-ultra', effort: null }, 'not a Claude Code level')
})

test('the plan’s usage limit is told apart from a brief rate limit, with when it resets', () => {
	const now = Date.UTC(2026, 9, 22, 12)
	const epoch = planLimit('Claude AI usage limit reached|' + (now / 1000 + 3600), now)!
	assert.equal(epoch.kind, 'quota')
	assert.equal(epoch.retryAfterMs, 3_600_000)
	assert.match(epoch.message, /usage limit is reached; it resets at \d{1,2}.\d\d( ?[AP]M)?\./i)
	assert.match(planLimit('You’ve hit your limit · resets 6pm (Europe/Amsterdam)')!.message, /it resets 6pm \(Europe\/Amsterdam\)\./)
	assert.match(planLimit('5-hour limit reached ∙ resets at 18:00')!.message, /it resets at 18:00\./)
	assert.match(planLimit('Out of usage credits')!.message, /usage limit is reached\. Requests/)
	assert.equal(planLimit('You’ve hit your limit · resets 6pm')!.retryAfterMs, null, 'a wall-clock time in words: the wait is not guessed')
	assert.equal(planLimit('Rate limited, please retry'), null)
	assert.equal(planLimit('API Error: 529 overloaded'), null)
})

test('every run on one Claude Code connection shares its gate: two at once, and a reached limit stops the others unsent', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'review-gate-'))
	const credentials = new CredentialService(dir, cipher)
	await credentials.load()
	const connections = new ConnectionService(dir, credentials, sdkAdapters, { showDevelopment: true })
	await connections.load()
	const runs = mkdtempSync(join(tmpdir(), 'review-gate-log-'))
	// Each request records when it starts and ends; with "quota" in the prompt it reports the plan's limit.
	const script = join(runs, 'claude.cjs')
	const command = join(runs, 'claude')
	writeFileSync(command, `#!/bin/sh\nexec '${process.execPath.replace(/'/g, `'\\''`)}' '${script}' "$@"\n`)
	writeFileSync(
		script,
		`const fs = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === 'auth') { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })); process.exit(0) }
const input = fs.readFileSync(0, 'utf8')
const log = ${JSON.stringify(join(runs, 'log'))}
fs.appendFileSync(log, 'start ' + Date.now() + '\\n')
setTimeout(() => {
	fs.appendFileSync(log, 'end ' + Date.now() + '\\n')
	const quota = input.includes('quota')
	process.stdout.write(JSON.stringify(quota
		? { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'You’ve hit your limit · resets 6pm (Europe/Amsterdam)' }
		: { type: 'result', subtype: 'success', is_error: false, structured_output: { findings: [] } }))
	process.exit(0)
}, 300)
`,
	)
	chmodSync(command, 0o755)
	const cc = await connections.create({ kind: 'claude-code', baseUrl: command })
	await connections.test(cc.id)
	// Two runs on different models of the one login: say, two team members.
	const a = (await connections.runConfig({ connectionId: cc.id, modelId: 'claude-opus-5-5' })).provider
	const b = (await connections.runConfig({ connectionId: cc.id, modelId: 'claude-sonnet-5-5' })).provider
	const signal = new AbortController().signal
	const ask = (p: typeof a, input = 'diff') => p.review({ instructions: 'x', input, batch: BATCH }, signal)
	await Promise.all([ask(a), ask(b), ask(a), ask(b)])
	const events = readFileSync(join(runs, 'log'), 'utf8')
		.trim()
		.split('\n')
		.map((l) => l.split(' '))
		.map(([k, t]) => ({ k, t: Number(t) }))
		.sort((x, y) => x.t - y.t)
	let open = 0
	let most = 0
	for (const e of events) most = Math.max(most, (open += e.k === 'start' ? 1 : -1))
	assert.equal(events.length, 8)
	assert.equal(most, 2)

	writeFileSync(join(runs, 'log'), '')
	await assert.rejects(ask(a, 'quota'), (e: ProviderError) => e.kind === 'quota' && /resets 6pm/.test(e.message))
	await assert.rejects(ask(b), (e: ProviderError) => e.kind === 'quota', 'the other member stops too')
	assert.equal(readFileSync(join(runs, 'log'), 'utf8').match(/start/g)?.length, 1, 'without starting Claude Code again')
	await connections.test(cc.id) // testing the connection again tries again
	assert.deepEqual((await ask(b)).output, { findings: [] })
})
