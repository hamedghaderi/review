import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { sdkAdapters, type AdapterFactory } from '../src/main/ai/adapters.ts'
import { ConnectionService, normaliseUrl } from '../src/main/ai/connections.ts'
import { AiController } from '../src/main/ai/controller.ts'
import { CredentialService, type SecretCipher } from '../src/main/ai/credentials.ts'
import { createFakeProvider, emptyEvaluation } from '../src/main/ai/fake.ts'
import { ProviderError } from '../src/main/ai/provider.ts'
import { REVIEW_JSON_SCHEMA } from '../src/main/ai/schema.ts'
import { ReviewStore } from '../src/main/store.ts'
import { apiKey } from '../src/main/validate.ts'
import type { AiRun, ChangedFile, Comparison, FileLinesResult, PatchResult, Review } from '../src/shared/types.ts'

// A reversible fake of Electron's safeStorage: marks ciphertext so tests can prove nothing is stored in plaintext.
function cipher(options: { available?: boolean; backend?: string } = {}): SecretCipher {
	return {
		async isAsyncEncryptionAvailable() {
			return options.available ?? true
		},
		async encryptStringAsync(plain) {
			return Buffer.from(`ENC:${Buffer.from(plain).toString('hex')}`)
		},
		async decryptStringAsync(buf) {
			const s = buf.toString()
			if (!s.startsWith('ENC:')) throw new Error('bad ciphertext')
			return { result: Buffer.from(s.slice(4), 'hex').toString(), shouldReEncrypt: false }
		},
		getSelectedStorageBackend: () => options.backend ?? 'keychain',
	}
}

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'review-prov-'))
}

async function services(dir = tmp(), adapters: AdapterFactory = sdkAdapters, c = cipher()) {
	const credentials = new CredentialService(dir, c)
	await credentials.load()
	const connections = new ConnectionService(dir, credentials, adapters, { showDevelopment: true })
	await connections.load()
	return { dir, credentials, connections }
}

// Mock HTTP server that speaks enough of each provider protocol and records every request.
interface Seen {
	method: string
	path: string
	headers: http.IncomingHttpHeaders
	body: Record<string, unknown> | null
}

type Handler = (req: Seen) => { status?: number; body: unknown } | undefined

async function mockServer(handler: Handler = () => undefined) {
	const seen: Array<Seen> = []
	const server = http.createServer((req, res) => {
		let raw = ''
		req.on('data', (c) => (raw += c))
		req.on('end', () => {
			const entry: Seen = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null }
			seen.push(entry)
			const custom = handler(entry)
			const { status, body } = custom ?? defaultResponse(entry)
			res.statusCode = status ?? 200
			res.setHeader('content-type', 'application/json')
			res.end(JSON.stringify(body))
		})
	})
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
	return { seen, base, close: () => new Promise<void>((r) => server.close(() => r())) }
}

const EMPTY_OUTPUT = { findings: [], evaluation: emptyEvaluation(), unexplained_files: [], limitations: [] }
const EMPTY = JSON.stringify(EMPTY_OUTPUT)

function defaultResponse(r: Seen): { status?: number; body: unknown } {
	const p = r.path
	if (p.includes('/responses'))
		return {
			body: {
				id: 'r',
				object: 'response',
				status: 'completed',
				output: [{ type: 'message', content: [{ type: 'output_text', text: EMPTY }] }],
				usage: { input_tokens: 5000, output_tokens: 20, total_tokens: 5020 },
			},
		}
	if (p.includes('/chat/completions'))
		return {
			body: {
				id: 'c',
				choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: EMPTY } }],
				usage: { prompt_tokens: 5000, completion_tokens: 20, total_tokens: 5020 },
			},
		}
	if (p.includes('/v1/messages'))
		return {
			body: {
				id: 'm',
				type: 'message',
				role: 'assistant',
				model: 'x',
				stop_reason: 'end_turn',
				content: [{ type: 'text', text: EMPTY }],
				usage: { input_tokens: 5000, output_tokens: 20 },
			},
		}
	if (p.includes(':generateContent'))
		return {
			body: {
				candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: EMPTY }] } }],
				usageMetadata: { promptTokenCount: 5000, candidatesTokenCount: 20, totalTokenCount: 5020 },
			},
		}
	if (p.startsWith('/v1beta/models'))
		return {
			body: {
				models: [
					{
						name: 'models/gem-a',
						displayName: 'Gem A',
						inputTokenLimit: 100000,
						outputTokenLimit: 8000,
						supportedGenerationMethods: ['generateContent'],
					},
					{ name: 'models/embed', supportedGenerationMethods: ['embedContent'] },
				],
			},
		}
	if (p.startsWith('/v1/models') && r.headers['x-api-key'])
		return {
			body: {
				data: [
					{
						id: 'claude-a',
						type: 'model',
						display_name: 'Claude A',
						created_at: '2026-01-01',
						max_input_tokens: 200000,
						max_tokens: 64000,
						capabilities: { structured_outputs: { supported: true } },
					},
					{
						id: 'claude-old',
						type: 'model',
						display_name: 'Old',
						created_at: '2024-01-01',
						max_input_tokens: 100000,
						max_tokens: 4096,
						capabilities: { structured_outputs: { supported: false } },
					},
				],
				has_more: false,
				first_id: null,
				last_id: null,
			},
		}
	if (p.startsWith('/api/v1/key')) return { body: { data: { label: 'k' } } }
	if (p.startsWith('/api/v1/models'))
		return {
			body: { data: [{ id: 'vendor/model-a', name: 'Model A', context_length: 64000, top_provider: { max_completion_tokens: 8000 } }] },
		}
	if (p.endsWith('/models'))
		return {
			body: {
				object: 'list',
				data: [
					{ id: 'local-a', object: 'model' },
					{ id: 'local-b', object: 'model' },
				],
			},
		}
	return { status: 404, body: { error: { message: 'not found' } } }
}

