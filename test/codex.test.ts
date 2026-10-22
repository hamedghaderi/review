import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { sdkAdapters } from '../src/main/ai/adapters.ts'
import { cliVariant } from '../src/main/ai/catalog.ts'
import { ConnectionService } from '../src/main/ai/connections.ts'
import { CredentialService, type SecretCipher } from '../src/main/ai/credentials.ts'
import { createCodexAccount, createCodexProvider, interpretEvents, planLimit } from '../src/main/ai/codex.ts'
import type { ReviewTools } from '../src/main/ai/lookup.ts'
import { ProviderError } from '../src/main/ai/provider.ts'

const cipher: SecretCipher = {
	isAsyncEncryptionAvailable: async () => true,
	encryptStringAsync: async (s) => Buffer.from(s),
	decryptStringAsync: async (b) => ({ result: b.toString(), shouldReEncrypt: false }),
	getSelectedStorageBackend: () => 'keychain',
}
const LIMITS = { contextWindow: 272_000, maxOutputTokens: 128_000 }
const BATCH = { index: 0, references: [], facts: [], fileKeys: [], overview: '', chars: 0, excerpts: [] }
// Generous: on a busy machine a fake's exit has been seen to reach the app seconds late (see claudeCode.test.ts).
const TIMEOUT = 60_000
const SDK = resolve('node_modules/@modelcontextprotocol/sdk/dist/cjs/client')

const FEATURES = ['shell_tool', 'unified_exec', 'apps', 'browser_use', 'computer_use', 'multi_agent', 'plugins', 'hooks', 'code_mode_host']

/**
 * A stand-in for the codex program. `--version`, `features list` and `login status` answer from `reply`; `exec` records
 * its arguments, stdin, environment and the instruction and schema files it was given, then prints `events` as JSONL.
 * With `lookup`, it first calls Review's tool server the way Codex is configured to: the URL from -c, the token from the
 * variable it names.
 */
