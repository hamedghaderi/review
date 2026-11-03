import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	buildStyleRequest,
	exampleCount,
	fromFinding,
	parseStyle,
	STYLE_INSTRUCTIONS,
	styleBasis,
	styleExamples,
	styleInput,
	withoutAdded,
} from '../src/main/ai/style.ts'
import { migrate, STORE_VERSION } from '../src/main/store.ts'
import { reviewStyleEdit } from '../src/main/validate.ts'
import { findingCommentBody } from '../src/shared/findings.ts'
import type { AiRun, Anchor, Finding, Review, ReviewComment } from '../src/shared/types.ts'

const anchor = { fileKey: 'k', side: 'new', startLine: 1, endLine: 1, excerpt: '' } as unknown as Anchor

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
		body: `The list page can show a stale count after ${id} runs, because the cache is not cleared.`,
		...over,
	} as Finding
}

function comment(id: string, body: string, over: Partial<ReviewComment> = {}): ReviewComment {
	return { id, anchor, body, createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-01T10:00:00Z', findingId: null, ...over }
}

function repo(comments: Array<ReviewComment>, findings: Array<Finding>) {
	const review = { id: 'rv', comments } as unknown as Review
	const run = { id: 'run1', findings } as unknown as AiRun
	return { reviews: { rv: review }, aiRuns: { rv: [run] } }
}

test('examples: an edited finding is a pair, an unchanged one is the AI’s words and is left out', () => {
	const kept = finding('f1')
	const edited = finding('f2')
	const posted = `${findingCommentBody(edited).split('\n\n')[0]}\n\nnit: clear the cache here too?`
	const x = styleExamples(
		[
			repo(
				[
					comment('c1', findingCommentBody(kept), { findingId: 'f1' }),
					comment('c2', posted, { findingId: 'f2' }),
					comment('c3', 'Could we name this `retryAfterMs`? It holds milliseconds.'),
				],
				[kept, edited],
			),
		],
		[],
	)
	assert.deepEqual(x.edits, [{ ai: edited.body, yours: 'nit: clear the cache here too?' }], 'the level label is not part of your words')
	assert.deepEqual(x.own, ['Could we name this `retryAfterMs`? It holds milliseconds.'])
	assert.deepEqual(styleBasis(x), { edits: 1, comments: 1, github: 0 })
})

test('examples: a finding whose only change was dropping the parts the app adds is not an edit', () => {
	const f = finding('f1', { disproof: 'Run the list test twice.', background: 'The cache lives in memory.' })
	const x = styleExamples([repo([comment('c1', `${findingCommentBody(f).split('\n\n')[0]}\n\n${f.body}`, { findingId: 'f1' })], [f])], [])
	assert.equal(exampleCount(x), 0)
})

test('examples: carried copies, comments whose finding is gone and duplicates count once or not at all', () => {
	const carried = comment('c2', 'Same words', { carried: { originId: 'c1' } as ReviewComment['carried'] })
	const x = styleExamples([repo([comment('c1', 'Same words'), carried, comment('c3', 'Orphan', { findingId: 'gone' })], [])], [])
	assert.deepEqual(x.own, ['Same words'])
})

test('examples: GitHub comments skip automatic review summaries, posted findings and what the app already has', () => {
	const f = finding('f1')
	const x = styleExamples(
		[repo([comment('c1', 'Looks good, one question below.')], [f])],
		[
			{ body: '🤖 This review was written and submitted automatically by AI.', createdAt: '2026-11-02' },
			{ body: findingCommentBody(f), createdAt: '2026-11-02' },
			{ body: 'Looks good, one question below.', createdAt: '2026-11-02' },
			{ body: 'Why not reuse `parseDate` here?', createdAt: '2026-11-02' },
			{ body: '   ', createdAt: null },
		],
	)
	assert.deepEqual(x.github, ['Why not reuse `parseDate` here?'])
	assert.ok(fromFinding(findingCommentBody(f)))
	assert.ok(!fromFinding('nit: <kbd>x</kbd>'))
})

test('examples: newest first, and each kind is capped', () => {
	const many = Array.from({ length: 100 }, (_, i) => ({
		body: `GitHub comment ${i}`,
		createdAt: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T00:00:${String(i % 60).padStart(2, '0')}Z`,
	}))
	const x = styleExamples([], many)
	assert.equal(x.github.length, 80)
	assert.match(x.github[0], /GitHub comment/)
	const dates = x.github.map((b) => many.find((m) => m.body === b)!.createdAt)
	assert.deepEqual(dates, [...dates].sort().reverse())
})

test('withoutAdded strips the label, follow-up link, other places, disproof and background', () => {
	const f = finding('f1', {
		raisedBefore: { url: 'https://example.com/t' } as Finding['raisedBefore'],
		alsoAt: [{ findingId: 'x', path: 'a.ts', line: 3, title: 't' }],
		disproof: 'Run it.',
		background: 'Context.',
	})
	assert.equal(withoutAdded(findingCommentBody(f)), f.body)
})

test('input: edits come first, and the request stays under its size by dropping the oldest of the rest', () => {
	const big = 'x'.repeat(1200)
	const input = styleInput({ edits: [{ ai: 'AI text', yours: 'my text' }], own: Array(30).fill(big), github: Array(80).fill(big) })
	assert.ok(input.indexOf('The AI wrote') < input.indexOf('themselves'))
	assert.ok(input.length < 62_000)
	assert.match(input, /Write the note/)
	const req = buildStyleRequest({ edits: [], own: ['a'], github: [] })
	assert.equal(req.instructions, STYLE_INSTRUCTIONS)
	assert.equal(req.schema?.name, 'review_style')
})

test('parseStyle: trims, rejects empty or malformed notes, and caps the length', () => {
	assert.equal(parseStyle({ style: '  - Short and direct.\n' }), '- Short and direct.')
	assert.throws(() => parseStyle({ style: '   ' }), /empty/)
	assert.throws(() => parseStyle({ note: 'x' }), /expected format/)
	assert.equal(parseStyle({ style: 'y'.repeat(5000) }).length, 2000)
})

test('store: the note survives a restart, and a broken one is dropped', () => {
	const style = {
		text: '- Be brief.',
		on: false,
		builtAt: '2026-11-03T09:00:00Z',
		edited: true,
		basis: { edits: 2, comments: 3, github: 10 },
		proposed: { text: '- Be briefer.', builtAt: '2026-11-03T10:00:00Z', basis: { edits: 2, comments: 3, github: 12 } },
	}
	const base = { version: STORE_VERSION, lastRepoId: null, repos: {} }
	assert.deepEqual(migrate({ ...base, reviewStyle: style }).reviewStyle, style)
	assert.equal(migrate({ ...base, reviewStyle: { text: 1 } }).reviewStyle, undefined)
	assert.equal(migrate(base).reviewStyle, undefined, 'nothing is there until you build it')
})

test('validate: an edit needs text within the size and a yes/no for on', () => {
	assert.deepEqual(reviewStyleEdit({ text: '- Brief.', on: true }), { text: '- Brief.', on: true })
	assert.throws(() => reviewStyleEdit({ text: '', on: true }))
	assert.throws(() => reviewStyleEdit({ text: 'z'.repeat(2001), on: true }))
	assert.throws(() => reviewStyleEdit({ text: 'ok', on: 'yes' }))
})
