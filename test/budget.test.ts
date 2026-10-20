import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkBudget, hasBudgets, NO_BUDGETS, type Spent } from '../src/main/ai/budget.ts'
import type { FileSource } from '../src/main/ai/context.ts'
import type { RunConfig } from '../src/main/ai/connections.ts'
import { AiController } from '../src/main/ai/controller.ts'
import { createFakeProvider } from '../src/main/ai/fake.ts'
import { startRun } from '../src/main/ai/runner.ts'
import { spentBy } from '../src/main/ai/usage.ts'
import { AppFail } from '../src/main/git.ts'
import { ReviewStore } from '../src/main/store.ts'
import { budgetSettings } from '../src/main/validate.ts'
import type { ChangedFile, Comparison, PricedModel, Review, UsageRecord } from '../src/shared/types.ts'

const spent = (today: number, month: number, byConn: Record<string, [number, number]> = {}): Spent => {
	const t = (usd: number) => ({ usd, unpriced: false, inputTokens: 0, outputTokens: 0 })
	return {
		today: { ...t(today), connections: Object.fromEntries(Object.entries(byConn).map(([id, [d]]) => [id, t(d)])) },
		month: { ...t(month), connections: Object.fromEntries(Object.entries(byConn).map(([id, [, m]]) => [id, t(m)])) },
	}
}
const GW = { id: 'gw', label: 'Gateway' }

