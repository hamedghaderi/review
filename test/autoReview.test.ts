import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AutoReviewer, autoVerdict, type AutoReviewDeps } from '../src/main/autoReview.ts'
import { AppFail } from '../src/main/git.ts'
import type { RepoEvent } from '../src/main/inboxWatch.ts'
import { ReviewStore } from '../src/main/store.ts'
import type { HeadChecks } from '../src/shared/ci.ts'
import type { AiRun, AutoReviewRecord, Comparison, Finding, PublishPlan, Review, ReviewEvent } from '../src/shared/types.ts'

const anchor = {
	repoId: 'r',
	baseSha: 'b',
	headSha: 'h1',
	fileKey: 'a.ts',
	oldPath: 'a.ts',
	newPath: 'a.ts',
	side: 'new',
	startLine: 3,
	endLine: 3,
	excerpt: 'x',
}

function finding(id: string, over: Partial<Finding> = {}): Finding {
	return {
		id,
		runId: 'run1',
		excerptId: 'E1',
		anchor,
		severity: 'should_fix',
		title: id,
		evidence: '',
		repeatOf: null,
		body: `Body ${id}`,
		...over,
	} as Finding
}

function run(findings: Array<Finding>, status: AiRun['status'] = 'completed'): AiRun {
	return { id: 'run1', reviewId: 'b..h1', repoId: 'r', status, findings, errors: [], providerLabel: 'P', model: 'm' } as unknown as AiRun
}

function review(over: Partial<Review> = {}): Review {
	return { id: 'b..h1', repoId: 'r', comments: [], drafts: [], viewed: [], findingDecisions: {}, ...over } as unknown as Review
}

const who = { reviewer: 'model-x', viewer: 'me' }
const green: HeadChecks = { sha: 'h1', failed: [], pending: [], passed: 3, omitted: 0, readAt: 't' }
const ciWith = (over: Partial<HeadChecks>): HeadChecks => ({ ...green, ...over })