/** Points each hosted provider at the mock server instead of the real endpoint. */
function redirectTo(base: string): AdapterFactory {
	const map = (c: Parameters<AdapterFactory['account']>[0]) => {
		const u = new URL(c.baseUrl)
		if (u.hostname === '127.0.0.1') return c
		const path = c.kind === 'openrouter' ? '/api/v1' : c.protocol === 'openai-responses' ? '/v1' : ''
		return { ...c, baseUrl: base + path }
	}
	return { account: (c) => sdkAdapters.account(map(c)), provider: (c, m, l) => sdkAdapters.provider(map(c), m, l) }
}

// ─── Credentials ───────────────────────────────────────────────────────────

test('credentials are encrypted on disk, separate from settings, bound to the endpoint, and removable', async () => {
	const { dir, credentials } = await services()
	assert.equal(await credentials.save('c1', 'sk-secret-123456', 'openai-chat https://a', true), 'saved')
	const onDisk = readFileSync(join(dir, 'ai-credentials.json'), 'utf8')
	assert.ok(!onDisk.includes('sk-secret-123456'), 'no plaintext on disk')
	assert.deepEqual(await credentials.read('c1', 'openai-chat https://a'), { state: 'saved', secret: 'sk-secret-123456' })
	assert.deepEqual(await credentials.read('c1', 'openai-chat https://b'), { state: 'endpoint-changed' })
	await credentials.remove('c1')
	assert.deepEqual(await credentials.read('c1', 'openai-chat https://a'), { state: 'none' })
	assert.ok(!readFileSync(join(dir, 'ai-credentials.json'), 'utf8').includes('c1'))
})

test('without secure storage (incl. Linux basic_text) keys are session-only and never written', async () => {
	const unavailable = await services(tmp(), sdkAdapters, cipher({ available: false }))
	assert.equal(unavailable.credentials.storageInfo().secure, false)
	await assert.rejects(unavailable.credentials.save('c1', 'sk-secret-123456', 'e', true), /not available/)
	assert.equal(await unavailable.credentials.save('c1', 'sk-secret-123456', 'e', false), 'session')
	assert.equal((await unavailable.credentials.read('c1', 'e')).state, 'session')
	const files = readdirSync(unavailable.dir)
		.map((f) => readFileSync(join(unavailable.dir, f), 'utf8'))
		.join('')
	assert.ok(!files.includes('sk-secret-123456'))
	// Session keys are gone after a restart.
	const again = await services(unavailable.dir, sdkAdapters, cipher({ available: false }))
	assert.equal((await again.credentials.read('c1', 'e')).state, 'none')

	const saved = process.platform
	Object.defineProperty(process, 'platform', { value: 'linux' })
	try {
		const basic = await services(tmp(), sdkAdapters, cipher({ backend: 'basic_text' }))
		assert.equal(basic.credentials.storageInfo().secure, false)
		assert.match(basic.credentials.storageInfo().message ?? '', /basic_text/)
		await assert.rejects(basic.credentials.save('c1', 'sk-secret-123456', 'e', true))
	} finally {
		Object.defineProperty(process, 'platform', { value: saved })
	}
})

test('API key input validation and endpoint URL rules', () => {
	assert.throws(() => apiKey('short'))
	assert.throws(() => apiKey('sk-abc def ghi'))
	assert.throws(() => apiKey('sk-abc\ndefghijk'))
	assert.equal(apiKey('  sk-abcdefghijk  '), 'sk-abcdefghijk')
	assert.equal(normaliseUrl('http://localhost:11434/v1/'), 'http://localhost:11434/v1')
	assert.equal(normaliseUrl('http://192.168.1.20:1234/v1'), 'http://192.168.1.20:1234/v1')
	assert.throws(() => normaliseUrl('http://example.com/v1'), /https/)
	assert.throws(() => normaliseUrl('https://user:pw@example.com/v1'), /API key field/)
	assert.throws(() => normaliseUrl('file:///etc/passwd'), /http or https/)
	assert.throws(() => normaliseUrl('https://example.com/v1?key=x'), /query/)
})

// ─── Connection lifecycle ──────────────────────────────────────────────────

