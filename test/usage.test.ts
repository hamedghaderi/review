import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { RunConfig } from '../src/main/ai/connections.ts'
import { AiController } from '../src/main/ai/controller.ts'
import { createFakeProvider } from '../src/main/ai/fake.ts'
import { ProviderError } from '../src/main/ai/provider.ts'
import { summarizeUsage, UsageLog } from '../src/main/ai/usage.ts'
import { ReviewStore } from '../src/main/store.ts'
import type { ChangedFile, Comparison, ModelSelection, PricedModel, Review, UsageRecord } from '../src/shared/types.ts'

const PRICE: PricedModel = { input: 2, cachedInput: null, cacheWrite: null, output: 10, source: 'provider' }
const USAGE = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 100_000, reasoningTokens: 0, totalTokens: 0 }
const CTX = { kind: 'review' as const, repoId: '/repo', repo: 'owner/repo', connectionId: 'c1', connection: 'Gateway' }
const REQUEST = {
	instructions: '',
	input: '',
	batch: { index: 0, references: [], facts: [], fileKeys: [], overview: '', chars: 0, excerpts: [] },
}
const signal = new AbortController().signal

const tmp = () => mkdtempSync(join(tmpdir(), 'review-usage-'))

test('usage: one record per metered provider, written with each response and kept across restarts', async () => {
	const dir = tmp()
	const log = new UsageLog(dir)
	await log.load()
	// A known amount per request, rather than the fake's own estimate.
	const fixed = { ...createFakeProvider({ model: 'm1' }), price: PRICE, review: async () => ({ output: {}, usage: USAGE }) }
	const metered = log.meter(fixed, CTX)
	await metered.review(REQUEST, signal)
	await metered.review(REQUEST, signal)
	await log.meter(fixed, { ...CTX, kind: 'question' }).review(REQUEST, signal)
	await log.flush()

	const again = new UsageLog(dir)
	await again.load()
	const s = again.summary('day')
	assert.equal(s.total.requests, 3)
	assert.deepEqual(s.total.cost, { usd: 9, estimated: false, unpriced: false })
	assert.deepEqual(
		s.kinds.map((k) => [k.key, k.totals.requests]),
		[
			['review', 2],
			['question', 1],
		],
	)
	assert.equal(s.repos[0].label, 'owner/repo')
	assert.equal(s.models[0].label, 'm1')
	assert.equal(s.models[0].detail, 'Gateway')
})

test('usage: a request that failed after the model answered counts as unknown; one that never reached it does not count', async () => {
	const log = new UsageLog(tmp())
	await log.load()
	const failing = (kind: ConstructorParameters<typeof ProviderError>[0]) =>
		log.meter(
			{
				...createFakeProvider(),
				price: PRICE,
				review: async () => {
					throw new ProviderError(kind, 'failed')
				},
			},
			CTX,
		)
	await assert.rejects(failing('invalid-output').review(REQUEST, signal))
	await assert.rejects(failing('auth').review(REQUEST, signal))
	await log.flush()
	const s = log.summary('day')
	assert.equal(s.total.requests, 1)
	assert.equal(s.total.unreported, 1)
	assert.equal(s.total.cost.unpriced, true, 'the total is a lower bound, not $0')
})