function fakeCodex(reply: {
	version?: string
	features?: Array<string>
	login?: string
	events?: Array<unknown>
	stderr?: string
	lookup?: { name: string; arguments: Record<string, unknown> }
}): { command: string; seen(): any } {
	const dir = mkdtempSync(join(tmpdir(), 'review-codex-'))
	const log = join(dir, 'seen.json')
	const command = join(dir, 'codex')
	const script = join(dir, 'codex.cjs')
	writeFileSync(command, `#!/bin/sh\nexec '${process.execPath.replace(/'/g, `'\\''`)}' '${script}' "$@"\n`)
	writeFileSync(
		script,
		`const fs = require('node:fs')
const { Client } = require(${JSON.stringify(join(SDK, 'index.js'))})
const { StreamableHTTPClientTransport } = require(${JSON.stringify(join(SDK, 'streamableHttp.js'))})
const args = process.argv.slice(2)
const r = ${JSON.stringify(reply)}
const out = (s) => process.stdout.write(s)
if (args[0] === '--version') { out('codex-cli ' + (r.version ?? '0.163.0') + '\\n'); process.exit(0) }
if (args[0] === 'features') { out((r.features ?? ${JSON.stringify(FEATURES)}).map((f) => f.padEnd(40) + 'stable  true').join('\\n') + '\\nold_thing   removed  false\\n'); process.exit(0) }
if (args[0] === 'login') { out(r.login ?? 'Logged in using ChatGPT\\n'); process.exit(0) }
const input = fs.readFileSync(0, 'utf8')
const config = Object.fromEntries(args.flatMap((a, i) => (args[i - 1] === '-c' ? [a.split(/=(.*)/s).slice(0, 2)] : [])))
const file = (p) => { try { return fs.readFileSync(JSON.parse(p), 'utf8') } catch { return fs.readFileSync(p, 'utf8') } }
const seen = { args, input, env: Object.keys(process.env), config, instructions: file(config.model_instructions_file), schema: file(args[args.indexOf('--output-schema') + 1]) }
;(async () => {
	if (r.lookup) {
		const url = JSON.parse(config['mcp_servers.review.url'])
		const token = process.env[JSON.parse(config['mcp_servers.review.bearer_token_env_var'])]
		seen.withoutToken = (await fetch(url, { method: 'POST', body: '{}' })).status
		const client = new Client({ name: 'fake', version: '1' })
		await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }))
		seen.result = await client.callTool(r.lookup)
		await client.close()
	}
	if (r.stderr) process.stderr.write(r.stderr)
	out((r.events ?? []).map((e) => JSON.stringify(e)).join('\\n') + '\\n')
})().finally(() => {
	fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(seen))
	process.exit(0)
})
`,
	)
	chmodSync(command, 0o755)
	return { command, seen: () => JSON.parse(readFileSync(log, 'utf8')) }
}

const answered = (text: string) => [
	{ type: 'thread.started', thread_id: 't' },
	// Codex reports settings it ignored as errors; they don't end the turn.
	{ type: 'error', message: 'Codex is ignoring 1 unrecognized configuration setting.' },
	{ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'Looking at the change first.' } },
	{ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text } },
	{ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 30, reasoning_output_tokens: 9 } },
]

test('a Codex model named with an effort runs the model at that reasoning effort', async () => {
	const fake = fakeCodex({ events: answered('{"findings":[]}') })
	const provider = createCodexProvider({ command: fake.command, timeoutMs: TIMEOUT, model: 'gpt-6-sol-xhigh', limits: LIMITS })
	await provider.review({ instructions: 'x', input: 'y', batch: BATCH }, new AbortController().signal)
	const seen = fake.seen()
	assert.equal(seen.args[seen.args.indexOf('--model') + 1], 'gpt-6-sol')
	assert.equal(seen.config.model_reasoning_effort, '"xhigh"')
	assert.equal(cliVariant('codex', 'gpt-6-luna').effort, null)
	assert.deepEqual(cliVariant('codex', 'gpt-6.1-sol-ultra'), { model: 'gpt-6.1-sol', effort: 'ultra' })
	assert.deepEqual(cliVariant('openai', 'gpt-6-sol-high'), { model: 'gpt-6-sol-high', effort: null }, 'API models are named as they are')
})

test('a Codex model can’t be added at an effort it doesn’t take, which Codex would silently replace', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'review-codex-conn-'))
	const credentials = new CredentialService(dir, cipher)
	await credentials.load()
	const connections = new ConnectionService(dir, credentials, sdkAdapters, { showDevelopment: true })
	await connections.load()
	const cx = await connections.create({ kind: 'codex', baseUrl: fakeCodex({}).command })
	await connections.addModel(cx.id, 'gpt-6-sol-ultra')
	const offered = connections.view().connections[0]
	assert.ok(!offered.models.some((m) => m.id === 'gpt-6-luna-ultra'), 'not offered either')
	assert.ok(offered.models.some((m) => m.id === 'gpt-6-sol-ultra'))
	await assert.rejects(connections.addModel(cx.id, 'gpt-6-luna-ultra'), /GPT-6 Luna doesn’t take the effort “ultra”/)
	await connections.addModel(cx.id, 'gpt-6-luna-max')
	assert.deepEqual(
		connections
			.view()
			.connections[0].models.filter((m) => m.source === 'manual')
			.map((m) => m.label),
		['GPT-6 Sol · ultra', 'GPT-6 Luna · max'],
	)
})

test('Codex reviews run codex exec isolated: no shell, user config, AGENTS.md or agents, instructions and schema from files', async () => {
	const fake = fakeCodex({ events: answered('{"findings":[]}') })
	const provider = createCodexProvider({ command: fake.command, timeoutMs: TIMEOUT, model: 'gpt-6-sol', limits: LIMITS })
	const r = await provider.review({ instructions: 'Review it.', input: 'the diff', batch: BATCH }, new AbortController().signal)
	assert.deepEqual(r.output, { findings: [] })
	assert.deepEqual(r.usage, { inputTokens: 120, cachedInputTokens: 80, outputTokens: 30, reasoningTokens: 9, totalTokens: 0 })
	const seen = fake.seen()
	assert.equal(seen.input, 'the diff')
	assert.equal(seen.instructions, 'Review it.')
	assert.ok(JSON.parse(seen.schema).properties.findings)
	assert.equal(seen.args[0], 'exec')
	assert.equal(seen.args[seen.args.indexOf('--model') + 1], 'gpt-6-sol')
	assert.equal(seen.args[seen.args.indexOf('--sandbox') + 1], 'read-only')
	for (const f of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--json']) assert.ok(seen.args.includes(f), f)
	assert.equal(seen.config.project_doc_max_bytes, '0')
	assert.equal(seen.config['agents.enabled'], 'false')
	// Every feature this version lists that could run, read or reach anything is off; code mode, its only way to tools, stays.
	const off = seen.args.flatMap((a: string, i: number) => (seen.args[i - 1] === '--disable' ? [a] : []))
	assert.deepEqual(off.sort(), FEATURES.filter((f) => f !== 'code_mode_host').sort())
	assert.ok(!seen.args.some((a: string) => a.includes('mcp_servers')), 'no lookups asked for, no server')
	assert.ok(!seen.env.some((k: string) => k.startsWith('OPENAI_')))
	// The instruction and schema files are gone once it has answered.
	assert.throws(() => readFileSync(JSON.parse(seen.config.model_instructions_file)))
})

test('Codex lookups: the request’s own tools over MCP, the token only in a variable Codex is told to read', async () => {
	const fake = fakeCodex({ events: answered('{"findings":[]}'), lookup: { name: 'read_file', arguments: { path: 'src/a.ts' } } })
	const provider = createCodexProvider({ command: fake.command, timeoutMs: TIMEOUT, model: 'gpt-6-sol', limits: LIMITS })
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
	await provider.review({ instructions: 'x', input: 'y', batch: BATCH, tools }, new AbortController().signal)
	const seen = fake.seen()
	assert.equal(seen.withoutToken, 401)
	assert.deepEqual(seen.result.content, [{ type: 'text', text: 'export const a = 1' }])
	assert.deepEqual(calls, [['read_file', { path: 'src/a.ts' }]])
	assert.equal(seen.config['mcp_servers.review.enabled_tools'], '["read_file"]')
	assert.equal(seen.config['mcp_servers.review.required'], 'true')
	assert.ok(seen.env.includes('REVIEW_MCP_TOKEN'))
	assert.ok(!seen.args.join(' ').match(/[0-9a-f]{64}/), 'the token is not on the command line')
})

test('Codex errors map to the kinds the runner acts on, from its JSON-wrapped API errors', () => {
	const failed = (message: string) => ({ stdout: JSON.stringify({ type: 'turn.failed', error: { message } }), stderr: '', code: 1 })
	const kind = (out: { stdout: string; stderr: string; code: number | null }) => {
		try {
			interpretEvents(out, 'gpt-6-sol')
			return 'ok'
		} catch (e) {
			return (e as ProviderError).kind
		}
	}
	const api = (status: number, message: string) => JSON.stringify({ type: 'error', status, error: { message } })
	assert.equal(
		kind(failed(api(400, "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account."))),
		'model-unavailable',
	)
	assert.equal(kind(failed(api(401, 'Unauthorized'))), 'auth')
	assert.equal(kind(failed("You've hit your usage limit. Upgrade to Pro, or try again at 6:05 PM.")), 'quota')
	assert.equal(kind(failed(api(429, 'Rate limit reached'))), 'rate-limit')
	assert.equal(kind(failed(api(400, 'Your input exceeds the context window of this model.'))), 'context-exceeded')
	assert.equal(kind({ stdout: '', stderr: 'Error: Unknown feature flag: shell_tool', code: 1 }), 'server')
	assert.equal(kind({ stdout: JSON.stringify({ type: 'turn.completed', usage: {} }), stderr: '', code: 0 }), 'invalid-output')

	assert.match(planLimit("You've hit your usage limit. Upgrade to Pro, or try again at 6:05 PM.")!.message, /try again at 6:05 PM\./)
	assert.match(planLimit('Your workspace is out of credits.')!.message, /usage limit is reached\. Requests/)
	assert.equal(planLimit('Rate limit reached for requests'), null)
})

test('Test connection needs a recent Codex that can switch its shell off, signed in with ChatGPT', async () => {
	const models = (reply: Parameters<typeof fakeCodex>[0]) =>
		createCodexAccount({ command: fakeCodex(reply).command, timeoutMs: TIMEOUT }).listModels(new AbortController().signal)
	const listed = await models({})
	assert.ok(listed.length > 0 && listed.every((m) => m.structuredOutput === 'yes'))
	await assert.rejects(
		models({ version: '0.131.0' }),
		(e: ProviderError) => e.kind === 'unsupported' && /too old.*0\.163\.0/.test(e.message),
	)
	await assert.rejects(models({ features: ['apps', 'hooks'] }), /switch off its shell/)
	await assert.rejects(models({ login: 'Logged in using an API key - sk-…\n' }), /not a ChatGPT plan/)
	await assert.rejects(models({ login: 'Not logged in\n' }), (e: ProviderError) => e.kind === 'auth' && /codex login/.test(e.message))
})