test('status states: saving a key is not verification; test results decide Connected / Connection failed', async () => {
	const mock = await mockServer((r) =>
		r.headers.authorization === 'Bearer sk-bad-key-000'
			? { status: 401, body: { error: { message: 'Incorrect API key provided: sk-bad-key-000' } } }
			: undefined,
	)
	try {
		const { connections } = await services(tmp(), redirectTo(mock.base))
		const c = await connections.create({ kind: 'openai' })
		assert.equal(c.status, 'not-connected')
		assert.equal(c.credential, 'none')
		// Catalog models are offered but labelled as catalog before verification.
		assert.ok(c.models.length > 0 && c.models.every((m) => m.source === 'catalog'))

		await connections.setCredential(c.id, 'sk-bad-key-000', true)
		let v = connections.view().connections[0]
		assert.equal(v.credential, 'saved')
		assert.equal(v.status, 'not-connected')
		assert.match(v.statusDetail ?? '', /does not verify/)

		await connections.test(c.id)
		v = connections.view().connections[0]
		assert.equal(v.status, 'failed')
		assert.match(v.statusDetail ?? '', /rejected the API key/)
		assert.ok(!JSON.stringify(connections.view()).includes('sk-bad-key-000'), 'the key never appears in the settings view')

		await connections.setCredential(c.id, 'sk-good-key-111', true)
		assert.equal(connections.view().connections[0].status, 'not-connected', 'a new key resets the previous test result')
		await connections.test(c.id)
		v = connections.view().connections[0]
		assert.equal(v.status, 'connected')
		assert.deepEqual(
			v.models.map((m) => [m.id, m.source]),
			[
				['local-a', 'discovered'],
				['local-b', 'discovered'],
			],
			'after discovery, only models the account lists are offered',
		)
		// The test never ran inference.
		assert.ok(mock.seen.every((r) => r.method === 'GET'))
	} finally {
		await mock.close()
	}
})

test('local connections need no key and send no Authorization header', async () => {
	const mock = await mockServer()
	try {
		const { connections } = await services()
		const c = await connections.create({ kind: 'custom', preset: 'ollama', baseUrl: `${mock.base}/v1` })
		assert.equal(c.auth, 'none')
		assert.equal(c.credential, 'not-required')
		assert.equal(c.contextWindow, 8192)
		await connections.test(c.id)
		const v = connections.view().connections[0]
		assert.equal(v.status, 'connected')
		assert.deepEqual(
			v.models.map((m) => m.id),
			['local-a', 'local-b'],
		)
		await connections.select({ connectionId: c.id, modelId: 'local-a' })
		const cfg = await connections.runConfig({ connectionId: c.id, modelId: 'local-a' })
		assert.equal(cfg.provider.protocol, 'openai-chat')
		assert.equal(cfg.provider.limits.contextWindow, 8192, 'user-set context window is used for batching')
		await cfg.provider.review(
			{ instructions: 'SYS', input: 'x'.repeat(100), batch: { index: 0, excerpts: [], fileKeys: [], overview: '', chars: 100 } },
			new AbortController().signal,
		)
		assert.ok(mock.seen.every((r) => r.headers.authorization === undefined))
		const chat = mock.seen.find((r) => r.path.endsWith('/chat/completions'))!
		assert.equal((chat.body as { model: string }).model, 'local-a')
	} finally {
		await mock.close()
	}
})

test('changing a custom endpoint drops the saved key and requires reconnecting', async () => {
	const mock = await mockServer()
	try {
		const { connections, credentials } = await services()
		const c = await connections.create({ kind: 'custom', preset: 'generic', baseUrl: `${mock.base}/v1`, auth: 'api-key' })
		await connections.setCredential(c.id, 'sk-custom-key-1', true)
		await connections.test(c.id)
		assert.equal(connections.view().connections[0].status, 'connected')
		let cancelled = 0
		connections.onRemoved(() => cancelled++)
		await connections.update(c.id, { baseUrl: `${mock.base}/v2` })
		const v = connections.view().connections[0]
		assert.equal(v.credential, 'none')
		assert.equal(v.status, 'not-connected')
		assert.equal(v.lastTest, null)
		assert.equal(cancelled, 1, 'runs on the old endpoint are cancelled')
		assert.equal((await credentials.read(c.id, `openai-chat ${mock.base}/v1`)).state, 'none', 'old credential removed')
		// Renaming alone keeps the credential.
		await connections.setCredential(c.id, 'sk-custom-key-2', true)
		await connections.update(c.id, { label: 'Renamed' })
		assert.equal(connections.view().connections[0].credential, 'saved')
	} finally {
		await mock.close()
	}
})

