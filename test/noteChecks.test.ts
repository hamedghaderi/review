import assert from 'node:assert/strict'
import { test } from 'node:test'
import { noteChecks, summarizeOutcomes } from '../src/main/ai/outcomes.ts'
import type { RepoState } from '../src/main/store.ts'
import type { AiRun, Finding, FindingCategory, MergedPr, OutcomeFilter, Review, ReviewerNote } from '../src/shared/types.ts'

const ALL: OutcomeFilter = { period: 'all', repoId: null, promptVersion: null, group: null, model: null }

const finding = (id: string, path: string, category: FindingCategory, more: Partial<Finding> = {}): Finding =>
	({
		id,
		runId: '',
		excerptId: 'E1',
		anchor: {
			repoId: 'r',
			baseSha: 'b',
			headSha: 'h',
			fileKey: path,
			oldPath: path,
			newPath: path,
			side: 'new',
			startLine: 3,
			endLine: 3,
			excerpt: '',
		},
		severity: 'nit',
		title: `Title ${id}`,
		evidence: '',
		repeatOf: null,
		category,
		...more,
	}) as Finding

const run = (id: string, startedAt: string, files: Array<string>, findings: Array<Finding>, more: Partial<AiRun> = {}): AiRun =>
	({
		id,
		reviewId: 'rev',
		repoId: 'r',
		provider: 'openai',
		providerLabel: 'OpenAI',
		connectionId: 'c1',
		connectionLabel: 'OpenAI',
		model: 'gpt',
		fixture: false,
		promptVersion: 'v',
		startedAt,
		findings,
		coverage: { files: files.map((f) => ({ fileKey: f, state: 'reviewed', reason: null })) },
		...more,
	}) as AiRun

const comment = (findingId: string) => ({ id: `c-${findingId}`, body: '', createdAt: '', updatedAt: '', findingId })
const dismissed = { status: 'dismissed' as const, decidedAt: '2026-10-25T00:00:00Z', reason: 'intended' as const }
const commit = (sha: string) => ({ sha: sha.repeat(40).slice(0, 40), subject: `commit ${sha}`, at: '2026-11-01T00:00:00Z' })

const NOTE: ReviewerNote = {
	id: 'n1',
	text: 'Error messages are terse on purpose.',
	rule: 'convention',
	paths: ['src/errors/**'],
	on: true,
	addedAt: '2026-10-15T00:00:00Z',
	editedAt: null,
}

function shop(): RepoState {
	const under = { noteId: 'n1', text: NOTE.text, why: 'It hides the cause.' }
	const runs = [
		run(
			'before',
			'2026-10-10T00:00:00Z',
			['src/errors/a.ts', 'src/other.ts'],
			[
				finding('e1', 'src/errors/a.ts', 'convention'),
				finding('e2', 'src/errors/a.ts', 'bug'), // another rule
				finding('e3', 'src/other.ts', 'convention'), // outside its files
			],
		),
		run(
			'after',
			'2026-10-20T00:00:00Z',
			['src/errors/b.ts'],
			[
				finding('e4', 'src/errors/b.ts', 'convention', { underNote: under }),
				finding('e5', 'src/errors/c.ts', 'convention', { underNote: under }),
				finding('e6', 'src/errors/d.ts', 'convention'),
				finding('e7', 'src/errors/e.ts', 'convention', { underNote: under }), // marked, undecided
			],
		),
		// Raised again later: still one problem, first raised after the note.
		run('again', '2026-10-22T00:00:00Z', ['src/errors/b.ts'], [finding('e4b', 'src/errors/b.ts', 'convention', { repeatOf: 'e4' })]),
		run('elsewhere', '2026-10-21T00:00:00Z', ['src/x.ts'], []),
		run('fixture', '2026-10-21T00:00:00Z', ['src/errors/z.ts'], [finding('fx', 'src/errors/z.ts', 'convention')], { fixture: true }),
	]
	const rev = {
		id: 'rev',
		repoId: 'r',
		headRef: 'topic',
		pr: { number: 7 },
		comments: [comment('e4'), comment('e5')],
		drafts: [],
		findingDecisions: { e1: dismissed, e6: dismissed },
	} as unknown as Review
	const merged = {
		repo: 'owner/shop',
		mergedAt: '2026-10-30T00:00:00Z',
		findings: {
			e1: { state: 'changed', commit: commit('c'), reason: null },
			e6: { state: 'reverted', commit: commit('d'), reason: null },
		},
	} as unknown as MergedPr
	return {
		repoId: 'r',
		root: '/x/shop',
		githubRepo: 'owner/shop',
		reviews: { rev },
		aiRuns: { rev: runs },
		merged: { '7': merged },
	} as unknown as RepoState
}

test('a note shows what was raised of its kind before and since it, and warns on accepted findings it covered and on reverts', () => {
	const [c, wide] = noteChecks([shop()], {
		'owner/shop': [NOTE, { ...NOTE, id: 'n2', rule: null, paths: ['src/other.ts'], addedAt: '2026-10-01T00:00:00Z' }],
	})
	assert.deepEqual([c.key, c.repo, c.note.id], ['owner/shop', 'owner/shop', 'n1'])
	assert.deepEqual(c.before, { runs: 1, raised: 1, accepted: 0, dismissed: 1 })
	assert.deepEqual(c.after, { runs: 2, raised: 4, accepted: 2, dismissed: 1 }, 'the fixture run and the run on other files do not count')
	assert.equal(c.marked, 3)
	assert.deepEqual(
		c.acceptedUnder.map((r) => [r.findingId, r.target, r.path, r.line]),
		[
			['e4', '#7', 'src/errors/b.ts', 3],
			['e5', '#7', 'src/errors/c.ts', 3],
		],
	)
	assert.deepEqual(
		c.reverted.map((r) => [r.findingId, r.commit?.subject]),
		[['e6', 'commit d']],
	)
	assert.deepEqual(
		c.changed.map((r) => [r.findingId, r.commit?.subject]),
		[['e1', 'commit c']],
		'changed lines are listed, not warned on',
	)
	// Any rule, one file: everything there falls after it.
	assert.deepEqual(wide.after, { runs: 1, raised: 1, accepted: 0, dismissed: 0 })
	assert.deepEqual([wide.acceptedUnder, wide.reverted, wide.changed], [[], [], []])
})

test('Outcomes carries the notes of the repositories it shows', () => {
	const notes = { 'owner/shop': [NOTE], 'other/repo': [{ ...NOTE, id: 'n9' }] }
	const all = summarizeOutcomes([shop()], ALL, new Date('2026-11-23T00:00:00Z'), notes)
	assert.deepEqual(
		all.notes.map((c) => [c.key, c.repo]),
		[
			['owner/shop', 'owner/shop'],
			['other/repo', 'other/repo'],
		],
		'a repository with notes but no clone open here is still shown',
	)
	const one = summarizeOutcomes([shop()], { ...ALL, repoId: 'r' }, new Date('2026-11-23T00:00:00Z'), notes)
	assert.deepEqual(
		one.notes.map((c) => c.note.id),
		['n1'],
	)
	assert.deepEqual(summarizeOutcomes([shop()], ALL).notes, [], 'no notes, nothing shown')
})
