import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { sdkAdapters } from '../src/main/ai/adapters.ts'
import { createClaudeCodeAccount, createClaudeCodeProvider, interpretResult } from '../src/main/ai/claudeCode.ts'
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
const BATCH = { index: 0, references: [], facts: [], fileKeys: [], overview: '', chars: 0, excerpts: [] }

/**
 * A stand-in for the claude program: records its arguments, stdin, working directory and environment, then prints what
 * the test asked for. `auth status` answers with `status`.
 */
function fakeClaude(reply: { stdout?: string; stderr?: string; code?: number; status?: unknown }): { command: string; seen(): any } {
	const dir = mkdtempSync(join(tmpdir(), 'review-claude-'))
	const log = join(dir, 'seen.json')
	const command = join(dir, 'claude')
	const script = join(dir, 'claude.cjs')
	// Through sh: a shebang can't hold a node path with spaces in it ("Application Support").
	writeFileSync(command, `#!/bin/sh\nexec '${process.execPath.replace(/'/g, `'\\''`)}' '${script}' "$@"\n`)
	writeFileSync(
		script,
		`const fs = require('node:fs')
const args = process.argv.slice(2)
const input = fs.readFileSync(0, 'utf8')
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input, cwd: process.cwd(), env: Object.keys(process.env) }))
const r = ${JSON.stringify(reply)}
if (args[0] === 'auth') { process.stdout.write(JSON.stringify(r.status ?? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })); process.exit(0) }
if (r.stderr) process.stderr.write(r.stderr)
process.stdout.write(r.stdout ?? '')
process.exit(r.code ?? 0)
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
	const provider = createClaudeCodeProvider({ command: fake.command, timeoutMs: 10_000, model: 'claude-opus-5-5', limits: LIMITS })
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
	for (const f of ['--strict-mcp-config', '--safe-mode', '--disable-slash-commands', '--no-session-persistence'])
		assert.ok(seen.args.includes(f), f)
	// An API key in the app's environment would bill the key instead of the plan.
	assert.ok(!seen.env.some((k: string) => k.startsWith('ANTHROPIC_')))
})

test('Claude Code: lookups and images are declined, so the runner continues without them and says so', async () => {
	const fake = fakeClaude({ stdout: success({ result: 'Here you go:\n```json\n{"findings":[]}\n```' }) })
	const provider = createClaudeCodeProvider({ command: fake.command, timeoutMs: 10_000, model: 'claude-sonnet-5-5', limits: LIMITS })
	const tools = {} as ReviewTools // only offered; never called
	const r = await provider.review({ instructions: 'x', input: 'y', batch: BATCH, tools }, new AbortController().signal)
	assert.deepEqual(r.output, { findings: [] }) // read from the text when structured_output is missing
	assert.match(r.toolsRejected ?? '', /lookups/)
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
	assert.equal(kind(failed('Claude AI usage limit reached|1761152400')), 'rate-limit')
	assert.equal(kind(failed('Rate limited', 429)), 'rate-limit')
	assert.equal(kind(failed('Invalid API key · Please run /login')), 'auth')
	assert.equal(kind(failed('Prompt is too long')), 'context-exceeded')
	assert.equal(kind(failed('Internal error', 500)), 'server')
	assert.equal(kind('', 'Error: model claude-nope not found'), 'model-unavailable')
	assert.equal(kind(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '' })), 'invalid-output')

	const missing = createClaudeCodeProvider({ command: '/nonexistent/claude', timeoutMs: 10_000, model: 'm', limits: LIMITS })
	await assert.rejects(
		missing.review({ instructions: 'x', input: 'y', batch: BATCH }, new AbortController().signal),
		(e: ProviderError) => e.kind === 'unsupported' && /not found/.test(e.message),
	)
})

test('Test connection accepts Claude Code only when it is signed in with a Claude plan', async () => {
	const models = (status: unknown) =>
		createClaudeCodeAccount({ command: fakeClaude({ status }).command, timeoutMs: 10_000 }).listModels(new AbortController().signal)
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
})