test('multiple providers: each routes through its own adapter, protocol and credential', async () => {
	const mock = await mockServer()
	try {
		const { connections } = await services(tmp(), redirectTo(mock.base))
		const keys = {
			openai: 'sk-openai-aaaa',
			anthropic: 'sk-ant-bbbbbbbb',
			gemini: 'AIzaCCCCCCCCCCCC',
			openrouter: 'sk-or-dddddddd',
		} as const
		const ids: Record<string, string> = {}
		for (const kind of Object.keys(keys) as Array<keyof typeof keys>) {
			const c = await connections.create({ kind })
			ids[kind] = c.id
			await connections.setCredential(c.id, keys[kind], true)
			await connections.test(c.id)
			assert.equal(connections.view().connections.find((x) => x.id === c.id)!.status, 'connected', kind)
		}
		const view = connections.view()
		assert.deepEqual(
			view.connections.find((c) => c.kind === 'anthropic')!.models.map((m) => m.id),
			['claude-a'],
			'models without structured output are hidden',
		)
		assert.deepEqual(
			view.connections.find((c) => c.kind === 'gemini')!.models.map((m) => m.id),
			['gem-a'],
		)

		const batch = { index: 0, excerpts: [], fileKeys: [], overview: '', chars: 0 }
		const models = { openai: 'local-a', anthropic: 'claude-a', gemini: 'gem-a', openrouter: 'vendor/model-a' }
		for (const kind of Object.keys(keys) as Array<keyof typeof keys>) {
			mock.seen.length = 0
			const cfg = await connections.runConfig({ connectionId: ids[kind], modelId: models[kind] })
			const r = await cfg.provider.review({ instructions: 'SYS', input: 'IN', batch }, new AbortController().signal)
			assert.deepEqual(r.output, EMPTY_OUTPUT)
			const req = mock.seen[0]
			const sentKeys = [req.headers.authorization, req.headers['x-api-key'], req.headers['x-goog-api-key']].filter(Boolean).join(' ')
			for (const [other, k] of Object.entries(keys)) {
				if (other === kind) assert.ok(sentKeys.includes(k), `${kind} sends its own key`)
				else assert.ok(!sentKeys.includes(k), `${kind} does not send ${other}'s key`)
			}
			const body = req.body as Record<string, any>
			if (kind === 'openai') {
				assert.equal(req.path, '/v1/responses')
				assert.equal(body.text.format.type, 'json_schema')
				assert.equal(body.text.format.strict, true)
				assert.equal(body.store, false)
			} else if (kind === 'openrouter') {
				assert.equal(req.path, '/api/v1/chat/completions')
				assert.equal(body.response_format.type, 'json_schema')
				assert.deepEqual(body.provider, { require_parameters: true })
			} else if (kind === 'anthropic') {
				assert.equal(req.path, '/v1/messages')
				assert.equal(body.output_config.format.type, 'json_schema')
				assert.equal(body.system, 'SYS')
			} else {
				assert.equal(req.path, `/v1beta/models/${models.gemini}:generateContent`)
				assert.equal(body.generationConfig.responseMimeType, 'application/json')
				assert.ok(body.generationConfig.responseJsonSchema)
			}
		}
	} finally {
		await mock.close()
	}
})

test('portable JSON schema: no $schema or numeric bounds, every object strict', () => {
	const text = JSON.stringify(REVIEW_JSON_SCHEMA)
	assert.ok(!text.includes('$schema'))
	assert.ok(!/"(minimum|maximum)"/.test(text))
	function walk(n: any): void {
		if (!n || typeof n !== 'object') return
		if (n.type === 'object') {
			assert.equal(n.additionalProperties, false)
			assert.deepEqual([...n.required].sort(), Object.keys(n.properties).sort())
		}
		Object.values(n).forEach(walk)
	}
	walk(REVIEW_JSON_SCHEMA)
})

test('SDK clients ignore ambient provider environment variables', async () => {
	const mock = await mockServer()
	const saved = { ...process.env }
	Object.assign(process.env, {
		OPENAI_API_KEY: 'ENV-LEAK-1',
		OPENAI_BASE_URL: 'http://leak.invalid',
		OPENAI_ORG_ID: 'org-leak',
		ANTHROPIC_API_KEY: 'ENV-LEAK-2',
		ANTHROPIC_AUTH_TOKEN: 'ENV-LEAK-3',
		ANTHROPIC_BASE_URL: 'http://leak.invalid',
		GEMINI_API_KEY: 'ENV-LEAK-4',
		GOOGLE_API_KEY: 'ENV-LEAK-5',
		GOOGLE_GENAI_USE_VERTEXAI: 'true',
		GOOGLE_GEMINI_BASE_URL: 'http://leak.invalid',
	})
	try {
		const limits = { contextWindow: 100000, maxOutputTokens: 4000 }
		const batch = { index: 0, excerpts: [], fileKeys: [], overview: '', chars: 0 }
		for (const [protocol, path, apiKey] of [
			['openai-responses', '/v1', 'sk-app-key-1'],
			['openai-chat', '/v1', null],
			['anthropic-messages', '', 'sk-app-key-2'],
			['gemini-generate', '', 'AIza-app-key-3'],
		] as const) {
			const p = sdkAdapters.provider(
				{ kind: 'custom', label: 'x', protocol, baseUrl: mock.base + path, apiKey, timeoutMs: 5000 },
				'm',
				limits,
			)
			await p.review({ instructions: 'S', input: 'I', batch }, new AbortController().signal)
		}
		const all = JSON.stringify(mock.seen.map((s) => s.headers))
		assert.ok(!all.includes('ENV-LEAK') && !all.includes('org-leak'), 'no environment credential was sent')
		assert.equal(mock.seen.length, 4, 'no request went to the environment base URL')
	} finally {
		process.env = saved
		await mock.close()
	}
})

