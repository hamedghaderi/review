import assert from 'node:assert/strict'
import { test } from 'node:test'
import { droppedFindings, findingRoots } from '../src/shared/findings.ts'
import type { AiRun, Finding, Review } from '../src/shared/types.ts'

const anchor = (fileKey: string, line: number) =>
	({
		repoId: 'r',
		baseSha: 'b',
		headSha: 'h',
		fileKey,
		oldPath: fileKey,
		newPath: fileKey,
		side: 'new',
		startLine: line,
		endLine: line,
		excerpt: '',
	}) as Finding['anchor']

const f = (id: string, over: Partial<Finding> = {}): Finding =>
	({
		id,
		runId: '',
		excerptId: 'E1',
		anchor: anchor('a.ts', 10),
		severity: 'question',
		title: id,
		evidence: '',
		repeatOf: null,
		...over,
	}) as Finding

function run(id: string, findings: Array<Finding>, over: Partial<AiRun> = {}): AiRun {
	return {
		id,
		baseSha: 'b',
		headSha: 'h',
		status: 'completed',
		findings,
		coverage: {
			files: [
				{ fileKey: 'a.ts', state: 'reviewed' },
				{ fileKey: 'b.ts', state: 'reviewed' },
			],
		},
		...over,
	} as unknown as AiRun
}

const review = (over: Partial<Review> = {}) => ({ comments: [], drafts: [], findingDecisions: {}, ...over }) as unknown as Review

test('a re-run lists what the previous run on the same snapshot raised and it did not', () => {
	const first = run('r1', [f('kept'), f('lost'), f('lost-b', { anchor: anchor('b.ts', 3) })])
	const second = run('r2', [f('kept-again', { repeatOf: 'kept' }), f('new')])
	const runs = [first, second]
	const d = droppedFindings(second, runs, review(), findingRoots(runs))
	assert.equal(d?.from.id, 'r1')
	assert.deepEqual(
		d?.findings.map((x) => x.id),
		['lost', 'lost-b'],
	)
	assert.equal(droppedFindings(first, runs, review(), findingRoots(runs)), null, 'the first run has nothing to compare with')
})

test('not flagged: dismissed, held back, folded, files the re-run did not review, other snapshots, unfinished runs', () => {
	const first = run('r1', [
		f('dismissed'),
		f('held', { heldBack: 'over the limit' }),
		f('folded', { mergedInto: 'x' }),
		f('elsewhere', { anchor: anchor('b.ts', 1) }),
	])
	const second = run('r2', [], {
		coverage: {
			files: [
				{ fileKey: 'a.ts', state: 'reviewed' },
				{ fileKey: 'b.ts', state: 'failed' },
			],
		} as AiRun['coverage'],
	})
	const runs = [first, second]
	const r = review({ findingDecisions: { dismissed: { status: 'dismissed', decidedAt: 't' } } })
	assert.equal(droppedFindings(second, runs, r, findingRoots(runs)), null)

	const otherCommit = run('r0', [f('old')], { headSha: 'older' })
	const cancelled = run('r3', [], { status: 'cancelled' })
	assert.equal(
		droppedFindings(run('r4', []), [otherCommit, run('r4', [])], review(), new Map()),
		null,
		'a run on other commits is not compared',
	)
	assert.equal(droppedFindings(cancelled, [first, cancelled], review(), new Map()), null, 'a run that did not finish says nothing')
})

test('not flagged: rules the re-run did not ask about that file', () => {
	const ev = (rule: string, checkedBy: string | null = null) => ({ rule, requests: 1, checkedBy, nearMisses: [], why: [] })
	const first = run('r1', [
		f('bug', { category: 'bug' }),
		f('naming', { category: 'misleading-name' }),
		f('residue', { category: 'residue', signature: 3 }),
		f('security', { category: 'security', anchor: anchor('b.ts', 1) }),
	])
	// Bugs-only: one member owning bug and security, the only rules stored; Security was not given b.ts (low risk).
	const second = run('r2', [], {
		evaluation: [ev('bug', 'm1'), ev('security', 'm2')],
		coverage: {
			files: [
				{ fileKey: 'a.ts', state: 'reviewed' },
				{ fileKey: 'b.ts', state: 'reviewed' },
			],
			supplied: [
				{ fileKey: 'a.ts', memberId: 'm1' },
				{ fileKey: 'b.ts', memberId: 'm1' },
				{ fileKey: 'a.ts', memberId: 'm2' },
			],
		} as AiRun['coverage'],
	} as Partial<AiRun>)
	const runs = [first, second]
	assert.deepEqual(
		droppedFindings(second, runs, review(), findingRoots(runs))?.findings.map((x) => x.id),
		['bug'],
	)

	const full = run('r3', [], { evaluation: [ev('bug'), ev('misleading-name'), ev('residue-3'), ev('security')] } as Partial<AiRun>)
	assert.deepEqual(
		droppedFindings(full, [first, full], review(), findingRoots([first, full]))?.findings.map((x) => x.id),
		['bug', 'naming', 'residue', 'security'],
		'a single-model run checked every rule it stored on every file',
	)
})
