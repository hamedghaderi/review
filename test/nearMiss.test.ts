import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseNearMissCheck, pickNearMisses, type NearMissCandidate } from '../src/main/ai/nearMiss.ts'
import type { ContextExcerpt } from '../src/main/ai/context.ts'
import type { Comparison, RuleEvaluation } from '../src/shared/types.ts'

const ev = (rule: RuleEvaluation['rule'], checkedBy: string | null, misses: Array<[string, number | null, string]>): RuleEvaluation => ({
	rule,
	requests: 1,
	checkedBy,
	why: [],
	nearMisses: misses.map(([fileKey, line, note]) => ({ fileKey, line, note, excerptId: 'E1' })),
})

const risky = (k: string) => (k.startsWith('src/') ? 'high' : 'low')

test('picks correctness near misses on high-risk files, bugs first, one per place, and skips settled ones', () => {
	const picked = pickNearMisses(
		[
			ev('security', 's', [['src/a.ts', 3, 'escaped by the template']]),
			ev('performance', 'd', [['src/a.ts', 9, 'one query per page']]),
			ev('bug', 'd', [
				['src/a.ts', 3, 'guarded above'],
				['docs/x.md', 1, 'low risk'],
				['src/b.ts', null, 'no line'],
				['src/c.ts', 5, 'raised in T2, answered as intended'],
			]),
			ev('bug', 'o', [['src/a.ts', 3, 'same place, another member']]),
			ev('error-handling', 'd', [['src/b.ts', 7, 'the caller retries']]),
		],
		risky,
	)
	assert.deepEqual(
		picked.map((c) => [c.rule, c.miss.fileKey, c.miss.line, c.raiserId]),
		[
			['bug', 'src/a.ts', 3, 'd'],
			['error-handling', 'src/b.ts', 7, 'd'],
		],
	)
	const many = ev(
		'bug',
		null,
		Array.from({ length: 10 }, (_, i) => [`src/f${i}.ts`, 1, 'fine'] as [string, number, string]),
	)
	assert.equal(pickNearMisses([many], risky).length, 6)
})

const excerpt: ContextExcerpt = {
	id: 'E1',
	file: {
		key: 'src/a.ts',
		status: 'modified',
		oldPath: 'src/a.ts',
		newPath: 'src/a.ts',
		additions: 1,
		deletions: 0,
		binary: false,
		similarity: null,
	},
	lines: [
		{ kind: 'ctx', oldNo: 1, newNo: 1, text: 'function refund(order) {' },
		{ kind: 'add', oldNo: null, newNo: 2, text: '  payments.refund(order.total)' },
		{ kind: 'ctx', oldNo: 2, newNo: 3, text: '}' },
	],
	old: { start: 1, end: 2 },
	new: { start: 1, end: 3 },
	anchorable: { old: new Set([1, 2]), new: new Set([1, 2, 3]) },
	text: '',
} as unknown as ContextExcerpt
const comparison = { repoId: 'r', baseSha: 'a', headSha: 'b' } as Comparison
const candidate: NearMissCandidate = { rule: 'bug', miss: { fileKey: 'src/a.ts', line: 2, note: 'fine', excerptId: 'E1' }, raiserId: 'd' }
const finding = (over: Record<string, unknown> = {}) => ({
	excerpt_id: 'E1',
	file_path: 'src/a.ts',
	side: 'new',
	start_line: 2,
	end_line: 2,
	category: 'bug',
	signature: null,
	test_pattern: null,
	severity: 'should_fix',
	title: 'A retried request refunds the order twice',
	body: 'A customer can get the same refund twice.',
	reasoning: 'Nothing records that the refund was sent.',
	disproof: null,
	background: null,
	evidence: 'payments.refund(order.total)',
	raised_before: null,
	...over,
})
const answer = (f: unknown) => ({ verdict: 'problem', reason: 'Traced it.', checked: ['src/a.ts:1-3'], finding: f })

test('a "problem" becomes a finding only when it is a valid correctness finding on the excerpt; otherwise it reads as unsure', () => {
	const ok = parseNearMissCheck(answer(finding()), candidate, excerpt, comparison, 'run', ['should_fix'])
	assert.equal(ok.verdict, 'problem')
	assert.deepEqual(ok.finding?.fromNearMiss, { rule: 'bug', note: 'fine', memberId: 'd' })

	const cases: Array<[unknown, RegExp]> = [
		[null, /did not describe it as a finding/],
		[finding({ category: 'convention' }), /only bugs, error handling and security/],
		[finding({ evidence: 'not in the file' }), /Evidence is not found verbatim/],
	]
	for (const [f, why] of cases) {
		const r = parseNearMissCheck(answer(f), candidate, excerpt, comparison, 'run', ['should_fix'])
		assert.equal(r.verdict, 'unsure')
		assert.equal(r.finding, null)
		assert.match(r.rejected ?? '', why)
	}
	assert.throws(
		() => parseNearMissCheck({ verdict: 'maybe' }, candidate, excerpt, comparison, 'run', ['should_fix']),
		/near-miss check schema/,
	)
})