test('unavailable models, context overflow and malformed output map to explicit errors', async () => {
	const mock = await mockServer((r) => {
		const model = (r.body as { model?: string } | null)?.model
		if (model === 'gone') return { status: 404, body: { error: { message: 'The model `gone` does not exist' } } }
		if (model === 'big') return { status: 400, body: { error: { message: "This model's maximum context length is 8192 tokens" } } }
		if (model === 'garbage')
			return {
				body: {
					id: 'c',
					choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Sure! Here are the findings: none' } }],
				},
			}
		if (model === 'noschema' && (r.body as any)?.response_format?.type === 'json_schema')
			return { status: 400, body: { error: { message: 'response_format json_schema is not supported' } } }
		if (model === 'noschema')
			return {
				body: {
					id: 'c',
					choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '```json\n' + EMPTY + '\n```' } }],
				},
			}
		return undefined
	})
	try {
		const limits = { contextWindow: 100000, maxOutputTokens: 4000 }
		const batch = { index: 0, excerpts: [], fileKeys: [], overview: '', chars: 0 }
		const conn = {
			kind: 'custom' as const,
			label: 'Local',
			protocol: 'openai-chat' as const,
			baseUrl: `${mock.base}/v1`,
			apiKey: null,
			timeoutMs: 5000,
		}
		const review = (model: string) =>
			sdkAdapters.provider(conn, model, limits).review({ instructions: 'S', input: 'I', batch }, new AbortController().signal)
		await assert.rejects(review('gone'), (e: ProviderError) => e.kind === 'model-unavailable' && e.fatal && /gone/.test(e.message))
		await assert.rejects(review('big'), (e: ProviderError) => e.kind === 'context-exceeded')
		await assert.rejects(review('garbage'), (e: ProviderError) => e.kind === 'invalid-output')
		const fallback = await review('noschema')
		assert.equal(fallback.jsonFallback, true)
		assert.deepEqual(fallback.output, EMPTY_OUTPUT)
		// OpenAI's Responses endpoint never falls back.
		const responsesConn = { ...conn, protocol: 'openai-responses' as const }
		await assert.rejects(
			sdkAdapters.provider(responsesConn, 'gone', limits).review({ instructions: 'S', input: 'I', batch }, new AbortController().signal),
			(e: ProviderError) => e.kind === 'model-unavailable',
		)
	} finally {
		await mock.close()
	}
})

test('model probe is explicit, synthetic and records the result on the model', async () => {
	const mock = await mockServer()
	try {
		const { connections } = await services()
		const c = await connections.create({ kind: 'custom', preset: 'lmstudio', baseUrl: `${mock.base}/v1` })
		await connections.test(c.id)
		const before = mock.seen.filter((r) => r.method === 'POST').length
		assert.equal(before, 0, 'testing the connection sends no inference')
		await connections.probeModel(c.id, 'local-a')
		const posts = mock.seen.filter((r) => r.method === 'POST')
		assert.equal(posts.length, 1)
		assert.match(JSON.stringify(posts[0].body), /synthetic request/)
		const m = connections.view().connections[0].models.find((x) => x.id === 'local-a')!
		assert.equal(m.probe?.ok, true)
	} finally {
		await mock.close()
	}
})

test('saved connections, credentials and model preference survive a restart', async () => {
	const mock = await mockServer()
	try {
		const first = await services(tmp(), redirectTo(mock.base))
		const oa = await first.connections.create({ kind: 'openai' })
		await first.connections.setCredential(oa.id, 'sk-restart-key-1', true)
		await first.connections.test(oa.id)
		const local = await first.connections.create({ kind: 'custom', preset: 'ollama', baseUrl: `${mock.base}/v1` })
		await first.connections.test(local.id)
		await first.connections.select({ connectionId: local.id, modelId: 'local-b' })
		await first.connections.flush()

		const settingsFile = readFileSync(join(first.dir, 'ai-settings.json'), 'utf8')
		assert.ok(!settingsFile.includes('sk-restart-key-1'), 'settings file has no secrets')
		assert.ok(!readFileSync(join(first.dir, 'ai-credentials.json'), 'utf8').includes('sk-restart-key-1'), 'credential file is encrypted')

		const second = await services(first.dir, redirectTo(mock.base))
		const v = second.connections.view()
		assert.deepEqual(v.selection, { connectionId: local.id, modelId: 'local-b' })
		assert.equal(v.connections.length, 2)
		assert.equal(v.connections.find((c) => c.id === oa.id)!.status, 'connected')
		assert.equal(v.connections.find((c) => c.id === oa.id)!.credential, 'saved')
		const cfg = await second.connections.runConfig({ connectionId: oa.id, modelId: 'local-a' })
		mock.seen.length = 0
		await cfg.provider.review(
			{ instructions: 'S', input: 'I', batch: { index: 0, excerpts: [], fileKeys: [], overview: '', chars: 0 } },
			new AbortController().signal,
		)
		assert.equal(mock.seen[0].headers.authorization, 'Bearer sk-restart-key-1', 'decrypted key is used after restart')

		// Disconnecting removes the key and the selection.
		await second.connections.remove(local.id)
		await second.connections.remove(oa.id)
		assert.equal(second.connections.view().selection, null)
		assert.ok(!readFileSync(join(first.dir, 'ai-credentials.json'), 'utf8').includes(oa.id))
	} finally {
		await mock.close()
	}
})

