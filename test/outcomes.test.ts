import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summarizeOutcomes } from '../src/main/ai/outcomes.ts'
import type { RepoState } from '../src/main/store.ts'
import type { AiRun, Finding, OutcomeFilter, Review, RunMember } from '../src/shared/types.ts'

const NOW = new Date('2026-10-23T12:00:00Z')
const ALL: OutcomeFilter = { period: 'all', repoId: null, promptVersion: null, group: null, model: null }
const anchor = {
	repoId: 'r',
	baseSha: 'b',
	headSha: 'h',
	fileKey: 'a.ts',
	oldPath: null,
	newPath: 'a.ts',
	side: 'new',
	startLine: 1,
	endLine: 1,
	excerpt: '',
}

const finding = (id: string, more: Partial<Finding> = {}): Finding =>
	({
		id,
		runId: '',
		excerptId: 'E1',
		anchor,
		severity: 'should_fix',
		title: id,
		evidence: '',
		repeatOf: null,
		category: 'bug',
		...more,
	}) as Finding

const run = (id: string, findings: Array<Finding>, more: Partial<AiRun> = {}): AiRun =>
	({
		id,
		reviewId: 'rev1',
		repoId: 'r',
		provider: 'openai',
		providerLabel: 'OpenAI',
		connectionId: 'c1',
		connectionLabel: 'OpenAI',
		model: 'gpt',
		fixture: false,
		promptVersion: 'v2',
		startedAt: '2026-10-20T10:00:00Z',
		findings,
		cost: { usd: 1, estimated: false, unpriced: false },
		...more,
	}) as AiRun

const review = (id: string, more: Partial<Review> = {}): Review =>
	({ id, repoId: 'r', comments: [], drafts: [], findingDecisions: {}, ...more }) as Review

const repo = (reviews: Array<Review>, runs: Record<string, Array<AiRun>>): RepoState =>
	({
		repoId: 'r',
		root: '/x/shop',
		githubRepo: 'owner/shop',
		reviews: Object.fromEntries(reviews.map((r) => [r.id, r])),
		aiRuns: runs,
	}) as RepoState

const comment = (findingId: string) => ({ id: `c-${findingId}`, anchor, body: '', createdAt: '', updatedAt: '', findingId })
const dismissed = (reason: 'wrong' | 'intended' | null, at = '2026-10-21T00:00:00Z') => ({
	status: 'dismissed' as const,
	decidedAt: at,
	reason,
})

const member = (id: string, model: string, connectionId: string, usd: number | null): RunMember =>
	({
		id,
		role: id,
		connectionId,
		connectionLabel: connectionId,
		provider: 'x',
		model,
		rules: [],
		status: 'completed',
		cost: usd === null ? null : { usd, estimated: false, unpriced: false },
	}) as RunMember

test('outcomes: a problem raised again by a re-run counts once, with the decision made on either finding', () => {
	const runs = [
		run('run1', [finding('f1'), finding('f2'), finding('f3', { category: 'convention' })]),
		run('run2', [finding('f1b', { repeatOf: 'f1' }), finding('f2b', { repeatOf: 'f2' })], { startedAt: '2026-10-21T10:00:00Z' }),
	]
	const rev = review('rev1', { comments: [comment('f1b')], findingDecisions: { f2: dismissed('wrong') } })
	const s = summarizeOutcomes([repo([rev], { rev1: runs })], ALL, NOW)
	assert.equal(s.total.raised, 3)
	assert.equal(s.total.accepted, 1)
	assert.equal(s.total.dismissed.wrong, 1)
	assert.equal(s.total.undecided, 1)
	assert.deepEqual(
		s.groups.map((g) => [g.key, g.counts.raised]),
		[
			['defect', 2],
			['design', 1],
		],
	)
	assert.deepEqual(s.cost, { usd: 2, estimated: false, unpriced: false })
	assert.equal(s.models[0].label, 'gpt')
	assert.equal(s.repos[0].label, 'owner/shop')
})

test('outcomes: your newest decision wins, and restoring a finding makes it undecided again', () => {
	const runs = [run('run1', [finding('f1'), finding('f2', { repeatOf: 'f1' })])]
	const rev = review('rev1', {
		findingDecisions: { f1: dismissed('wrong', '2026-10-21T00:00:00Z'), f2: { status: 'open', decidedAt: '2026-10-22T00:00:00Z' } },
	})
	const s = summarizeOutcomes([repo([rev], { rev1: runs })], ALL, NOW)
	assert.equal(s.total.undecided, 1)
	assert.equal(s.total.dismissed.wrong, 0)
})

test('outcomes: in a team, every member that reported the problem gets it once, also when folded under another', () => {
	const members = [member('m1', 'gpt', 'c1', 1), member('m2', 'claude', 'c2', 2), member('m3', 'gemini', 'c3', null)]
	const runs = [
		run(
			'run1',
			[
				finding('lead', { memberId: 'm1', alsoBy: ['m2'] }),
				finding('folded', { memberId: 'm3', mergedInto: 'lead' }),
				finding('own', { memberId: 'm2', category: 'misleading-name' }),
			],
			{ team: { id: 't1', name: 'Pair', members }, cost: null },
		),
	]
	const s = summarizeOutcomes([repo([review('rev1', { comments: [comment('lead')] })], { rev1: runs })], ALL, NOW)
	assert.equal(s.total.raised, 2)
	assert.equal(s.total.accepted, 1)
	const by = Object.fromEntries(s.models.map((m) => [m.label, [m.counts.raised, m.counts.accepted]]))
	assert.deepEqual(by, { gpt: [1, 1], claude: [2, 1], gemini: [1, 1] })
	assert.deepEqual(
		s.setups.map((x) => [x.label, x.detail, x.counts.raised]),
		[['Pair', 'Team', 2]],
	)
	// A member without a cost makes the team's cost a lower bound, not zero.
	assert.deepEqual(s.setups[0].cost, { usd: 3, estimated: false, unpriced: true })
	assert.deepEqual(s.models.find((m) => m.label === 'gemini')?.cost, { usd: 0, estimated: false, unpriced: true })
})

