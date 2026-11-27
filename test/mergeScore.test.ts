import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dataScore, finalScore, type MergeInput } from '../src/shared/mergeScore.ts'

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