test('a remembered selection that is no longer offered is reported, not silently replaced', async () => {
	const { connections } = await services()
	const f = await connections.create({ kind: 'fixture' })
	await connections.select({ connectionId: f.id, modelId: 'fixture-v1' })
	await connections.addModel(f.id, 'manual-one')
	await connections.select({ connectionId: f.id, modelId: 'manual-one' })
	await connections.removeModel(f.id, 'manual-one')
	const v = connections.view()
	assert.equal(v.selection, null)
	await assert.rejects(connections.runConfig({ connectionId: f.id, modelId: 'manual-one' }), /not offered/)
	await assert.rejects(connections.select({ connectionId: f.id, modelId: 'nope' }), /not offered/)
})

// ─── Runs with connections ─────────────────────────────────────────────────

const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)

function fixtureComparison(lines: number): { comparison: Comparison; patch: PatchResult; fileLines: FileLinesResult } {
	const file: ChangedFile = {
		key: 'a.ts',
		status: 'modified',
		oldPath: 'a.ts',
		newPath: 'a.ts',
		additions: lines,
		deletions: 0,
		binary: false,
		similarity: null,
	}
	const text = Array.from({ length: lines }, (_, i) => `const value${i} = compute(${i}) // ${'x'.repeat(40)}`)
	return {
		comparison: {
			id: `${BASE}..${HEAD}`,
			repoId: '/repo',
			baseRef: 'main',
			baseTipSha: BASE,
			baseSha: BASE,
			headSha: HEAD,
			headRef: 'f',
			target: null,
			pr: null,
			files: [file],
		},
		patch: {
			kind: 'text',
			bytes: 1,
			hunks: [
				{
					oldStart: 0,
					oldCount: 0,
					newStart: 1,
					newCount: lines,
					section: '',
					lines: text.map((t, i) => ({ kind: 'add' as const, oldNo: null, newNo: i + 1, text: t })),
				},
			],
		},
		fileLines: { kind: 'text', lines: text },
	}
}

function reviewFor(c: Comparison): Review {
	const t = new Date().toISOString()
	return {
		id: c.id,
		repoId: c.repoId,
		baseRef: c.baseRef,
		baseTipSha: BASE,
		baseSha: BASE,
		headSha: HEAD,
		headRef: 'f',
		createdAt: t,
		updatedAt: t,
		comments: [],
		drafts: [],
		viewed: [],
		findingDecisions: {},
	}
}

async function reviewSetup(lines = 20) {
	const dir = tmp()
	const fx = fixtureComparison(lines)
	const store = ReviewStore.in(dir)
	await store.load()
	await store.update((d) => {
		d.repos['/repo'] = {
			repoId: '/repo',
			root: '/repo',
			selectedBase: null,
			activeReviewId: fx.comparison.id,
			reviews: { [fx.comparison.id]: reviewFor(fx.comparison) },
			aiRuns: {},
		}
	})
	const access = { comparison: fx.comparison, loadPatch: async () => fx.patch, loadFileLines: async () => fx.fileLines }
	return { dir, store, access, comparison: fx.comparison }
}

test('run provenance is recorded without secrets and stays readable after disconnecting', async () => {
	const mock = await mockServer()
	try {
		const { dir, store, access, comparison } = await reviewSetup()
		const { connections } = await services(dir, redirectTo(mock.base))
		const oa = await connections.create({ kind: 'openai' })
		await connections.setCredential(oa.id, 'sk-provenance-key', true)
		await connections.test(oa.id)
		const ai = new AiController(
			store,
			(s) => connections.runConfig(s),
			() => {},
		)
		const started = await ai.start(access, comparison.id, { kind: 'all' }, { connectionId: oa.id, modelId: 'local-a' })
		for (let i = 0; i < 50 && ai.runsFor('/repo', comparison.id).find((r) => r.id === started.id)?.status === 'running'; i++)
			await new Promise((r) => setTimeout(r, 20))
		await store.flush()
		const run = ai.runsFor('/repo', comparison.id).find((r) => r.id === started.id)!
		assert.equal(run.status, 'completed')
		assert.equal(run.provider, 'openai')
		assert.equal(run.protocol, 'openai-responses')
		assert.equal(run.model, 'local-a')
		assert.equal(run.connectionId, oa.id)
		assert.equal(run.connectionLabel, 'OpenAI')
		assert.ok(run.endpoint)
		assert.ok(run.limitsUsed && run.limitsUsed.contextWindow > 0)
		await connections.remove(oa.id)
		const after = ReviewStore.in(dir)
		await after.load()
		const reopened = after.read().repos['/repo'].aiRuns[comparison.id][0]
		assert.equal(reopened.connectionLabel, 'OpenAI', 'history remains readable after disconnect')
		assert.ok(!readFileSync(join(dir, 'review-store.json'), 'utf8').includes('sk-provenance-key'))
	} finally {
		await mock.close()
	}
})