test('budgets: the caps reached, and the most a run may cost is the tightest of its own budget and what caps have left', () => {
	const b = { perRun: 2, daily: 10, monthly: 100, connections: { gw: { daily: 3, monthly: null } } }
	assert.deepEqual(checkBudget(NO_BUDGETS, spent(50, 500), [GW]), { over: [], limit: null })

	const fresh = checkBudget(b, spent(1, 1, { gw: [0.5, 0.5] }), [GW])
	assert.deepEqual(fresh.over, [])
	assert.deepEqual(fresh.limit, { usd: 2, reason: 'This run reached its budget of $2.00' })

	const tight = checkBudget(b, spent(9, 9, { gw: [2.5, 2.5] }), [GW])
	assert.equal(tight.limit?.usd, 0.5)
	assert.match(tight.limit!.reason, /today's budget of \$3.00 for Gateway/)

	const over = checkBudget(b, spent(10, 10, { gw: [3, 3] }), [GW])
	assert.equal(over.over.length, 2)
	assert.match(over.over.join(' '), /\$10.00 spent: today's budget of \$10.00 is reached/)
	assert.deepEqual(checkBudget(b, spent(10, 10, { gw: [3, 3] }), [GW], true).limit, {
		usd: 2,
		reason: 'This run reached its budget of $2.00',
	})
	assert.deepEqual(checkBudget(b, spent(0, 0, { gw: [5, 5] }), [{ id: 'other', label: 'Other' }]).over, [], "another connection's cap")
})

test('spend: today and this month in local time, by connection; requests without a price make it a lower bound', () => {
	const now = new Date(2026, 9, 20, 12)
	const rec = (at: Date, usd: number, connectionId = 'gw', unpriced = false): UsageRecord => ({
		id: String(Math.random()),
		at: at.toISOString(),
		kind: 'review',
		repoId: null,
		repo: null,
		connectionId,
		connection: connectionId,
		provider: 'custom',
		model: 'm',
		requests: 1,
		unreported: 0,
		usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 0, totalTokens: 0 },
		cost: { usd, estimated: false, unpriced },
	})
	const s = spentBy(
		[rec(new Date(2026, 9, 20, 1), 1), rec(new Date(2026, 9, 19, 23), 2, 'other', true), rec(new Date(2026, 8, 30), 4)],
		now,
	)
	assert.equal(s.today.usd, 1)
	assert.equal(s.today.unpriced, false)
	assert.equal(s.month.usd, 3)
	assert.equal(s.month.unpriced, true)
	assert.equal(s.month.connections.other.usd, 2)
	assert.equal(s.today.inputTokens, 100)
})

const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const PRICE: PricedModel = { input: 1_000, cachedInput: null, cacheWrite: null, output: 1_000, source: 'override' }

function change(n: number): { comp: Comparison; sources: Array<FileSource> } {
	const sources = Array.from({ length: n }, (_, i): FileSource => {
		const key = `src/f${i}.ts`
		const file: ChangedFile = {
			key,
			status: 'modified',
			oldPath: key,
			newPath: key,
			additions: 1,
			deletions: 1,
			binary: false,
			similarity: null,
		}
		// 30 replaced lines of about 60 characters: one file fills most of a 3,000-character request.
		const lines = Array.from({ length: 30 }, (_, j) => `export const value${i}_${j} = compute(${j}, 'a fairly long argument')`)
		return {
			file,
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
							...lines.map((text, j) => ({ kind: 'del' as const, oldNo: j + 1, newNo: null, text: text.replace('compute', 'old') })),
							...lines.map((text, j) => ({ kind: 'add' as const, oldNo: null, newNo: j + 1, text })),
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
// One file per request, so the budget can stop the run between them.
const LIMITS = { contextLines: 1, maxBatchChars: 8000, maxRunChars: 1_000_000, relatedCode: false, lookups: false, verify: true }

test('a run stops at its budget: the request under way finishes, no new one is sent, and the rest is skipped with why', async () => {
	const { comp, sources } = change(3)
	const provider = Object.assign(createFakeProvider({ delayMs: 0 }), { price: PRICE })
	const run = await startRun(
		{ reviewId: comp.id, comparison: comp, scope: { kind: 'all' }, loadSources: async () => sources, previousFindings: [] },
		{
			provider,
			limits: { ...LIMITS, maxBatchChars: 6000 },
			concurrency: 1,
			maxAttempts: 1,
			backoffMs: () => 1,
			budget: { usd: 0.01, reason: 'This run reached its budget of $0.01' },
		},
		() => {},
	).done
	assert.ok(run.coverage.batchesTotal >= 3, 'several requests were planned')
	assert.equal(provider.calls, 1, 'nothing more was sent once the budget was reached, not even a double-check')
	assert.equal(run.status, 'partial')
	const skipped = run.coverage.files.filter((f) => f.state === 'skipped')
	assert.ok(skipped.length >= 2)
	assert.ok(skipped.every((f) => f.reason === 'This run reached its budget of $0.01 before this file was reviewed'))
	assert.ok(run.notices!.some((n) => /no more requests were sent/.test(n)))
})

test('a run over a daily or monthly budget does not start unless you say so; then only its own budget stops it', async () => {
	const { comp, sources } = change(1)
	const store = ReviewStore.in(mkdtempSync(join(tmpdir(), 'review-budget-')))
	await store.load()
	const review = { id: comp.id, repoId: '/repo', baseRef: 'main', baseTipSha: BASE, baseSha: BASE, headSha: HEAD, headRef: null } as Review
	await store.update((d) => {
		d.repos['/repo'] = {
			repoId: '/repo',
			root: '/repo',
			selectedBase: null,
			activeReviewId: comp.id,
			reviews: { [comp.id]: { ...review, createdAt: '', updatedAt: '', comments: [], drafts: [], viewed: [], findingDecisions: {} } },
			aiRuns: {},
		}
	})
	const config = async (): Promise<RunConfig> => ({
		provider: createFakeProvider({ delayMs: 0 }),
		connectionId: 'gw',
		connectionLabel: 'Gateway',
		endpoint: 'x',
		limits: { ...LIMITS, groupDuplicates: false },
	})
	const controller = new AiController(store, config, () => {})
	const checked: Array<boolean> = []
	controller.attachBudget({
		active: () => true,
		check: (used, ignoreCaps = false) => {
			checked.push(ignoreCaps)
			return checkBudget({ perRun: 5, daily: 1, monthly: null, connections: {} }, spent(1.5, 1.5), used, ignoreCaps)
		},
	})
	const access = {
		comparison: comp,
		loadPatch: async () => sources[0].patch,
		loadFileLines: async () => sources[0].fullText!,
	}
	const sel = { connectionId: '00000000-0000-4000-8000-000000000000', modelId: 'm' }
	await assert.rejects(
		controller.start(access, comp.id, { kind: 'all' }, sel),
		(e: unknown) => e instanceof AppFail && e.code === 'over-budget' && /today's budget of \$1.00 is reached/.test(e.message),
	)
	const run = await controller.start(access, comp.id, { kind: 'all' }, sel, { overBudget: true })
	assert.equal(run.status, 'running')
	assert.deepEqual(checked, [false, true])
})

test('budget settings: dollars or none, connection ids checked', () => {
	assert.deepEqual(budgetSettings({ perRun: 2, daily: null }), { perRun: 2, daily: null, monthly: null, connections: {} })
	assert.throws(() => budgetSettings({ perRun: -1 }))
	assert.throws(() => budgetSettings({ connections: { 'not-an-id': { daily: 1 } } }))
	const id = '00000000-0000-4000-8000-000000000000'
	assert.deepEqual(budgetSettings({ connections: { [id]: { daily: 1 } } }).connections, { [id]: { daily: 1, monthly: null } })
})

test('without a budget set nothing is limited: a run goes exactly as before, however much was spent', async () => {
	assert.equal(hasBudgets(NO_BUDGETS), false)
	assert.equal(hasBudgets({ ...NO_BUDGETS, connections: { gw: { daily: null, monthly: null } } }), false)
	assert.equal(hasBudgets({ ...NO_BUDGETS, connections: { gw: { daily: null, monthly: 0 } } }), true, 'a $0 budget is set')
	assert.equal(hasBudgets({ ...NO_BUDGETS, perRun: 1 }), true)
	assert.deepEqual(checkBudget(NO_BUDGETS, spent(1e6, 1e6, { gw: [1e6, 1e6] }), [GW]), { over: [], limit: null })

	const { comp, sources } = change(3)
	const go = (budget: { usd: number; reason: string } | null) => {
		const provider = Object.assign(createFakeProvider({ delayMs: 0 }), { price: PRICE })
		return startRun(
			{ reviewId: comp.id, comparison: comp, scope: { kind: 'all' }, loadSources: async () => sources, previousFindings: [] },
			{ provider, limits: { ...LIMITS, maxBatchChars: 6000 }, concurrency: 1, maxAttempts: 1, backoffMs: () => 1, budget },
			() => {},
		).done.then((run) => ({ run, calls: provider.calls }))
	}
	const before = await go(null)
	const unset = await go(checkBudget(NO_BUDGETS, spent(1e6, 1e6), [GW]).limit)
	assert.equal(unset.calls, before.calls)
	assert.equal(unset.run.status, before.run.status)
	assert.deepEqual(
		unset.run.coverage.files.map((f) => f.state),
		before.run.coverage.files.map((f) => f.state),
	)
	assert.ok(!unset.run.notices!.some((n) => /budget/i.test(n)))
})
