import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AutoReviewer, autoVerdict, othersConcerns, type AutoReviewDeps } from '../src/main/autoReview.ts'
import { AppFail } from '../src/main/git.ts'
import type { RepoEvent } from '../src/main/inboxWatch.ts'
import { ReviewStore } from '../src/main/store.ts'
import type { HeadChecks } from '../src/shared/ci.ts'
import type {
	AiRun,
	AutoReviewRecord,
	Comparison,
	Discussion,
	DiscussionComment,
	DiscussionReview,
	DiscussionThread,
	Finding,
	PreparedReview,
	PublishPlan,
	Review,
	ReviewEvent,
} from '../src/shared/types.ts'

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
	return {
		id: 'run1',
		reviewId: 'b..h1',
		repoId: 'r',
		headSha: 'h1',
		status,
		findings,
		errors: [],
		providerLabel: 'P',
		model: 'm',
	} as unknown as AiRun
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
		pr: { repo: 'Octo/App', number: 7, url: 'u', headSha: 'h1', state: 'open', autoMerge: null },
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
		commits: () => false,
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
		startIncremental: async () => {
			calls.push('start incremental')
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
		quietMs: 20,
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

test('new commits pushed during the run, or a head that cannot be read, get a comment instead of an approval', async () => {
	let plans = 0
	const bodies: Array<string> = []
	const submit: AutoReviewDeps['submit'] = async (_r, _id, ev, body) => {
		bodies.push(body)
		return { id: 'rv', url: 'u', commit: 'h1', state: 'submitted', event: ev, submittedAt: 't' }
	}
	// The first plan is read before the run (head h1); the last one, right before submitting, sees h2.
	const pushed = await setup({ plan: async () => plan(++plans > 1 ? { pr: { ...plan().pr, headSha: 'h2' } } : {}), submit }, [])
	pushed.auto.take([event()])
	await pushed.auto.idle()
	assert.equal(pushed.records[0].outcome, 'commented')
	assert.match(bodies[0], /It reviewed h1, and newer commits \(up to h2\) were pushed since, so this is not an approval\./)

	let reads = 0
	const unreadable = await setup(
		{
			plan: async () => {
				if (++reads > 1) throw new AppFail('github-failed', 'GitHub is down')
				return plan()
			},
		},
		[],
	)
	unreadable.auto.take([event()])
	await unreadable.auto.idle()
	assert.equal(unreadable.records[0].outcome, 'commented', 'an unknown head is not approved either')

	// Findings that request changes still do: they are about the commit they name.
	const r = run([finding('f1', { severity: 'blocking' })])
	assert.equal(autoVerdict(r, review(), [r], 1, who, green, { head: 'h2', autoMerge: null }).event, 'REQUEST_CHANGES')
	const same = autoVerdict(run([]), review(), [run([])], 0, who, green, { head: 'h1', autoMerge: null })
	assert.equal(same.event, 'APPROVE', 'the same head is approved')
})

test('auto-merge or a place in the merge queue gets a comment instead of an approval, since approving could merge it', async () => {
	const bodies: Array<string> = []
	const submit: AutoReviewDeps['submit'] = async (_r, _id, ev, body) => {
		bodies.push(body)
		return { id: 'rv', url: 'u', commit: 'h1', state: 'submitted', event: ev, submittedAt: 't' }
	}
	const merging = await setup({ plan: async () => plan({ pr: { ...plan().pr, autoMerge: 'auto-merge' } }), submit }, [])
	merging.auto.take([event()])
	await merging.auto.idle()
	assert.equal(merging.records[0].outcome, 'commented')
	assert.match(
		bodies[0],
		/Auto-merge is on, so an approval could merge it without a person checking first\. This is not an approval; me can approve it\./,
	)

	const clean = run([])
	const queued = autoVerdict(clean, review(), [clean], 0, who, green, { head: 'h1', autoMerge: 'merge-queue' })
	assert.equal(queued.event, 'COMMENT')
	assert.match(queued.body, /It is in the merge queue/)
	// Blocking findings still request changes: that never merges anything.
	const b = run([finding('f1', { severity: 'blocking' })])
	assert.equal(autoVerdict(b, review(), [b], 1, who, green, { head: 'h1', autoMerge: 'auto-merge' }).event, 'REQUEST_CHANGES')
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

test('a budget already reached pauses an automatic review before anything is fetched; with none reached it goes as before', async () => {
	const paused = await setup({ budgetReached: () => "$5.00 spent: today's budget of $5.00 is reached." })
	paused.auto.take([event()])
	await paused.auto.idle()
	assert.deepEqual(paused.calls, [], 'the pull request is not opened')
	assert.equal(paused.records[0].outcome, 'paused')
	assert.equal(paused.store.read().autoReviews?.['octo/app#7']?.waiting?.pr.number, 7)

	const free = await setup({ budgetReached: () => null })
	free.auto.take([event()])
	await free.auto.idle()
	assert.deepEqual(free.calls, ['open', 'start', 'add', 'changed', 'publish c-f1', 'submit REQUEST_CHANGES'])
})

const settle = () => new Promise((r) => setTimeout(r, 60))

/** A pull request the automatic review submitted a review for at h1, now with new commits at `head`. */
async function reviewedBefore(over: Partial<AutoReviewDeps> = {}, head: () => string = () => 'h2') {
	const s = await setup({ commits: () => true, ...over })
	const open = s.auto['d'].open
	s.auto['d'].open = async (...a) => ({ ...(await open(...a)), headSha: head() })
	await s.store.update((d) => {
		d.autoReviews = { 'octo/app#7': { head: 'h1', at: 't', reviewId: 'b..h1', outcome: 'commented', message: '', url: 'u' } }
	})
	return s
}

test('new commits on a pull request it reviewed are reviewed incrementally once the head settles, and submitted', async () => {
	const { auto, store, calls, records } = await reviewedBefore()
	auto.take([event({ head: 'h2', reviewed: true }, 'updated')])
	await auto.idle()
	assert.deepEqual(calls, [], 'nothing starts while the head may still move')
	await settle()
	await auto.idle()
	assert.deepEqual(calls, ['open', 'start incremental', 'add', 'changed', 'publish c-f1', 'submit REQUEST_CHANGES'])
	assert.equal(records[0].commits, true)
	assert.equal(store.read().autoReviews?.['octo/app#7']?.head, 'h2')
})

test('a series of pushes is reviewed once, at the newest head', async () => {
	const { auto, calls } = await reviewedBefore({}, () => 'h3')
	auto.take([event({ head: 'h2', reviewed: true }, 'updated')])
	await new Promise((r) => setTimeout(r, 10))
	auto.take([event({ head: 'h3', reviewed: true }, 'updated')])
	await settle()
	await auto.idle()
	assert.equal(calls.filter((c) => c === 'open').length, 1)
	assert.equal(calls.filter((c) => c === 'start incremental').length, 1)
})

test('new commits are left alone with the setting off, or when no automatic review was submitted for the pull request', async () => {
	const off = await reviewedBefore({ commits: () => false })
	off.auto.take([event({ head: 'h2', reviewed: true }, 'updated')])
	await settle()
	await off.auto.idle()
	assert.deepEqual(off.calls, [])

	const mine = await setup({ commits: () => true })
	mine.auto.take([event({ head: 'h2', reviewed: true }, 'updated')])
	await settle()
	await mine.auto.idle()
	assert.deepEqual(mine.calls, [], 'you reviewed it yourself')
})

test('new commits that cannot be reviewed incrementally are skipped with the reason, and later pushes are still followed', async () => {
	let head = 'h2'
	const s = await reviewedBefore({}, () => head)
	const { auto, calls, records } = s
	s.auto['d'].startIncremental = async () => {
		calls.push('start incremental')
		return { refused: 'Every file changed since the run on h1.' }
	}
	auto.take([event({ head: 'h2', reviewed: true }, 'updated')])
	await settle()
	await auto.idle()
	assert.ok(!calls.includes('start'), 'never falls back to a full run')
	assert.equal(records[0].outcome, 'skipped')
	assert.match(records[0].message, /Every file changed since the run on h1/)

	head = 'h3'
	auto.take([event({ head: 'h3', reviewed: true }, 'updated')])
	await settle()
	await auto.idle()
	assert.equal(calls.filter((c) => c === 'start incremental').length, 2)
})

test('verdict: an incremental run says which commits it covered and how many files carried over', () => {
	const r = {
		...run([]),
		carriedFrom: { runId: 'run0', reviewId: 'b..h0', headSha: 'abcdef123' },
		coverage: {
			files: [
				{ fileKey: 'a.ts', state: 'reviewed' },
				{ fileKey: 'b.ts', state: 'carried' },
				{ fileKey: 'c.ts', state: 'carried' },
			],
		},
	} as unknown as AiRun
	const v = autoVerdict(r, review(), [r], 0, who, green)
	assert.match(v.body, /commits since abcdef1.*2 files and their findings carry over/s)
})

const said = (author: string, body: string, o: Partial<DiscussionComment> = {}): DiscussionComment => ({
	id: `${author}:${body}`,
	author,
	association: 'MEMBER',
	body,
	bodyTruncated: false,
	createdAt: '2026-11-01T10:00:00Z',
	url: null,
	pending: false,
	...o,
})
const thread = (id: string, comments: Array<DiscussionComment>, o: Partial<DiscussionThread> = {}): DiscussionThread => ({
	id,
	path: 'a.ts',
	subject: 'line',
	side: 'new',
	resolved: false,
	resolvedBy: null,
	outdated: false,
	placed: null,
	unplaced: null,
	fileKey: 'a.ts',
	originalLine: 3,
	diffHunk: null,
	comments,
	commentsOmitted: 0,
	url: `https://github.com/octo/app/pull/7#${id}`,
	...o,
})
const reviewBy = (author: string, state: string, at: string, o: Partial<DiscussionReview> = {}): DiscussionReview => ({
	id: `${author}:${at}`,
	author,
	association: 'MEMBER',
	state,
	body: '',
	bodyTruncated: false,
	submittedAt: at,
	url: null,
	...o,
})
const discussionOf = (o: Partial<Discussion>): Discussion => ({
	status: 'complete',
	reason: null,
	fetchedAt: '',
	prHead: 'h1',
	threads: [],
	reviews: [],
	conversation: [],
	omitted: { threads: 0, comments: 0, reviews: 0, conversation: 0 },
	...o,
})

test("others' concerns: write access only; a standing change request, an unanswered thread, a bot comment not disproved", () => {
	const d = discussionOf({
		reviews: [
			reviewBy('alice', 'CHANGES_REQUESTED', '2026-11-01'),
			reviewBy('dave', 'CHANGES_REQUESTED', '2026-11-01'),
			reviewBy('dave', 'APPROVED', '2026-11-02'), // replaced by an approval
			reviewBy('erin', 'CHANGES_REQUESTED', '2026-11-01', { association: 'NONE' }), // no write access
			reviewBy('ci-bot', 'CHANGES_REQUESTED', '2026-11-01', { bot: true }),
			reviewBy('me', 'CHANGES_REQUESTED', '2026-11-01'), // the viewer
		],
		threads: [
			thread('T1', [said('carol', 'Why is this async?')]),
			thread('T2', [said('carol', 'Missing a test?'), said('bob', 'Added in the next commit.')]), // the author answered
			thread('T3', [said('frank', 'Typo?', { association: 'NONE' })]), // an outsider
			thread('T4', [said('carol', 'Old.')], { resolved: true }),
			thread('T5', [said('carol', 'Older.')], { outdated: true }),
			thread('T6', [said('coderabbitai', 'Null dereference here.', { bot: true, association: 'NONE' })]),
			thread('T7', [said('coderabbitai', 'Unused import.', { bot: true, association: 'NONE' })]),
		],
	})
	const check = (threadId: string, verdict: 'holds' | 'wrong') => ({
		threadId,
		bot: 'coderabbitai',
		verdict,
		reason: 'r',
		checked: [],
		model: 'm',
		memberId: null,
	})
	const o = othersConcerns(d, { viewer: 'me', author: 'bob', botChecks: [check('T6', 'holds'), check('T7', 'wrong')] })
	assert.deepEqual(
		o.changes.map((c) => c.login),
		['alice'],
	)
	assert.deepEqual(
		o.threads.map((t) => t.url?.split('#')[1]),
		['T1'],
	)
	assert.deepEqual(o.bots, [{ bot: 'coderabbitai', path: 'a.ts', url: 'https://github.com/octo/app/pull/7#T6' }])
})

test("an automatic review doesn't approve over others' open concerns, or when they can't be read; it names people without pinging them", async () => {
	const bodies: Array<string> = []
	const submit: AutoReviewDeps['submit'] = async (_r, _id, ev, body) => {
		bodies.push(body)
		return { id: 'rv', url: 'u', commit: 'h1', state: 'submitted', event: ev, submittedAt: 't' }
	}
	const changes = discussionOf({ reviews: [reviewBy('alice', 'CHANGES_REQUESTED', '2026-11-01T09:00:00Z')] })
	const held = await setup({ discussion: async () => changes, submit }, [])
	held.auto.take([event()])
	await held.auto.idle()
	assert.equal(held.records[0].outcome, 'commented')
	assert.match(bodies[0], /Not an approval while others' concerns are open: alice requested changes \(2026-11-01\)\./)
	assert.doesNotMatch(bodies[0], /@alice/)

	const unreadable = await setup({ discussion: async () => discussionOf({ status: 'unavailable' }), submit }, [])
	unreadable.auto.take([event()])
	await unreadable.auto.idle()
	assert.equal(unreadable.records[0].outcome, 'commented', 'unknown is not approved')
	assert.match(bodies[1], /The other reviewers' threads could not be read, so this is not an approval\./)

	const clear = await setup({ discussion: async () => discussionOf({}) }, [])
	clear.auto.take([event()])
	await clear.auto.idle()
	assert.equal(clear.records[0].outcome, 'approved')
})

test('Prepare mode: the findings stay in the app and the verdict waits in the review; nothing goes to GitHub, even with a pending review', async () => {
	const prepared: Array<PreparedReview> = []
	const added: Array<boolean | undefined> = []
	const p = await setup({
		submits: () => false,
		prepare: async (_r, _id, x) => void prepared.push(x),
		plan: async () => plan({ pending: { kind: 'other', url: 'p', commit: 'h1', usable: true, comments: 2 } }),
	})
	const addFindings = p.auto['d'].addFindings
	p.auto['d'].addFindings = (...a) => {
		added.push(a[4])
		return addFindings(...a)
	}
	p.auto.take([event()])
	await p.auto.idle()
	assert.ok(!p.calls.some((c) => c.startsWith('publish') || c.startsWith('submit')), p.calls.join(', '))
	assert.deepEqual(added, [true], 'its comments say "written by AI", not "posted automatically"')
	assert.equal(prepared.length, 1)
	assert.deepEqual([prepared[0].event, prepared[0].comments, prepared[0].head], ['REQUEST_CHANGES', 1, 'h1'])
	assert.match(prepared[0].body, /^🤖 This review was written by AI \(model-x, in the Review app\) and submitted by me\./)
	assert.equal(p.records[0].outcome, 'prepared')
	assert.equal(p.records[0].message, 'Prepared Octo/App#7: would request changes, with 1 comment. Open it to check and submit.')
})

/** A pull request automatic review already followed up `rounds` times, last with `outcome`. */
async function followedUp(
	rounds: number,
	outcome: AutoReviewRecord['outcome'],
	over: Partial<AutoReviewDeps> = {},
	findings?: Array<Finding>,
) {
	const s = await setup({ commits: () => true, ...over }, findings)
	const open = s.auto['d'].open
	s.auto['d'].open = async (...a) => ({ ...(await open(...a)), headSha: 'h2' })
	const history = Array.from({ length: rounds + 1 }, (_, i) => ({ head: `h0${i}`, at: 't', outcome, posted: 1, usd: 0.01 }))
	await s.store.update((d) => {
		d.autoReviews = {
			'octo/app#7': {
				head: 'h1',
				at: 't',
				reviewId: 'b..h1',
				outcome,
				message: '',
				url: 'u',
				commits: rounds > 0 || undefined,
				rounds: rounds || undefined,
				history,
			},
		}
	})
	return s
}

test('a follow-up with nothing new and the same verdict posts nothing and says nothing; an approval is given again', async () => {
	const red = async () => ciWith({ failed: [{ name: 'unit', at: 't' }] })
	const quiet = await followedUp(1, 'commented', { checks: red }, [])
	quiet.auto.take([event({ head: 'h2', reviewed: true }, 'updated')])
	await settle()
	await quiet.auto.idle()
	assert.ok(!quiet.calls.some((c) => c.startsWith('submit')), quiet.calls.join(', '))
	assert.deepEqual(quiet.records, [], 'no notification for a quiet round')
	const r = quiet.store.read().autoReviews!['octo/app#7']
	assert.deepEqual([r.outcome, r.rounds, r.history?.length], ['quiet', 2, 3])
	assert.match(r.message, /^Nothing new on Octo\/App#7 \(round 2\); the earlier review still stands, so nothing was posted\.$/)

	const approved = await followedUp(1, 'approved', {}, [])
	approved.auto.take([event({ head: 'h2', reviewed: true }, 'updated')])
	await settle()
	await approved.auto.idle()
	assert.deepEqual(approved.calls.slice(-1), ['submit APPROVE'], 'kept current where approvals on older commits are dismissed')
})

test('follow-ups stop after the limit, say so, and leave later commits alone until a new request starts over', async () => {
	const s = await followedUp(2, 'changes-requested')
	s.auto.take([event({ head: 'h2', reviewed: true }, 'updated')])
	await settle()
	await s.auto.idle()
	assert.deepEqual(s.calls.slice(-1), ['submit REQUEST_CHANGES'], 'a new blocking finding always posts')
	const r = s.store.read().autoReviews!['octo/app#7']
	assert.deepEqual([r.rounds, r.followLimit, r.stopped], [3, 3, true])
	assert.match(
		s.records[0].message,
		/Stopped following Octo\/App#7 after 3 rounds of new commits: 1 blocking finding still open\. Review new commits yourself, or ask for a review again to start over\.$/,
	)

	const before = s.calls.length
	s.auto.take([event({ head: 'h3', reviewed: true }, 'updated')])
	await settle()
	await s.auto.idle()
	assert.equal(s.calls.length, before, 'stopped: new commits are not reviewed')

	s.auto['d'].open = async () => ({ id: 'b..h1', headSha: 'h4' }) as Comparison
	s.auto.take([event({ head: 'h4' }, 're-requested')])
	await s.auto.idle()
	const fresh = s.store.read().autoReviews!['octo/app#7']
	assert.deepEqual([fresh.rounds, fresh.stopped, fresh.history?.length], [undefined, undefined, 1], 'a new request starts over')
})