test('the run keeps its captured provider; picker changes apply to the next run; removal cancels', async () => {
	const { store, access, comparison, dir } = await reviewSetup()
	const { connections } = await services(dir)
	const a = await connections.create({ kind: 'fixture', label: 'A' })
	const slow = createFakeProvider({ delayMs: 300, model: 'fixture-v1' })
	const used: Array<string> = []
	const ai = new AiController(
		store,
		async (sel) => {
			const cfg = await connections.runConfig(sel)
			used.push(sel.modelId)
			return { ...cfg, provider: slow }
		},
		() => {},
	)
	connections.onRemoved((id) => ai.cancelForConnection(id))
	const run1 = await ai.start(access, comparison.id, { kind: 'all' }, { connectionId: a.id, modelId: 'fixture-v1' })
	await connections.addModel(a.id, 'other-model')
	await connections.select({ connectionId: a.id, modelId: 'other-model' }) // picker change mid-run
	await connections.remove(a.id) // disconnect mid-run
	for (let i = 0; i < 50 && ai.runsFor('/repo', comparison.id).some((r) => r.status === 'running'); i++)
		await new Promise((r) => setTimeout(r, 20))
	await store.flush()
	const stored = ai.runsFor('/repo', comparison.id).find((r) => r.id === run1.id)!
	assert.equal(stored.status, 'cancelled')
	assert.equal(stored.model, 'fixture-v1', 'the run kept the model it started with')
	assert.equal(stored.findings.length, 0, 'late results after disconnect are ignored')
	assert.deepEqual(used, ['fixture-v1'])
	await assert.rejects(ai.start(access, comparison.id, { kind: 'all' }, { connectionId: a.id, modelId: 'fixture-v1' }), /no longer exists/)
})

test('batches are sized to the model context window; too-small windows fail explicitly', async () => {
	const { store, access, comparison } = await reviewSetup(400)
	const sizes: Array<number> = []
	const small = createFakeProvider({
		limits: { contextWindow: 12_288, maxOutputTokens: 2048 },
		script: (req) => {
			sizes.push(req.input.length)
			return EMPTY_OUTPUT
		},
	})
	const run = await runWithProvider(store, access, comparison, small)
	assert.equal(run.status, 'completed')
	assert.ok(run.coverage.batchesTotal > 1, 'split into several requests')
	assert.ok(run.limitsUsed!.maxBatchChars < 20_000)
	assert.ok(sizes.every((n) => n <= run.limitsUsed!.maxBatchChars + 2000))
	assert.ok(run.notices!.some((n) => /context window/.test(n)))

	const tiny = createFakeProvider({ limits: { contextWindow: 2048, maxOutputTokens: 1024 } })
	const failed = await runWithProvider(store, access, comparison, tiny)
	assert.equal(failed.status, 'failed')
	assert.match(failed.errors.join(' '), /too small/)
	assert.equal(tiny.calls, 0)
})

test('a response whose reported input tokens show silent truncation is not counted as reviewed', async () => {
	const { store, access, comparison } = await reviewSetup(200)
	const truncating = {
		...createFakeProvider(),
		async review() {
			return {
				output: EMPTY_OUTPUT,
				usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 5, reasoningTokens: 0, totalTokens: 55 },
			}
		},
	}
	const run = await runWithProvider(store, access, comparison, truncating)
	assert.equal(run.status, 'failed')
	assert.match(run.errors.join(' '), /truncated/)
	assert.equal(run.coverage.files[0].state, 'failed')
})

test('a model that becomes unavailable stops the run without retrying and without switching providers', async () => {
	const { store, access, comparison } = await reviewSetup(400)
	const gone = createFakeProvider({
		limits: { contextWindow: 12_288, maxOutputTokens: 2048 },
		script: () => new ProviderError('model-unavailable', 'Model "x" is not available'),
	})
	const run = await runWithProvider(store, access, comparison, gone)
	assert.equal(run.status, 'failed')
	assert.equal(gone.calls, 1, 'fatal error: not retried, remaining batches not scheduled')
	assert.equal(run.provider, 'fixture')
})

async function runWithProvider(
	store: ReviewStore,
	access: Awaited<ReturnType<typeof reviewSetup>>['access'],
	comparison: Comparison,
	provider: ReturnType<typeof createFakeProvider>,
): Promise<AiRun> {
	const ai = new AiController(
		store,
		async (sel) => ({
			provider,
			connectionId: sel.connectionId,
			connectionLabel: 'Fixture',
			endpoint: 'fixture://local',
			limits: { contextLines: 5, maxBatchChars: 160_000, maxRunChars: 2_000_000 },
		}),
		() => {},
		{ concurrency: 1 },
	)
	const started = await ai.start(
		access,
		comparison.id,
		{ kind: 'all' },
		{ connectionId: '00000000-0000-4000-8000-000000000001', modelId: provider.model },
	)
	for (let i = 0; i < 200 && ai.runsFor('/repo', comparison.id).find((r) => r.id === started.id)?.status === 'running'; i++)
		await new Promise((r) => setTimeout(r, 10))
	await store.flush()
	return ai.runsFor('/repo', comparison.id).find((r) => r.id === started.id)!
}

