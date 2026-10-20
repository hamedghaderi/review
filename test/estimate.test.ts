import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FileSource } from '../src/main/ai/context.ts'
import { AiController } from '../src/main/ai/controller.ts'
import { estimateRun, type EstimateReviewer } from '../src/main/ai/estimate.ts'
import { createFakeProvider } from '../src/main/ai/fake.ts'
import { instructionsFor } from '../src/main/ai/prompt.ts'
import { startRun } from '../src/main/ai/runner.ts'
import { ReviewStore } from '../src/main/store.ts'
import { DEFAULT_TEAM_ROLES, type ChangedFile, type Comparison, type PricedModel, type ReviewLimits } from '../src/shared/types.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const PRICE: PricedModel = { input: 2, cachedInput: 0.2, cacheWrite: null, output: 10, source: 'catalog' }
const LIMITS: ReviewLimits = {
	contextLines: 5,
	maxBatchChars: 6000,
	maxRunChars: 1_000_000,
	relatedCode: false,
	lookups: false,
	verify: true,
	groupDuplicates: false,
}
const MODEL = { contextWindow: 200_000, maxOutputTokens: 32_000 }

function file(key: string): ChangedFile {
	return { key, status: 'modified', oldPath: key, newPath: key, additions: 30, deletions: 30, binary: false, similarity: null }
}

// Three source files and a test, each with 30 lines replaced: several requests at 6,000 characters each.
function change(): { comp: Comparison; sources: Array<FileSource> } {
	const keys = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'test/a.test.ts']
	const sources = keys.map((key): FileSource => {
		const lines = Array.from({ length: 30 }, (_, i) => `export const value${i} = compute(${i}) // ${key}`)
		return {
			file: file(key),
			patch: {
				kind: 'text',
				bytes: 4000,
				hunks: [
					{
						oldStart: 1,
						oldCount: 30,
						newStart: 1,
						newCount: 30,
						section: '',
						lines: [
							...lines.map((text, i) => ({ kind: 'del' as const, oldNo: i + 1, newNo: null, text: text.replace('compute', 'old') })),
							...lines.map((text, i) => ({ kind: 'add' as const, oldNo: null, newNo: i + 1, text })),
						],
					},
				],
			},
			fullText: { kind: 'text', lines },
		}
	})
	return {
		comp: {
			id: `${BASE}..${HEAD}`,
			repoId: '/repo',
			baseRef: 'main',
			baseTipSha: BASE,
			baseSha: BASE,
			headSha: HEAD,
			headRef: null,
			target: null,
			pr: null,
			files: sources.map((s) => s.file),
		},
		sources,
	}
}

const one = (over: Partial<EstimateReviewer> = {}): EstimateReviewer => ({
	role: null,
	model: 'm',
	rules: null,
	limits: MODEL,
	price: PRICE,
	instructionChars: instructionsFor(null, null).length,
	...over,
})

test('estimate: as many requests as the run sends for the same change and limits, with tokens and cost as a range', async () => {
	const { comp, sources } = change()
	const e = estimateRun(comp, sources, LIMITS, [one()])
	const run = await startRun(
		{ reviewId: comp.id, comparison: comp, scope: { kind: 'all' }, loadSources: async () => sources, previousFindings: [] },
		{ provider: createFakeProvider({ delayMs: 0 }), limits: LIMITS, concurrency: 1, maxAttempts: 1, backoffMs: () => 1 },
		() => {},
	).done
	assert.ok(run.coverage.batchesTotal > 1)
	assert.equal(e.requests, run.coverage.batchesTotal)
	assert.equal(e.files, 4)
	assert.ok(e.inputTokens.low > 0 && e.inputTokens.high > e.inputTokens.low)
	assert.ok(e.cost && e.cost.high > e.cost.low && e.cost.estimated && !e.cost.unpriced)
	assert.ok(
		e.notes.some((n) => /Double-checking/.test(n)),
		'what it leaves out is said',
	)
})

test('estimate: lookups widen the range and say so', () => {
	const { comp, sources } = change()
	const plain = estimateRun(comp, sources, LIMITS, [one()])
	const looked = estimateRun(comp, sources, { ...LIMITS, lookups: true }, [
		one({ instructionChars: instructionsFor(null, null, undefined, true).length }),
	])
	assert.ok(looked.inputTokens.high / looked.inputTokens.low > plain.inputTokens.high / plain.inputTokens.low)
	assert.ok(looked.notes.some((n) => /Lookups resend/.test(n)))
})

