import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summarizeReviews } from '../src/main/github.ts'
import { reviewSummary } from '../src/renderer/src/reviewState.ts'

const HEAD = 'h'.repeat(40)
const OLD = 'o'.repeat(40)
const r = (login: string | null, state: string, at: string, commit = HEAD) => ({ login, state, at, commit })

test('each person keeps their standing review: a later comment does not undo an approval; dismissals, author and pending are handled', () => {
	const s = summarizeReviews(
		[
			r('alice', 'APPROVED', '2026-01-01', OLD),
			r('alice', 'COMMENTED', '2026-01-03'), // still approved, on the older commit
			r('bob', 'APPROVED', '2026-01-01'),
			r('bob', 'CHANGES_REQUESTED', '2026-01-02'),
			r('carol', 'COMMENTED', '2026-01-02'),
			r('dave', 'DISMISSED', '2026-01-02'),
			r('erin', 'PENDING', '2026-01-02'),
			r('author', 'COMMENTED', '2026-01-02'),
			r(null, 'APPROVED', '2026-01-02'),
		],
		HEAD,
		'author',
		'CHANGES_REQUESTED',
	)
	assert.equal(s.decision, 'changes-requested')
	assert.deepEqual(
		s.reviewers.map((x) => [x.login, x.verdict, x.stale]),
		[
			['bob', 'changes-requested', false],
			['alice', 'approved', true],
			['carol', 'commented', false],
			['dave', 'dismissed', false],
		],
	)
})

test('badge: GitHub decision first, then the reviews; older-commit approvals, partial approvals and your own review', () => {
	const st = (decision: string | null, rows: Array<ReturnType<typeof r>>) => summarizeReviews(rows, HEAD, 'author', decision)
	const label = (decision: string | null, rows: Array<ReturnType<typeof r>>, viewer: string | null = null) =>
		reviewSummary(st(decision, rows), viewer)?.label ?? null

	assert.equal(label('APPROVED', [r('a', 'APPROVED', '1'), r('b', 'APPROVED', '2')]), 'Approved ×2')
	assert.equal(
		label(null, [r('a', 'APPROVED', '1')], 'A'),
		'Approved · you approved',
		'no rules: the reviews decide; login match ignores case',
	)
	assert.equal(label(null, [r('a', 'APPROVED', '1', OLD)]), 'Approved (older commit)')
	assert.equal(label(null, [r('a', 'CHANGES_REQUESTED', '1', OLD)]), 'Changes requested', 'a change request stands after new commits')
	assert.equal(label('REVIEW_REQUIRED', [r('a', 'APPROVED', '1')]), '1 approval, more required')
	assert.equal(label(null, [r('a', 'COMMENTED', '1')], 'a'), 'Reviewed · you commented')
	assert.equal(label('REVIEW_REQUIRED', []), 'Review required')
	assert.equal(label(null, []), null, 'nothing to show')
	assert.match(reviewSummary(st(null, [r('a', 'APPROVED', '2026-01-05', OLD)]), null)!.title, /a: approved on an older commit/)
})