test('OmniRoute preset: key auth, gateway-reported per-model limits drive batch sizing', async () => {
	const mock = await mockServer((r) =>
		r.path === '/v1/models'
			? {
					body: {
						object: 'list',
						data: [
							{
								id: 'auto/best-coding',
								object: 'model',
								owned_by: 'combo',
								context_length: 1048576,
								max_input_tokens: 200000,
								max_output_tokens: 16000,
							},
						],
					},
				}
			: undefined,
	)
	try {
		const { connections } = await services()
		const c = await connections.create({ kind: 'custom', preset: 'omniroute', baseUrl: `${mock.base}/v1` })
		assert.equal(c.label, 'OmniRoute (local)')
		assert.equal(c.auth, 'api-key')
		assert.equal(c.contextWindow, null, 'no fixed window: use what the gateway reports')
		await connections.setCredential(c.id, 'omni-key-123456', true)
		await connections.test(c.id)
		const m = connections.view().connections[0].models[0]
		assert.deepEqual([m.id, m.contextWindow, m.maxOutputTokens], ['auto/best-coding', 200000, 16000])
		const cfg = await connections.runConfig({ connectionId: c.id, modelId: 'auto/best-coding' })
		assert.deepEqual(cfg.provider.limits, { contextWindow: 200000, maxOutputTokens: 16000 })
		mock.seen.length = 0
		await cfg.provider.review(
			{ instructions: 'S', input: 'I', batch: { index: 0, excerpts: [], fileKeys: [], overview: '', chars: 0 } },
			new AbortController().signal,
		)
		assert.equal(mock.seen[0].path, '/v1/chat/completions')
		assert.equal(mock.seen[0].headers.authorization, 'Bearer omni-key-123456')
		assert.equal((mock.seen[0].body as any).response_format.type, 'json_schema')
		assert.equal((mock.seen[0].body as any).max_tokens, 16000)
	} finally {
		await mock.close()
	}
})

test('review teams: saved with settings, validated, selected, run through the controller; removing a member’s provider cancels', async () => {
	const { store, access, comparison, dir } = await reviewSetup()
	const { connections } = await services(dir)
	const a = await connections.create({ kind: 'fixture', label: 'Gateway A' })
	// A second connection with a manual model: the gateway need not be reachable, the controller is given the provider.
	const b = await connections.create({ kind: 'custom', label: 'Gateway B', baseUrl: 'http://127.0.0.1:9/v1', auth: 'none' })
	await connections.addModel(b.id, 'fixture-v1')
	const { REVIEW_RULES } = await import('../src/shared/types.ts')
	const team = {
		id: '11111111-1111-4111-8111-111111111111',
		name: 'Default team',
		members: [
			{
				id: '22222222-2222-4222-8222-222222222222',
				role: 'Security',
				connectionId: b.id,
				modelId: 'fixture-v1',
				rules: ['security' as const],
			},
			{
				id: '33333333-3333-4333-8333-333333333333',
				role: 'Everything else',
				connectionId: a.id,
				modelId: 'fixture-v1',
				rules: REVIEW_RULES.filter((r) => r !== 'security'),
			},
		],
	}
	await assert.rejects(
		connections.saveTeam({ ...team, members: [{ ...team.members[0], modelId: 'nope' }] }),
		/Security: model "nope" is not offered by Gateway B/,
	)
	await connections.saveTeam({ ...team, members: [team.members[0]] })
	assert.ok(connections.view().teams[0].issues.some((i) => /No member checks 13 rules/.test(i.message)))
	await connections.saveTeam(team)
	assert.deepEqual(
		connections.view().teams[0].issues.map((i) => i.message),
		['Security: Gateway B is not connected.'],
		'an untested connection is reported, not hidden',
	)
	await connections.selectTeam(team.id)
	assert.deepEqual(connections.view().reviewer, { kind: 'team', teamId: team.id })

	// Survives a restart; picking a single model switches away from the team.
	const again = await services(dir)
	assert.deepEqual(again.connections.view().reviewer, { kind: 'team', teamId: team.id })
	assert.equal(again.connections.view().teams[0].members.length, 2)

	const captured: Array<string> = []
	const slow = createFakeProvider({ delayMs: 300 })
	const ai = new AiController(
		store,
		async (sel) => {
			captured.push(sel.connectionId)
			const c = connections.view().connections.find((x) => x.id === sel.connectionId)
			if (!c) throw new Error(`That AI provider connection no longer exists.`)
			return { provider: slow, connectionId: c.id, connectionLabel: c.label, endpoint: c.baseUrl, limits: connections.view().limits }
		},
		() => {},
	)
	ai.attachTeams((id) => connections.team(id))
	connections.onRemoved((id) => ai.cancelForConnection(id))
	const started = await ai.start(access, comparison.id, { kind: 'all' }, { kind: 'team', teamId: team.id })
	assert.deepEqual(captured, [b.id, a.id], 'every member’s credential is captured before anything is sent')
	assert.equal(started.team!.name, 'Default team')
	await connections.remove(b.id) // a member's provider disconnects mid-run
	for (let i = 0; i < 50 && ai.runsFor('/repo', comparison.id).some((r) => r.status === 'running'); i++)
		await new Promise((r) => setTimeout(r, 20))
	await store.flush()
	assert.equal(ai.runsFor('/repo', comparison.id).find((r) => r.id === started.id)!.status, 'cancelled')
	assert.ok(connections.view().teams[0].issues.some((i) => /Security: its provider was disconnected/.test(i.message)))
	await assert.rejects(ai.start(access, comparison.id, { kind: 'all' }, { kind: 'team', teamId: team.id }), /Security: .*no longer exists/)

	await connections.select({ connectionId: a.id, modelId: 'fixture-v1' })
	assert.equal(connections.view().reviewer?.kind, 'model')
	await connections.removeTeam(team.id)
	assert.equal(connections.view().teams.length, 0)
})