test('verdict: approve only a complete run with nothing standing; blocking requests changes; anything else comments', () => {
	const clean = autoVerdict(run([]), review(), [run([])], 0, who, green)
	assert.equal(clean.event, 'APPROVE')
	assert.match(clean.body, /written and submitted automatically by AI \(model-x.*on behalf of me/s, 'the body says it was the AI')

	const blocking = run([finding('f1', { severity: 'blocking' })])
	assert.equal(autoVerdict(blocking, review(), [blocking], 1, who, green).event, 'REQUEST_CHANGES')

	const shouldFix = run([finding('f1')])
	assert.equal(autoVerdict(shouldFix, review(), [shouldFix], 1, who, green).event, 'COMMENT')

	const nits = run([finding('f1', { severity: 'nit' })])
	assert.equal(autoVerdict(nits, review(), [nits], 0, who, green).event, 'APPROVE', 'nits that were not posted do not stop an approval')
	assert.equal(autoVerdict(nits, review(), [nits], 1, who, green).event, 'COMMENT', 'but a posted comment means a comment review')

	const partial = run([], 'partial')
	const p = autoVerdict(partial, review(), [partial], 0, who, green)
	assert.equal(p.event, 'COMMENT', 'files left unreviewed are never approved')
	assert.match(p.body, /not reviewed/)
})

test('verdict: dismissed findings never count; a blocking finding the double-check doubts is a comment, not a block', () => {
	const r = run([finding('f1', { severity: 'blocking' })])
	const dismissed = review({ findingDecisions: { f1: { status: 'dismissed', decidedAt: 't' } } })
	assert.equal(autoVerdict(r, dismissed, [r], 0, who, green).event, 'APPROVE')

	const doubted = run([finding('f1', { severity: 'blocking', verification: { verdict: 'wrong' } as Finding['verification'] })])
	const v = autoVerdict(doubted, review(), [doubted], 0, who, green)
	assert.equal(v.event, 'COMMENT')
	assert.match(v.body, /1 finding not posted, left for a person to check/)
})

const event = (over: Partial<RepoEvent['pr']> = {}, kind: RepoEvent['kind'] = 'requested'): RepoEvent => ({
	kind,
	repoId: 'r',
	pr: { repo: 'Octo/App', number: 7, title: 'PR', url: 'u', author: 'bob', draft: false, reviewed: false, head: 'h1', ...over },
})

const plan = (over: Partial<PublishPlan> = {}): PublishPlan =>
	({
		pr: { repo: 'Octo/App', number: 7, url: 'u', headSha: 'h1', state: 'open' },
		pending: { kind: 'none' },
		blocked: null,
		...over,
	}) as PublishPlan

async function setup(over: Partial<AutoReviewDeps> = {}, findings: Array<Finding> = [finding('f1', { severity: 'blocking' })]) {
	const store = ReviewStore.in(mkdtempSync(join(tmpdir(), 'auto-')))
	await store.load()
	await store.update((d) => {
		d.repos.r = { repoId: 'r', root: '/x', selectedBase: null, activeReviewId: null, reviews: { 'b..h1': review() }, aiRuns: {} }
	})
	const calls: Array<string> = []
	const records: Array<AutoReviewRecord> = []
	let enabled = true
	let busy = false
	const deps: AutoReviewDeps = {
		store,
		enabled: () => enabled,
		viewer: () => 'me',
		reviewer: () => ({ choice: { kind: 'model', selection: { connectionId: 'c', modelId: 'model-x' } }, label: 'model-x' }),
		levels: () => ['blocking', 'should_fix', 'question'],
		busy: () => busy,
		runsFor: () => store.read().repos.r.aiRuns['b..h1'] ?? [],
		whenDone: () => Promise.resolve(run(findings)),
		open: async () => {
			calls.push('open')
			return { id: 'b..h1', headSha: 'h1' } as Comparison
		},
		start: async () => {
			calls.push('start')
			await store.update((d) => void (d.repos.r.aiRuns['b..h1'] = [run(findings)]))
			return run(findings, 'running')
		},
		addFindings: async () => {
			calls.push('add')
			await store.update((d) => {
				d.repos.r.reviews['b..h1'].comments = findings.map((f) => ({
					id: `c-${f.id}`,
					anchor,
					body: '',
					createdAt: 't',
					updatedAt: 't',
					findingId: f.id,
				}))
			})
			return findings.map((f) => `c-${f.id}`)
		},
		plan: async () => plan(),
		publish: async (_r, _id, commentId) => {
			calls.push(`publish ${commentId}`)
			return { commentId, status: 'published', message: null, url: 'x' }
		},
		submit: async (_r, _id, ev: ReviewEvent) => {
			calls.push(`submit ${ev}`)
			return { id: 'rv', url: 'https://github.com/review', commit: 'h1', state: 'submitted', event: ev, submittedAt: 't' }
		},
		checks: async () => green,
		reviewChanged: () => calls.push('changed'),
		finished: (_e, r) => records.push(r),
		waitMs: 1,
		ciPollMs: 1,
		ciWaitMs: 50,
		...over,
	}
	const auto = new AutoReviewer(deps)
	return { auto, store, calls, records, set: { enabled: (v: boolean) => (enabled = v), busy: (v: boolean) => (busy = v) } }
}

test('a new request is reviewed, its findings published, and the verdict submitted; the head is not reviewed twice', async () => {
	const { auto, store, calls, records } = await setup()
	auto.take([event()])
	await auto.idle()
	assert.deepEqual(calls, ['open', 'start', 'add', 'changed', 'publish c-f1', 'submit REQUEST_CHANGES'])
	assert.equal(records[0].outcome, 'changes-requested')
	assert.equal(records[0].url, 'https://github.com/review')
	assert.equal(store.read().autoReviews?.['octo/app#7']?.head, 'h1')

	auto.take([event({}, 're-requested')])
	await auto.idle()
	assert.equal(calls.filter((c) => c === 'open').length, 1, 'the same head is never reviewed again')
})

test('only new requests, re-requests and drafts marked ready, never your own, drafts or new commits; nothing when off', async () => {
	const { auto, calls, set } = await setup()
	auto.take([event({}, 'updated'), event({ draft: true }), event({ author: 'ME' })])
	await auto.idle()
	assert.deepEqual(calls, [])
	set.enabled(false)
	auto.take([event()])
	await auto.idle()
	assert.deepEqual(calls, [], 'automatic review is off')
})

test('a pending review of yours on GitHub is never submitted for you', async () => {
	const { auto, calls, records } = await setup({
		plan: async () => plan({ pending: { kind: 'other', url: 'p', commit: 'h1', usable: true, comments: 2 } }),
	})
	auto.take([event()])
	await auto.idle()
	assert.deepEqual(calls, ['open'])
	assert.equal(records[0].outcome, 'skipped')
	assert.match(records[0].message, /pending review/)
})

test('a run that fails posts nothing; turning it off before posting posts nothing', async () => {
	const failed = await setup({}, [])
	failed.auto['d'].whenDone = () => Promise.resolve(run([], 'failed'))
	failed.auto['d'].start = async () => {
		await failed.store.update((d) => void (d.repos.r.aiRuns['b..h1'] = [{ ...run([], 'failed'), errors: ['rate limited'] }]))
		return run([], 'running')
	}
	failed.auto.take([event()])
	await failed.auto.idle()
	assert.equal(failed.records[0].outcome, 'failed')
	assert.match(failed.records[0].message, /rate limited.*Nothing was posted/)

	const off = await setup()
	off.auto['d'].whenDone = () => {
		off.set.enabled(false)
		return Promise.resolve(run([]))
	}
	off.auto.take([event()])
	await off.auto.idle()
	assert.ok(!off.calls.some((c) => c.startsWith('publish') || c.startsWith('submit')))
	assert.equal(off.records[0].outcome, 'skipped')
})

test('waits for an AI review you are running, including one started between the check and the start', async () => {
	let busyStarts = 1
	const s = await setup()
	const start = s.auto['d'].start
	s.auto['d'].start = async (...a) => {
		if (busyStarts-- > 0) throw new AppFail('ai-busy', 'An AI review is already running.')
		return start(...a)
	}
	s.set.busy(true)
	s.auto.take([event()])
	await new Promise((r) => setTimeout(r, 10))
	assert.deepEqual(s.calls, [], 'nothing starts while your run is going')
	s.set.busy(false)
	await s.auto.idle()
	assert.equal(s.records[0].outcome, 'changes-requested')
})

test('verdict: CI must have finished without a failure to approve; a failure is named in a comment', () => {
	const clean = run([])
	const failed = autoVerdict(
		clean,
		review(),
		[clean],
		0,
		who,
		ciWith({
			failed: [
				{ name: 'unit', at: 't' },
				{ name: 'e2e', at: null },
			],
		}),
	)
	assert.equal(failed.event, 'COMMENT')
	assert.equal(failed.ciStopped, 'failed')
	assert.match(failed.body, /no blocking, should-fix or question findings.*CI failed on this commit \(unit and 1 more\)/s)

	const pending = autoVerdict(clean, review(), [clean], 0, who, ciWith({ pending: ['feature'] }))
	assert.equal(pending.event, 'COMMENT')
	assert.equal(pending.ciStopped, 'pending')
	assert.match(pending.body, /CI had not finished/)

	const unreadable = autoVerdict(clean, review(), [clean], 0, who, null)
	assert.equal(unreadable.event, 'COMMENT', 'never approves without knowing what CI says')
	assert.match(unreadable.body, /could not be read/)

	const blocking = run([finding('f1', { severity: 'blocking' })])
	const b = autoVerdict(blocking, review(), [blocking], 1, who, ciWith({ pending: ['feature'] }))
	assert.equal(b.event, 'REQUEST_CHANGES')
	assert.equal(b.ciStopped, null, 'CI only matters when it is all that stands in the way of an approval')
})

test('waits for unfinished CI before approving, and approves once it passes', async () => {
	let reads = 0
	const { auto, calls, records } = await setup({ checks: async () => (++reads < 3 ? ciWith({ pending: ['feature'] }) : green) }, [])
	auto.take([event()])
	await auto.idle()
	assert.ok(reads >= 3, 'CI was read again while it was running')
	assert.deepEqual(calls.slice(-1), ['submit APPROVE'])
	assert.equal(records[0].outcome, 'approved')
})

test('CI that is still running when the wait ends, or that failed, gets a comment instead of an approval', async () => {
	const slow = await setup({ checks: async () => ciWith({ pending: ['feature'] }) }, [])
	slow.auto.take([event()])
	await slow.auto.idle()
	assert.deepEqual(slow.calls.slice(-1), ['submit COMMENT'])

	const red = await setup({ checks: async () => ciWith({ failed: [{ name: 'unit', at: 't' }] }) }, [])
	red.auto.take([event()])
	await red.auto.idle()
	assert.deepEqual(red.calls.slice(-1), ['submit COMMENT'])
	assert.equal(red.records[0].outcome, 'commented')
})

test('a budget pauses an automatic review: told once, taken again later, and reviewed once the budget allows', async () => {
	let over = true
	const { auto, store, calls, records } = await setup({
		start: async () => {
			calls.push('start')
			if (over) throw new AppFail('over-budget', "$5.00 spent: today's budget of $5.00 is reached.")
			await store.update((d) => void (d.repos.r.aiRuns['b..h1'] = [run([])]))
			return run([], 'running')
		},
	})
	auto.take([event()])
	await auto.idle()
	assert.equal(records.length, 1)
	assert.equal(records[0].outcome, 'paused')
	assert.match(records[0].message, /paused: \$5.00 spent: today's budget/)
	const saved = store.read().autoReviews?.['octo/app#7']
	assert.equal(saved?.head, '', 'the head is not marked reviewed')
	assert.equal(saved?.waiting?.pr.number, 7)

	auto.resumePaused()
	await auto.idle()
	assert.equal(calls.filter((c) => c === 'start').length, 2)
	assert.equal(records.length, 1, 'still over: not told again')

	over = false
	auto.resumePaused()
	await auto.idle()
	assert.notEqual(records.at(-1)?.outcome, 'paused')
	assert.ok(
		calls.some((c) => c.startsWith('submit')),
		'reviewed and submitted once the budget allowed',
	)
	assert.equal(store.read().autoReviews?.['octo/app#7']?.waiting, undefined)
	auto.resumePaused()
	await auto.idle()
	assert.equal(calls.filter((c) => c === 'start').length, 3, 'nothing is waiting any more')
})
