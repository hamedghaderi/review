import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AdapterFactory } from '../src/main/ai/adapters.ts'
import { ConnectionService } from '../src/main/ai/connections.ts'
import { CredentialService, type SecretCipher } from '../src/main/ai/credentials.ts'
import { createFakeProvider } from '../src/main/ai/fake.ts'
import { interpretMessage } from '../src/main/ai/anthropic.ts'
import { catalogMatch } from '../src/main/ai/catalog.ts'
import { openRouterPrice } from '../src/main/ai/openai.ts'
import { startRun } from '../src/main/ai/runner.ts'
import { addCost, costOf, formatCost } from '../src/shared/cost.ts'
import type { AiRun, ChangedFile, Comparison, PricedModel } from '../src/shared/types.ts'

const usage = (over: Partial<Parameters<typeof costOf>[0]> = {}) => ({
	inputTokens: 1_000_000,
	cachedInputTokens: 0,
	outputTokens: 100_000,
	reasoningTokens: 0,
	totalTokens: 0,
	...over,
})
const PRICE: PricedModel = { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10, source: 'provider' }

test('cost: cached and cache-write input at their own price, the rest at the input price; output includes reasoning', () => {
	assert.equal(costOf(usage(), PRICE), 2 + 1)
	// 600k plain, 300k cached, 100k written.
	assert.equal(costOf(usage({ cachedInputTokens: 300_000, cacheWriteTokens: 100_000 }), PRICE), 1.2 + 0.03 + 0.25 + 1)
	// Without cache prices, cached input is billed as plain input.
	assert.equal(costOf(usage({ cachedInputTokens: 500_000 }), { ...PRICE, cachedInput: null }), 3)
})

test('cost: a request without a price or without usage makes the total a lower bound; catalog prices make it estimated', () => {
	let c = addCost(null, usage(), PRICE)
	assert.deepEqual(c, { usd: 3, estimated: false, unpriced: false })
	assert.equal(formatCost(c), '$3.00')
	c = addCost(c, null, PRICE)
	assert.equal(c.unpriced, true)
	assert.equal(formatCost(c), 'at least $3.00')
	c = addCost(c, usage(), { ...PRICE, source: 'catalog' })
	assert.deepEqual(c, { usd: 6, estimated: true, unpriced: true })
	assert.equal(formatCost(addCost(null, usage(), null)), 'unknown', 'never shown as $0 when nothing was priced')
	assert.equal(formatCost(addCost(null, usage({ inputTokens: 10, outputTokens: 1 }), PRICE)), '<$0.01')
})