test('usage summary: the last 30 days or 12 months in local time, newest first, groups by cost', () => {
	const now = new Date(2026, 9, 20, 15)
	const rec = (at: Date, over: Partial<UsageRecord>): UsageRecord => ({
		id: String(Math.random()),
		at: at.toISOString(),
		...CTX,
		provider: 'openrouter',
		model: 'm1',
		requests: 1,
		unreported: 0,
		usage: USAGE,
		cost: { usd: 1, estimated: false, unpriced: false },
		...over,
	})
	const records = [
		rec(new Date(2026, 9, 20, 9), {}),
		rec(new Date(2026, 9, 19, 23, 30), { repoId: '/other', repo: 'other', cost: { usd: 5, estimated: true, unpriced: false } }),
		rec(new Date(2026, 8, 1), {}),
		rec(new Date(2025, 9, 1), {}), // 13 months ago
	]
	const days = summarizeUsage(records, 'day', now)
	assert.equal(days.periods.length, 30)
	assert.equal(days.periods[0].key, '2026-10-20')
	assert.equal(days.periods[1].key, '2026-10-19')
	assert.equal(days.periods[1].totals.cost.usd, 5, 'a record belongs to its local day')
	assert.equal(days.total.requests, 2, 'outside the window is left out')
	assert.deepEqual(
		days.repos.map((r) => r.label),
		['other', 'owner/repo'],
	)
	assert.equal(days.total.cost.estimated, true)

	const months = summarizeUsage(records, 'month', now)
	assert.equal(months.periods.length, 12)
	assert.deepEqual(
		months.periods.slice(0, 2).map((p) => [p.key, p.totals.requests]),
		[
			['2026-10', 2],
			['2026-09', 1],
		],
	)
	assert.equal(months.total.requests, 3)
	assert.equal(months.oldest, records[3].at)
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
const lines = ['export function add(a, b) {', '  return a + b', '}']
const patch = {
	kind: 'text' as const,
	bytes: 50,
	hunks: [
		{
			oldStart: 1,
			oldCount: 3,
			newStart: 1,
			newCount: 3,
			section: '',
			lines: [
				{ kind: 'ctx' as const, oldNo: 1, newNo: 1, text: lines[0] },
				{ kind: 'del' as const, oldNo: 2, newNo: null, text: '  return a - b' },
				{ kind: 'add' as const, oldNo: null, newNo: 2, text: lines[1] },
				{ kind: 'ctx' as const, oldNo: 3, newNo: 3, text: lines[2] },
			],
		},
	],
}

test('the controller books runs and questions to the usage history, by repository, and deleting the review keeps them', async () => {
	const dir = tmp()
	const store = ReviewStore.in(dir)
	await store.load()
	const review: Review = {
		id: comp.id,
		repoId: '/repo',
		baseRef: 'main',
		baseTipSha: BASE,
		baseSha: BASE,
		headSha: HEAD,
		headRef: null,
		createdAt: '',
		updatedAt: '',
		comments: [],
		drafts: [],
		viewed: [],
		findingDecisions: {},
	}
	await store.update((d) => {
		d.repos['/repo'] = {
			repoId: '/repo',
			root: '/code/repo',
			selectedBase: null,
			activeReviewId: comp.id,
			reviews: { [comp.id]: review },
			aiRuns: {},
		}
	})
	const provider = Object.assign(createFakeProvider({ delayMs: 0 }), { price: PRICE })
	const config = async (sel: ModelSelection): Promise<RunConfig> => ({
		provider,
		connectionId: sel.connectionId,
		connectionLabel: 'Fixture',
		endpoint: 'fixture://local',
		limits: {
			contextLines: 5,
			maxBatchChars: 100_000,
			maxRunChars: 1_000_000,
			relatedCode: false,
			lookups: false,
			verify: false,
			groupDuplicates: false,
		},
	})
	const controller = new AiController(store, config, () => {})
	const log = new UsageLog(dir)
	await log.load()
	controller.attachUsage(log)
	const access = {
		comparison: comp,
		loadPatch: async () => patch,
		loadFileLines: async () => ({ kind: 'text' as const, lines }),
	}
	const sel = { connectionId: '00000000-0000-4000-8000-000000000000', modelId: 'fixture-v1' }
	const started = await controller.start(access, comp.id, { kind: 'all' }, sel)
	for (let i = 0; i < 100 && controller.runsFor('/repo', comp.id)[0].status === 'running'; i++) await new Promise((r) => setTimeout(r, 10))
	const run = controller.runsFor('/repo', comp.id).find((r) => r.id === started.id)!
	assert.ok(run.findings.length)
	await controller.ask(access, comp.id, run.findings[0].id, 'Does this hold?')
	await store.update((d) => {
		delete d.repos['/repo'].reviews[comp.id]
		delete d.repos['/repo'].aiRuns[comp.id]
	})
	await log.flush()
	const s = log.summary('day')
	assert.deepEqual(s.kinds.map((k) => k.key).sort(), ['question', 'review'])
	assert.equal(s.repos.length, 1)
	assert.equal(s.repos[0].label, 'repo', 'a repository without GitHub is named by its folder')
	assert.ok(s.total.cost.usd > 0 && !s.total.cost.unpriced)
})