test('estimate: focused passes get only their files; a member without a price makes the cost a lower bound', () => {
	const { comp, sources } = change()
	const members = DEFAULT_TEAM_ROLES.map((r, i) =>
		one({ role: r.role, rules: r.rules, price: i === 3 ? null : PRICE, instructionChars: instructionsFor(r.rules, r.role).length }),
	)
	const e = estimateRun(comp, sources, LIMITS, members)
	const all = estimateRun(comp, sources, LIMITS, [one()])
	assert.ok(e.requests < all.requests * members.length, 'not every member gets every file')
	assert.equal(e.cost?.unpriced, true)
	assert.ok(e.notes.some((n) => /no price/.test(n)))
	assert.equal(estimateRun(comp, sources, LIMITS, [one({ price: null })]).cost, null)
})

test('estimate: a model too small for any request says so instead of guessing', () => {
	const { comp, sources } = change()
	const e = estimateRun(comp, sources, LIMITS, [one({ limits: { contextWindow: 4000, maxOutputTokens: 1000 } })])
	assert.equal(e.requests, 0)
	assert.match(e.notes[0], /too small/)
})

test('the controller estimates from model details alone: no provider is built and no credential is read', async () => {
	const { comp, sources } = change()
	const store = ReviewStore.in(mkdtempSync(join(tmpdir(), 'review-estimate-')))
	await store.load()
	const controller = new AiController(
		store,
		async () => {
			throw new Error('an estimate must not resolve a provider')
		},
		() => {},
	)
	controller.attachModels({ info: () => ({ limits: MODEL, price: PRICE }), limits: () => LIMITS, label: () => 'Gateway' })
	const source = (k: string) => sources.find((s) => s.file.key === k)!
	const access = {
		comparison: comp,
		loadPatch: async (k: string) => source(k).patch,
		loadFileLines: async (k: string) => source(k).fullText!,
	}
	const sel = { connectionId: '00000000-0000-4000-8000-000000000000', modelId: 'm' }
	const all = await controller.estimate(access, { kind: 'all' }, { kind: 'model', selection: sel })
	const single = await controller.estimate(access, { kind: 'file', fileKey: 'src/a.ts' }, { kind: 'model', selection: sel })
	assert.equal(single.files, 1)
	assert.ok(single.requests < all.requests)
	const passes = await controller.estimate(access, { kind: 'all' }, { kind: 'model', selection: sel, passes: true })
	assert.ok(passes.requests > all.requests)
})

test('with a budget set, the estimate names the models budgets cannot limit because they have no price; without one it says nothing', async () => {
	const { comp, sources } = change()
	const store = ReviewStore.in(mkdtempSync(join(tmpdir(), 'review-estimate-')))
	await store.load()
	const controller = new AiController(
		store,
		async () => {
			throw new Error('not used')
		},
		() => {},
	)
	let price: PricedModel | null = null
	controller.attachModels({ info: () => ({ limits: MODEL, price }), limits: () => LIMITS, label: () => 'Gateway' })
	let active = false
	controller.attachBudget({ active: () => active, check: () => ({ over: [], limit: null }) })
	const source = (k: string) => sources.find((s) => s.file.key === k)!
	const access = {
		comparison: comp,
		loadPatch: async (k: string) => source(k).patch,
		loadFileLines: async (k: string) => source(k).fullText!,
	}
	const choice = {
		kind: 'model' as const,
		selection: { connectionId: '00000000-0000-4000-8000-000000000000', modelId: 'auto/best-coding' },
	}
	assert.deepEqual((await controller.estimate(access, { kind: 'all' }, choice)).unbudgeted, [], 'no budget set: nothing to say')
	active = true
	assert.deepEqual((await controller.estimate(access, { kind: 'all' }, choice)).unbudgeted, ['auto/best-coding'])
	price = PRICE
	assert.deepEqual((await controller.estimate(access, { kind: 'all' }, choice)).unbudgeted, [], 'a priced model is limited')
})