test('OpenRouter prices: dollars per token become dollars per million; the auto router (-1) has none', () => {
	assert.deepEqual(openRouterPrice({ prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' }), {
		input: 3,
		cachedInput: 0.3,
		cacheWrite: null,
		output: 15,
	})
	assert.deepEqual(openRouterPrice({ prompt: '0', completion: '0' }), { input: 0, cachedInput: null, cacheWrite: null, output: 0 })
	assert.equal(openRouterPrice({ prompt: '-1', completion: '-1' }), null)
	assert.equal(openRouterPrice({ prompt: '0.000001' }), null)
	assert.equal(openRouterPrice(undefined), null)
})

test('Anthropic usage reports cache writes beside cache reads', () => {
	const r = interpretMessage({
		id: 'm',
		type: 'message',
		role: 'assistant',
		model: 'claude',
		stop_reason: 'end_turn',
		stop_sequence: null,
		content: [{ type: 'text', text: '{}', citations: null }],
		usage: { input_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 3000, output_tokens: 5 },
	} as never)
	assert.equal(r.usage!.inputTokens, 3210)
	assert.equal(r.usage!.cachedInputTokens, 200)
	assert.equal(r.usage!.cacheWriteTokens, 3000)
})

const cipher: SecretCipher = {
	isAsyncEncryptionAvailable: async () => true,
	encryptStringAsync: async (plain) => Buffer.from(plain),
	decryptStringAsync: async (buf) => ({ result: buf.toString(), shouldReEncrypt: false }),
	getSelectedStorageBackend: () => 'keychain',
}

async function connections(listed: Array<{ id: string; price: PricedModel | null; root?: string }> = []) {
	const dir = mkdtempSync(join(tmpdir(), 'review-cost-'))
	const adapters: AdapterFactory = {
		account: () => ({
			listModels: async () =>
				listed.map((m) => ({
					id: m.id,
					label: m.id,
					contextWindow: 100_000,
					maxOutputTokens: 8000,
					structuredOutput: 'yes' as const,
					price: m.price && {
						input: m.price.input,
						cachedInput: m.price.cachedInput,
						cacheWrite: m.price.cacheWrite,
						output: m.price.output,
					},
					root: m.root ?? null,
				})),
		}),
		provider: (_c, model) => createFakeProvider({ model }),
	}
	const credentials = new CredentialService(dir, cipher)
	await credentials.load()
	const service = new ConnectionService(dir, credentials, adapters, { showDevelopment: true })
	await service.load()
	return service
}

test('model prices: yours, else the provider list, else free for local servers, else the catalog; unknown otherwise', async () => {
	const s = await connections([
		{ id: 'vendor/priced', price: PRICE },
		{ id: 'vendor/router', price: null },
	])
	const priceOf = (connectionId: string, modelId: string) =>
		s
			.view()
			.connections.find((c) => c.id === connectionId)!
			.models.find((m) => m.id === modelId)?.price ?? null

	const anthropic = await s.create({ kind: 'anthropic' })
	assert.equal(priceOf(anthropic.id, 'claude-sonnet-5-5')?.source, 'catalog')

	const router = await s.create({ kind: 'openrouter' })
	await s.setCredential(router.id, 'sk-or-dddddddd', false)
	await s.test(router.id)
	assert.deepEqual(priceOf(router.id, 'vendor/priced'), PRICE)
	assert.equal(priceOf(router.id, 'vendor/router'), null)

	const ollama = await s.create({ kind: 'custom', preset: 'ollama' })
	await s.addModel(ollama.id, 'llama4')
	assert.equal(priceOf(ollama.id, 'llama4')?.source, 'local')
	const gateway = await s.create({ kind: 'custom', preset: 'generic', baseUrl: 'https://gateway.example.com/v1' })
	await s.addModel(gateway.id, 'constructor')
	assert.equal(priceOf(gateway.id, 'constructor'), null, 'a model id is never read off the object prototype')

	await s.setModelPrice(router.id, 'vendor/router', { input: 1, cachedInput: null, cacheWrite: null, output: 4 })
	assert.deepEqual(priceOf(router.id, 'vendor/router'), { input: 1, cachedInput: null, cacheWrite: null, output: 4, source: 'override' })
	await s.setModelPrice(router.id, 'vendor/router', null)
	assert.equal(priceOf(router.id, 'vendor/router'), null)

	// A run captures the price with the rest of its configuration.
	const fixture = await s.create({ kind: 'fixture' })
	assert.equal((await s.runConfig({ connectionId: fixture.id, modelId: 'fixture-v1' })).provider.price?.source, 'local')
	await s.setModelPrice(fixture.id, 'fixture-v1', { input: 1, cachedInput: null, cacheWrite: null, output: 1 })
	assert.equal((await s.runConfig({ connectionId: fixture.id, modelId: 'fixture-v1' })).provider.price?.source, 'override')
})

const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const file: ChangedFile = {
	key: 'app.ts',
	status: 'modified',
	oldPath: 'app.ts',
	newPath: 'app.ts',
	additions: 1,
	deletions: 1,
	binary: false,
	similarity: null,
}
const comp: Comparison = {
	id: `${BASE}..${HEAD}`,
	repoId: '/repo',
	baseRef: 'main',
	baseTipSha: BASE,
	baseSha: BASE,
	headSha: HEAD,
	headRef: null,
	target: null,
	pr: null,
	files: [file],
}

async function costedRun(team: Array<{ id: string; price: PricedModel | null }>): Promise<AiRun> {
	const lines = ['export function add(a, b) {', '  return a + b', '}']
	const providers = team.map((m) => Object.assign(createFakeProvider({ model: m.id }), { price: m.price }))
	const handle = startRun(
		{
			reviewId: comp.id,
			comparison: comp,
			scope: { kind: 'all' },
			loadSources: async () => [
				{
					file,
					patch: {
						kind: 'text',
						bytes: 50,
						hunks: [
							{
								oldStart: 1,
								oldCount: 3,
								newStart: 1,
								newCount: 3,
								section: '',
								lines: [
									{ kind: 'ctx', oldNo: 1, newNo: 1, text: lines[0] },
									{ kind: 'del', oldNo: 2, newNo: null, text: '  return a - b' },
									{ kind: 'add', oldNo: null, newNo: 2, text: lines[1] },
									{ kind: 'ctx', oldNo: 3, newNo: 3, text: lines[2] },
								],
							},
						],
					},
					fullText: { kind: 'text', lines },
				},
			],
			previousFindings: [],
		},
		{
			provider: providers[0],
			limits: { contextLines: 5, maxBatchChars: 100_000, maxRunChars: 1_000_000, verify: false },
			concurrency: 1,
			maxAttempts: 1,
			backoffMs: () => 1,
			...(team.length > 1
				? {
						team: {
							id: 't',
							name: 'Team',
							members: team.map((m, i) => ({
								id: m.id,
								role: m.id,
								provider: providers[i],
								rules: (i === 0 ? ['bug'] : ['security']) as Array<never>,
								provenance: { connectionId: 'c', connectionLabel: 'C', endpoint: 'fixture://local' },
							})),
						},
					}
				: {}),
		},
		() => {},
	)
	return handle.done
}

test('a run is costed at the price its reviewer started with, per member and in total', async () => {
	const single = await costedRun([{ id: 'one', price: PRICE }])
	assert.ok(single.usage && single.cost)
	assert.ok(Math.abs(single.cost.usd - costOf(single.usage, PRICE)) < 1e-12)
	assert.equal(single.cost.unpriced, false)

	const team = await costedRun([
		{ id: 'priced', price: { ...PRICE, source: 'catalog' } },
		{ id: 'unpriced', price: null },
	])
	const [priced, unpriced] = team.team!.members
	assert.ok(priced.cost!.usd > 0 && priced.cost!.estimated && !priced.cost!.unpriced)
	assert.deepEqual(unpriced.cost, { usd: 0, estimated: false, unpriced: true })
	assert.deepEqual(team.cost, { usd: priced.cost!.usd, estimated: true, unpriced: true })
})

test('gateway models are priced as the catalog model they are named after, without prefix or effort and context suffixes', () => {
	assert.equal(catalogMatch('cc/claude-opus-5-5-high')?.id, 'claude-opus-5-5')
	assert.equal(catalogMatch('aug/sonnet5-500k'), null, 'a nickname is not guessed at')
	assert.equal(catalogMatch('cx/gpt-6-astra-xhigh')?.id, 'gpt-6-astra')
	assert.equal(catalogMatch('anthropic/claude-sonnet-5.5')?.id, 'claude-sonnet-5-5', 'OpenRouter writes versions with dots')
	assert.equal(catalogMatch('google/gemini-3.8-flash')?.id, 'gemini-3.8-flash')
	assert.equal(catalogMatch('gemini-3.8-flash-lite'), null, 'a different model with a longer name does not match')
	assert.equal(catalogMatch('fixture-v1'), null)
})

test('an OmniRoute model without a price of its own gets the list price of the model it routes to, marked estimated', async () => {
	const s = await connections([
		{ id: 'cc/claude-fable-5-1-high', price: null, root: 'claude-fable-5-1-high' },
		{ id: 'my-alias', price: null, root: 'claude-haiku-5-5' },
		{ id: 'auto/best-coding', price: null, root: 'auto/best-coding' },
	])
	const gw = await s.create({ kind: 'custom', preset: 'omniroute' })
	await s.setCredential(gw.id, 'omniroute-key', false)
	await s.test(gw.id)
	const price = (id: string) =>
		s
			.view()
			.connections.find((c) => c.id === gw.id)!
			.models.find((m) => m.id === id)?.price ?? null
	assert.deepEqual(price('cc/claude-fable-5-1-high'), {
		input: 10,
		cachedInput: 0.25,
		cacheWrite: 12.5,
		output: 50,
		source: 'catalog',
		listedAs: 'claude-fable-5-1',
	})
	assert.equal(price('my-alias')?.listedAs, 'claude-haiku-5-5', "the listing's root wins over the id")
	assert.equal(price('auto/best-coding'), null, 'a router picks the model, so its price is unknown')
	assert.equal(
		(await s.runConfig({ connectionId: gw.id, modelId: 'cc/claude-fable-5-1-high' })).provider.price?.listedAs,
		'claude-fable-5-1',
	)
})
