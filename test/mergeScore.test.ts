import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bandOf, dataScore, finalScore, recordText, trackRecord, wilson, worstFix, type MergeInput } from '../src/shared/mergeScore.ts'
import type { FixLevel, MergeOutcome } from '../src/shared/types.ts'

const none: MergeInput = { findings: [], ci: undefined, others: undefined, hidden: 0, drift: null, risk: null }
const ci = (failed: Array<{ name: string; atBase?: 'fails' | 'passes' | null }>, pending: Array<string> = []) => ({
	sha: 'abc',
	failed: failed.map((f) => ({ at: null, ...f })),
	pending,
	passed: 3,
	omitted: 0,
	readAt: '2026-11-27T10:00:00Z',
})

test('nothing found and nothing open is 100, with nothing deducted', () => {
	assert.deepEqual(dataScore(none), { score: 100, parts: [] })
})

test('findings cost by level; data loss and high-risk files cost more; minor levels cost nothing', () => {
	const r = dataScore({
		...none,
		findings: [
			{ title: 'Wrong total', severity: 'blocking', losesData: false, fileRisk: null },
			{ title: 'Drops rows', severity: 'blocking', losesData: true, fileRisk: null },
			{ title: 'Token leak', severity: 'blocking', losesData: false, fileRisk: 'high' },
			{ title: 'Missing guard', severity: 'should_fix', losesData: false, fileRisk: null },
			{ title: 'Typo', severity: 'nit', losesData: false, fileRisk: 'high' },
			{ title: 'Old bug', severity: 'pre_existing', losesData: false, fileRisk: null },
		],
	})
	assert.deepEqual(
		r.parts.map((p) => [p.points, p.label, p.detail]),
		[
			[-75, '2 blocking findings', ['Wrong total', 'Token leak (high-risk file)']],
			[-40, '1 blocking finding that loses data', ['Drops rows']],
			[-8, '1 should-fix finding', ['Missing guard']],
		],
	)
	assert.equal(r.score, 0, 'never below 0')
})

test('CI: a new failure costs more than one the base branch has too; unreadable is listed but costs nothing', () => {
	const r = dataScore({ ...none, ci: ci([{ name: 'unit' }, { name: 'lint', atBase: 'fails' }], ['e2e']) })
	assert.deepEqual(
		r.parts.map((p) => [p.points, p.label]),
		[
			[-25, '1 CI check failed'],
			[-5, '1 CI check failed, also on the base branch'],
			[-10, '1 CI check not finished'],
		],
	)
	assert.equal(r.score, 60)
	assert.deepEqual(dataScore({ ...none, ci: null }), { score: 100, parts: [{ points: 0, label: "CI couldn't be read", detail: [] }] })
})

test("other reviewers' concerns, hidden characters, drift and a risky area; thread and bot deductions are capped", () => {
	const r = dataScore({ ...none, others: { changes: 1, threads: 5, bots: 3 }, hidden: 2, drift: 4, risk: 'high' })
	assert.deepEqual(
		r.parts.map((p) => p.points),
		[-15, -15, -10, -10, -5, -10],
	)
	assert.equal(r.score, 35)
	assert.equal(dataScore({ ...none, risk: 'low', drift: 0 }).score, 100)
})

test('the same state always gives the same score', () => {
	const input: MergeInput = { ...none, findings: [{ title: 'x', severity: 'should_fix', losesData: false, fileRisk: 'medium' }], hidden: 1 }
	assert.deepEqual(dataScore(input), dataScore(structuredClone(input)))
})

test("the AI's move from the data score it saw is carried onto the data as it is now, within 0–100", () => {
	assert.equal(finalScore(70, { data: 70, ai: 55 }), 55)
	assert.equal(finalScore(80, { data: 70, ai: 55 }), 65, 'CI passed since: the data rose by 10, so does the final score')
	assert.equal(finalScore(10, { data: 70, ai: 55 }), 0)
	assert.equal(finalScore(95, { data: 60, ai: 90 }), 100)
})

const outcome = (score: number, levels: Array<FixLevel | null | 'revert'>, done = true, final: number | null = null): MergeOutcome => ({
	score: { head: 'h', data: score, final, at: '2026-11-01T00:00:00Z' },
	until: '2026-12-01T00:00:00Z',
	done,
	lines: {},
	fixes: levels.map((l, i) => ({
		sha: `c${i}`,
		subject: 's',
		at: '2026-11-05T00:00:00Z',
		reverted: l === 'revert',
		level: l === 'revert' ? 'blocking' : l,
		why: null,
	})),
})

test('the worst fix decides; nothing that was a fix is "none"; unfinished or unjudged is not settled', () => {
	assert.equal(worstFix(outcome(80, [])), 'none')
	assert.equal(worstFix(outcome(80, ['not-a-fix', 'minor'])), 'minor')
	assert.equal(worstFix(outcome(80, ['minor', 'should_fix', 'not-a-fix'])), 'should_fix')
	assert.equal(worstFix(outcome(80, ['revert'])), 'blocking')
	assert.equal(worstFix(outcome(80, ['minor', null])), null, 'a change not judged yet')
	assert.equal(worstFix(outcome(80, [], false)), null, 'the 30 days have not passed')
})

test('bands are tens, with 100 in the top one', () => {
	assert.deepEqual(
		[bandOf(0), bandOf(79), bandOf(90), bandOf(100)],
		[
			[0, 9],
			[70, 79],
			[90, 100],
			[90, 100],
		],
	)
})

test('the likely range narrows as merged pull requests add up', () => {
	const [lo, hi] = wilson(3, 30)
	assert.ok(lo > 0.03 && lo < 0.04 && hi > 0.25 && hi < 0.27, `${lo} ${hi}`)
	const [lo2, hi2] = wilson(30, 300)
	assert.ok(hi2 - lo2 < hi - lo)
	assert.deepEqual(wilson(0, 0), [0, 1])
})

test('track record: counts by worst fix in the band, banded by the score shown; falls back to all repositories below 10', () => {
	const here = [
		...Array.from({ length: 7 }, () => outcome(75, [])),
		outcome(72, ['minor']),
		outcome(78, ['should_fix', 'minor']),
		outcome(40, ['revert'], true, 71), // the AI's score is the one that was shown
		outcome(85, ['blocking']), // another band
		outcome(75, [null]), // not settled
	]
	const r = trackRecord(74, here, here)
	assert.deepEqual(
		{ ...r, range: null },
		{ band: [70, 79], scope: 'repo', followed: 10, blocking: 1, shouldFix: 1, minorOnly: 1, range: null },
	)
	assert.deepEqual(r.range, wilson(2, 10))
	assert.equal(
		recordText(r),
		'Of 10 merged pull requests here that scored 70–79, 2 needed a fix within 30 days (20%, likely 6%–51%): 1 blocking, 1 should fix. 1 more needed only minor fixes.',
	)

	const few = trackRecord(74, here.slice(0, 3), here)
	assert.equal(few.scope, 'all', 'too few here: every repository')
	assert.equal(few.followed, 10)
	const none = trackRecord(74, [], here.slice(0, 3))
	assert.deepEqual([none.scope, none.followed, none.range], ['all', 3, null])
	assert.equal(
		recordText(none),
		'No track record for scores of 70–79 yet: 3 of 10 merged pull requests in all your repositories followed for 30 days.',
	)
	assert.equal(trackRecord(74, [], []).scope, 'repo', 'nothing anywhere: said about this repository')
})
