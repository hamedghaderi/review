import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Seen, seenInBatch, unreadRefs } from '../src/main/ai/citations.ts'
import type { ContextBatch } from '../src/main/ai/context.ts'
import { shownLines } from '../src/main/ai/lookup.ts'
import { blockingSummary, checkedBySameModel, unreadSummary, unreadText, verdictOf } from '../src/shared/findings.ts'
import type { AiRun, Finding, FindingVerification, Review, RunMember } from '../src/shared/types.ts'

test('a cited line counts as read within 3 lines of what was seen; a range needs every line; a bare path needs any line', () => {
	const seen = new Seen().add('src/cart.ts', 80, 100).add('src/checkout.ts', 4, 4)
	const unread = (t: string) => unreadRefs([t], seen)
	assert.deepEqual(unread('src/cart.ts:102 and src/cart.ts:77'), [], 'near misses are taken at their word')
	assert.deepEqual(unread('src/cart.ts:104'), ['src/cart.ts:104'])
	assert.deepEqual(unread('src/cart.ts:95-103'), [])
	assert.deepEqual(unread('src/cart.ts:95-110'), ['src/cart.ts:95-110'], 'part of the range was never seen')
	assert.deepEqual(unread('see cart.ts:90'), [], 'a shorter path means the seen file that ends in it')
	assert.deepEqual(unread('see src/checkout.ts'), [], 'no line: any of the file is enough')
	assert.deepEqual(unread('see src/payments/stripe.ts'), ['src/payments/stripe.ts'])
	assert.deepEqual(unread('src/cart.ts:200 twice: src/cart.ts:200'), ['src/cart.ts:200'], 'each once')
})

test('a request saw its excerpts on both sides, the related code sent with it, and the project context', () => {
	const batch = {
		excerpts: [
			{
				file: { oldPath: 'old/name.ts', newPath: 'new/name.ts' },
				lines: [
					{ kind: 'ctx', oldNo: 10, newNo: 12, text: '' },
					{ kind: 'del', oldNo: 11, newNo: null, text: '' },
					{ kind: 'add', oldNo: null, newNo: 13, text: '' },
				],
			},
		],
		references: [{ path: 'src/util.ts', start: 40, end: 60 }],
		facts: [{ kind: 'project', title: '', text: '', fileKeys: null }],
	} as unknown as ContextBatch
	const seen = seenInBatch(batch, [{ path: 'src/read.ts', version: 'base', start: 1, end: 5 }])
	assert.deepEqual(unreadRefs(['old/name.ts:11 new/name.ts:13 src/util.ts:58 .review/context.md:120 src/read.ts:2 src/util.ts:90'], seen), [
		'src/util.ts:90',
	])
})

test('lookups count only the lines their results showed, after any cut', () => {
	const read = 'src/a.ts (base), lines 3-9 of 40:\n 3 | x\n 4 | y\n 5 | z\n… (cut: read a smaller range or narrow the search)'
	assert.deepEqual(shownLines('read_file', read), [{ path: 'src/a.ts', version: 'base', start: 3, end: 5 }])
	const search = '3 matches for "total(":\nsrc/a.ts:4: total(x)\nsrc/a.ts:5: total(y)\nsrc/b.ts:9: total(z)'
	assert.deepEqual(shownLines('search_code', search), [
		{ path: 'src/a.ts', version: 'head', start: 4, end: 5 },
		{ path: 'src/b.ts', version: 'head', start: 9, end: 9 },
	])
	assert.deepEqual(shownLines('read_file', '"src/a.ts" has 3 lines.'), [])
})

test('a "holds" on unread lines is counted as not settled; the summary splits by reviewer and leaves carried findings out', () => {
	assert.equal(verdictOf({ verdict: 'holds', unread: ['a/b.ts:3'] }), 'unsure')
	assert.equal(verdictOf({ verdict: 'holds' }), 'holds')
	assert.equal(verdictOf({ verdict: 'wrong', unread: ['a/b.ts:3'] }), 'wrong', 'only a "holds" rests on what it read')
	assert.equal(unreadText(['a.ts:1']), 'cites a.ts:1, which it never read')
	assert.equal(unreadText(['a.ts:1', 'b.ts:2']), 'cites a.ts:1 and b.ts:2, which it never read')
	assert.equal(unreadText(['a.ts:1', 'b.ts:2', 'c.ts:3', 'd.ts:4']), 'cites a.ts:1, b.ts:2, c.ts:3 and 1 more, which it never read')

	const f = (id: string, over: Partial<Finding>): Finding =>
		({ id, severity: 'blocking', anchor: { fileKey: 'a' }, repeatOf: null, ...over }) as unknown as Finding
	const holds = { verdict: 'holds', reason: '', level: null, checked: [], model: 'm' } as const
	const run = {
		findings: [
			f('1', { unread: ['x.ts:1'], memberId: 'bugs', verification: { ...holds, unread: ['y.ts:2'] } }),
			f('2', { unread: ['x.ts:1'], memberId: 'bugs' }),
			f('3', { unread: ['x.ts:1'], memberId: 'security', verification: holds }),
			f('4', { unread: ['x.ts:1'], carried: {} as Finding['carried'] }),
		],
	} as unknown as AiRun
	const u = unreadSummary(run)
	assert.equal(u.findings, 3)
	assert.deepEqual(
		[...u.byMember],
		[
			['bugs', 2],
			['security', 1],
		],
	)
	assert.equal(u.checks, 1)
	const review = { comments: [], drafts: [], findingDecisions: {} } as unknown as Review
	const s = blockingSummary(review, [run], new Map())
	assert.equal(s.openHolds, 1, 'only the check that read what it cites')
})

test('a double-check is flagged when the model that raised the finding also checked it', () => {
	const v = (model: string, over: Partial<FindingVerification> = {}): FindingVerification => ({
		verdict: 'holds',
		reason: '',
		level: null,
		checked: [],
		model,
		...over,
	})
	const single = { model: 'm1', team: null }
	assert.equal(checkedBySameModel(single, { verification: v('m1') }), true)
	assert.equal(checkedBySameModel(single, { verification: v('m2', { onDemand: true }) }), false, 'Verify with another model')
	assert.equal(checkedBySameModel(single, { verification: v('m1', { error: true }) }), false, 'a failed check checked nothing')
	assert.equal(checkedBySameModel(single, {}), false)

	const member = (id: string, model: string) => ({ id, model }) as RunMember
	const team = {
		model: 'team',
		team: { id: 't', name: 'T', members: [member('bugs', 'm1'), member('security', 'm1'), member('style', 'm2')] },
	}
	assert.equal(
		checkedBySameModel(team, { memberId: 'bugs', verification: v('m1', { memberId: 'security' }) }),
		true,
		'members share a model',
	)
	assert.equal(checkedBySameModel(team, { memberId: 'bugs', verification: v('m2', { memberId: 'style' }) }), false)
	assert.equal(checkedBySameModel(team, { memberId: 'gone', verification: v('m1') }), false, 'an unknown raiser is not claimed')
})