test('outcomes: carried findings and later snapshots are the same problem; only the run that raised it gets credit', () => {
	const from = { runId: 'run1', reviewId: 'rev1', headSha: 'h1' }
	const runs = {
		rev1: [run('run1', [finding('f1'), finding('f2')])],
		rev2: [
			run(
				'run2',
				[
					finding('f1', { carried: { from, decision: null, comment: null } }),
					finding('f2b', { previous: { from, findingId: 'f2', decision: null, comment: null, seen: [from] } }),
				],
				{ reviewId: 'rev2', model: 'claude', connectionId: 'c2', startedAt: '2026-10-22T10:00:00Z' },
			),
		],
	}
	// Decided in the newer snapshot only.
	const reviews = [review('rev1'), review('rev2', { findingDecisions: { f1: dismissed('intended') } })]
	const s = summarizeOutcomes([repo(reviews, runs)], ALL, NOW)
	assert.equal(s.total.raised, 2)
	assert.equal(s.total.dismissed.intended, 1)
	const by = Object.fromEntries(s.models.map((m) => [m.label, m.counts.raised]))
	assert.deepEqual(by, { gpt: 2, claude: 1 })
})

test('outcomes: probably fixed comes from a later snapshot, and a check that it still holds takes it back', () => {
	const from = { runId: 'run1', reviewId: 'rev1', headSha: 'h1' }
	const gone = (f: Finding, check?: 'holds' | 'wrong', state: 'fixed' | 'not-seen' = 'fixed') => ({
		finding: f,
		state,
		why: '',
		decision: null,
		comment: null,
		at: null,
		check: check ? { verdict: check, reason: '', level: null, checked: [], model: 'm' } : null,
	})
	const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => finding(id))
	const runs = {
		rev1: [run('run1', [a, b, c, d])],
		rev2: [
			run('run2', [], {
				reviewId: 'rev2',
				history: {
					from,
					baseMoved: false,
					rewritten: false,
					gone: [gone(a), gone(b, 'holds'), gone(c, 'wrong', 'not-seen'), gone(d, undefined, 'not-seen')],
				},
			}),
		],
	}
	const s = summarizeOutcomes([repo([review('rev1'), review('rev2')], runs)], ALL, NOW)
	assert.equal(s.total.raised, 4)
	assert.equal(s.total.fixed, 2) // a, and c once checked
})

test('outcomes: double-checks, failing tests and automatic reviews are counted apart', () => {
	const v = (verdict: 'holds' | 'wrong', error = false) => ({ verdict, reason: '', level: null, checked: [], model: 'm', error })
	const runs = [
		run('run1', [
			finding('f1', { verification: v('wrong') }),
			finding('f2', { verification: v('holds') }),
			finding('f3', { verification: v('wrong', true), reproducer: { path: 't.ts', code: 'x', asserts: '', model: 'm', at: '' } }),
		]),
		run('auto', [finding('f4')], { auto: true }),
		run('fixture', [finding('f5')], { fixture: true }),
	]
	const s = summarizeOutcomes([repo([review('rev1', { comments: [comment('f4')] })], { rev1: runs })], ALL, NOW)
	assert.equal(s.total.raised, 4)
	assert.equal(s.total.checked, 2)
	assert.equal(s.total.likelyWrong, 1)
	assert.equal(s.total.reproduced, 1)
	assert.equal(s.total.auto, 1)
	assert.equal(s.total.accepted, 0)
})

test('outcomes: filters by period, prompt version, group and model; a group filter leaves cost out', () => {
	const runs = [
		run('old', [finding('f1')], { startedAt: '2026-08-01T00:00:00Z', promptVersion: 'v1' }),
		run('new', [finding('f2'), finding('f3', { category: 'convention' })]),
		run('other', [finding('f4')], { model: 'claude', connectionId: 'c2' }),
	]
	const repos = [repo([review('rev1')], { rev1: runs })]
	assert.equal(summarizeOutcomes(repos, { ...ALL, period: '30d' }, NOW).total.raised, 3)
	assert.equal(summarizeOutcomes(repos, { ...ALL, promptVersion: 'v1' }, NOW).total.raised, 1)
	const design = summarizeOutcomes(repos, { ...ALL, group: 'design' }, NOW)
	assert.equal(design.total.raised, 1)
	assert.equal(design.cost, null)
	assert.ok(design.models.every((m) => m.cost === null))
	const claude = summarizeOutcomes(repos, { ...ALL, model: 'c2\u0000claude' }, NOW)
	assert.equal(claude.total.raised, 1)
	assert.deepEqual(
		claude.models.map((m) => m.label),
		['claude'],
	)
	assert.deepEqual(claude.cost, { usd: 1, estimated: false, unpriced: false })
	// The filter lists stay whole, so you can switch back.
	assert.equal(claude.allModels.length, 2)
	assert.deepEqual(claude.promptVersions, ['v2', 'v1'])
	assert.equal(summarizeOutcomes(repos, { ...ALL, repoId: 'elsewhere' }, NOW).total.raised, 0)
})
