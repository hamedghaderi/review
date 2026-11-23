import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { FileSource } from '../src/main/ai/context.ts'
import { createFakeProvider, emptyEvaluation } from '../src/main/ai/fake.ts'
import { noteFacts } from '../src/main/ai/notes.ts'
import { REVIEWER_INSTRUCTIONS } from '../src/main/ai/prompt.ts'
import { startRun } from '../src/main/ai/runner.ts'
import { ReviewService } from '../src/main/service.ts'
import { migrate, notesKeyOf, ReviewStore, STORE_VERSION, type RepoState } from '../src/main/store.ts'
import { notesKey, reviewerNoteEdit } from '../src/main/validate.ts'
import { noteCovers, notesMarkdown, pathPattern } from '../src/shared/notes.ts'
import type { ChangedFile, Comparison, ReviewerNote } from '../src/shared/types.ts'

const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)

function note(over: Partial<ReviewerNote> = {}): ReviewerNote {
	return {
		id: 'n1',
		text: 'Error messages here are deliberately terse.',
		rule: 'convention',
		paths: [],
		on: true,
		addedAt: '2026-11-20T10:00:00.000Z',
		editedAt: null,
		...over,
	}
}

test('note paths: * stays in a folder, ** crosses folders, a folder covers what is in it, a bare name matches at any depth', () => {
	const covers = (glob: string, path: string): boolean => noteCovers({ paths: [glob] }, path)
	assert.ok(covers('src/errors/**', 'src/errors/http/notFound.ts'))
	assert.ok(covers('src/errors', 'src/errors/http/notFound.ts'), 'a folder without a slash at the end')
	assert.ok(covers('src/errors/', 'src/errors/a.ts'))
	assert.ok(covers('./src/*.ts', 'src/app.ts'))
	assert.ok(!covers('src/*.ts', 'src/lib/app.ts'), '* does not cross folders')
	assert.ok(covers('src/**/*.sql', 'src/a/b/q.sql'))
	assert.ok(covers('src/**/*.sql', 'src/q.sql'), '**/ also matches no folder')
	assert.ok(covers('*.sql', 'db/migrations/001.sql'), 'a bare name matches at any depth')
	assert.ok(covers('migrations', 'db/migrations/001.sql'))
	assert.ok(!covers('src/errors', 'src/errorsx/a.ts'), 'a folder is not a prefix of another name')
	assert.ok(covers('src/a+b(1).ts', 'src/a+b(1).ts'), 'regex characters are literal')
	assert.ok(covers('src/?.ts', 'src/a.ts') && !covers('src/?.ts', 'src/ab.ts'))
	assert.equal(pathPattern('  '), null)
	assert.ok(noteCovers({ paths: [] }, 'anything/at/all.ts'), 'no paths: the whole repository')
	assert.ok(noteCovers({ paths: ['docs/**', 'src/errors'] }, 'src/errors/a.ts'), 'any of several patterns')
})

function changed(path: string): ChangedFile {
	return { key: path, status: 'modified', oldPath: path, newPath: path, additions: 1, deletions: 1, binary: false, similarity: null }
}

const SOURCES: Array<FileSource> = ['src/errors/http.ts', 'src/view.ts'].map(
	(p) =>
		({
			file: changed(p),
			patch: {
				kind: 'text',
				hunks: [
					{
						oldStart: 1,
						oldLines: 1,
						newStart: 1,
						newLines: 1,
						section: '',
						lines: [
							{ kind: 'del', oldNo: 1, newNo: null, text: `throw fail('${p} broke')` },
							{ kind: 'add', oldNo: null, newNo: 1, text: `throw fail('bad')` },
						],
					},
				],
			},
			fullText: null,
		}) as FileSource,
)

test('notes reach the requests with the files they cover, labelled once for the whole run; off notes and notes on no changed file are not sent', () => {
	const { facts, labels } = noteFacts(
		[
			note({ id: 'errors', paths: ['src/errors/**'] }),
			note({ id: 'off', on: false }),
			note({ id: 'docs', paths: ['docs/**'] }),
			note({ id: 'all', rule: null, text: 'Feature flags are\nread once at boot.' }),
			note({ id: 'errors2', rule: 'misleading-name', text: 'fail() is the house name for throwing.', paths: ['src/errors'] }),
		],
		SOURCES,
	)
	assert.deepEqual(
		[...labels].map(([l, n]) => [l, n.id]),
		[
			['N1', 'errors'],
			['N2', 'all'],
			['N3', 'errors2'],
		],
	)
	assert.deepEqual(facts, [
		{
			kind: 'notes',
			title: 'Reviewer notes',
			text: '- N1 (rule "convention"; files "src/errors/**"): Error messages here are deliberately terse.\n- N3 (rule "misleading-name"; files "src/errors"): fail() is the house name for throwing.',
			fileKeys: ['src/errors/http.ts'],
		},
		{
			kind: 'notes',
			title: 'Reviewer notes',
			text: '- N2 (rule any; the whole repository): Feature flags are read once at boot.',
			fileKeys: null,
		},
	])
})

test('a run sends notes only with the files they cover, and marks a finding the model says a note covers when rule and file match', async () => {
	const inputs: Array<string> = []
	const comparison: Comparison = {
		id: `${BASE}..${HEAD}`,
		repoId: '/repo',
		baseRef: 'main',
		baseTipSha: BASE,
		baseSha: BASE,
		headSha: HEAD,
		headRef: 'topic',
		target: null,
		pr: null,
		files: SOURCES.map((s) => s.file),
	}
	const finding = (path: string, category: string, noteId: string | null) => ({
		excerpt_id: path === 'src/errors/http.ts' ? 'E1' : 'E2',
		file_path: path,
		side: 'new',
		start_line: 1,
		end_line: 1,
		category,
		signature: null,
		test_pattern: null,
		severity: 'nit',
		title: `${category} ${path} ${noteId ?? 'none'}`,
		body: 'The message says only "bad", so whoever reads the log cannot tell what failed.',
		reasoning: 'The message lost the detail.',
		disproof: null,
		reach: null,
		background: null,
		evidence: "throw fail('bad')",
		raised_before: null,
		reviewer_note: noteId ? { note_id: noteId, why_anyway: ' The message is now empty of any detail, not just terse. ' } : null,
	})
	const run = await startRun(
		{
			reviewId: comparison.id,
			comparison,
			scope: { kind: 'all' },
			loadSources: async () => SOURCES,
			previousFindings: [],
			notes: [note({ paths: ['src/errors'] }), note({ id: 'off', on: false, text: 'Never sent.' })],
		},
		{
			provider: createFakeProvider({
				script: (req) => {
					inputs.push(req.input)
					return {
						findings: [
							finding('src/errors/http.ts', 'convention', 'N1'), // covered: marked
							finding('src/errors/http.ts', 'misleading-name', 'N1'), // another rule: kept, not marked
							finding('src/view.ts', 'convention', 'N1'), // another file: kept, not marked
							finding('src/errors/http.ts', 'over-engineered', 'N7'), // never sent: kept, not marked
						],
						evaluation: emptyEvaluation(),
						unexplained_files: [],
						limitations: [],
					}
				},
			}),
			limits: { contextLines: 3, maxBatchChars: 100_000, maxRunChars: 1_000_000 },
			concurrency: 1,
			maxAttempts: 1,
			backoffMs: () => 0,
		},
		() => {},
	).done
	assert.equal(run.status, 'completed')
	assert.match(
		inputs[0],
		/## Reviewer notes\n- N1 \(rule "convention"; files "src\/errors"\): Error messages here are deliberately terse\./,
	)
	assert.doesNotMatch(inputs[0], /Never sent/)
	const byTitle = new Map(run.findings.map((f) => [f.title, f]))
	assert.deepEqual(byTitle.get('convention src/errors/http.ts N1')?.underNote, {
		noteId: 'n1',
		text: 'Error messages here are deliberately terse.',
		why: 'The message is now empty of any detail, not just terse.',
	})
	for (const t of ['misleading-name src/errors/http.ts N1', 'convention src/view.ts N1', 'over-engineered src/errors/http.ts N7']) {
		assert.ok(byTitle.has(t), `${t} is kept`)
		assert.equal(byTitle.get(t)?.underNote, undefined, `${t} is not marked`)
	}
	assert.ok(run.coverage.facts!.some((f) => f.kind === 'notes' && f.text.startsWith('1 of your reviewer notes was sent: “Error messages')))
})

test('the instructions keep notes out of what is posted, and never let a note settle a defect the code shows', () => {
	assert.ok(REVIEWER_INSTRUCTIONS.includes('Notes are private to the reviewer: never mention or quote one in the body'))
	assert.ok(REVIEWER_INSTRUCTIONS.includes('A note is background, never proof'))
})

test('a run without notes sends no notes section and records none', async () => {
	const inputs: Array<string> = []
	const comparison = {
		id: 'x',
		repoId: '/repo',
		baseRef: 'main',
		baseTipSha: BASE,
		baseSha: BASE,
		headSha: HEAD,
		headRef: 'topic',
		target: null,
		pr: null,
		files: SOURCES.map((s) => s.file),
	} as Comparison
	const run = await startRun(
		{ reviewId: 'x', comparison, scope: { kind: 'all' }, loadSources: async () => SOURCES, previousFindings: [] },
		{
			provider: createFakeProvider({
				script: (req) => {
					inputs.push(req.input)
					return { findings: [], evaluation: emptyEvaluation(), unexplained_files: [], limitations: [] }
				},
			}),
			limits: { contextLines: 3, maxBatchChars: 100_000, maxRunChars: 1_000_000 },
			concurrency: 1,
			maxAttempts: 1,
			backoffMs: () => 0,
		},
		() => {},
	).done
	assert.doesNotMatch(inputs[0], /Reviewer notes/)
	assert.ok(!run.coverage.facts!.some((f) => f.kind === 'notes'))
})

test('notes are kept per GitHub repository, else per clone, and unreadable ones are dropped when the store loads', () => {
	assert.equal(notesKeyOf({ repoId: 'r1', githubRepo: 'Acme/Web', githubResolved: 'other/x' }), 'acme/web')
	assert.equal(notesKeyOf({ repoId: 'r1', githubRepo: null, githubResolved: 'Acme/Web' }), 'acme/web')
	assert.equal(notesKeyOf({ repoId: 'r1' }), 'local:r1')
	const d = migrate({
		version: STORE_VERSION,
		lastRepoId: null,
		repos: {},
		reviewerNotes: {
			'acme/web': [
				note({ rule: 'not-a-rule' as never, paths: ['src/**', 7 as never, ' '], on: undefined as never }),
				{ id: 'x' },
				note({ id: 'blank', text: '   ' }),
			],
			'local:gone': 'nonsense',
			'local:empty': [],
		},
	})
	assert.deepEqual(d.reviewerNotes, { 'acme/web': [note({ rule: null, paths: ['src/**'], on: true })] })
	assert.equal(migrate({ version: STORE_VERSION, lastRepoId: null, repos: {} }).reviewerNotes, undefined)
})

test('a note edit is checked: text, a known rule or any, at most 20 trimmed paths; the key is a GitHub name or a local id', () => {
	assert.deepEqual(reviewerNoteEdit({ id: null, text: '  Terse on purpose. ', rule: null, paths: [' src/** ', '', 'src/**'], on: true }), {
		id: null,
		text: 'Terse on purpose.',
		rule: null,
		paths: ['src/**'],
		on: true,
	})
	assert.throws(() => reviewerNoteEdit({ id: null, text: '   ', rule: null, paths: [], on: true }), /empty/)
	assert.throws(() => reviewerNoteEdit({ id: null, text: 'x', rule: 'style', paths: [], on: true }), /rule/)
	assert.throws(() => reviewerNoteEdit({ id: null, text: 'x'.repeat(601), rule: null, paths: [], on: true }), /note/)
	assert.throws(
		() => reviewerNoteEdit({ id: null, text: 'x', rule: null, paths: Array.from({ length: 21 }, (_, i) => `p${i}`), on: true }),
		/paths/,
	)
	assert.equal(notesKey('acme/web'), 'acme/web')
	assert.equal(notesKey('local:abc'), 'local:abc')
	assert.throws(() => notesKey('Acme/Web'), /repository/)
	assert.throws(() => notesKey('local:'), /repository/)
	assert.throws(() => notesKey('../etc'), /repository/)
})

test('Copy as Markdown gives the notes that are on, each under its rule and files', () => {
	assert.equal(
		notesMarkdown([
			note({ paths: ['src/errors/**'] }),
			note({ id: 'off', on: false, text: 'Not copied.' }),
			note({ id: 'b', rule: null, text: 'Flags are read once at boot.' }),
		]),
		'# Notes for the reviewer\n\n## Convention findings in src/errors/**\n\nError messages here are deliberately terse.\n\n## Any finding in the whole repository\n\nFlags are read once at boot.\n',
	)
})

test('clones of one GitHub repository share their notes; a note can be added, changed, switched off and deleted', async () => {
	const store = ReviewStore.in(mkdtempSync(join(tmpdir(), 'review-notes-')))
	await store.load()
	const repo = (repoId: string, root: string, gh: string | null): RepoState => ({
		repoId,
		root,
		selectedBase: null,
		activeReviewId: null,
		reviews: {},
		aiRuns: {},
		githubResolved: gh,
	})
	await store.update((d) => {
		d.repos = { a: repo('a', '/code/web', 'acme/web'), b: repo('b', '/other/web-copy', 'Acme/Web'), c: repo('c', '/code/tool', null) }
	})
	const svc = new ReviewService(store, null)
	assert.deepEqual(svc.notesRepos('b'), {
		repos: [
			{ key: 'acme/web', label: 'acme/web', notes: 0 },
			{ key: 'local:c', label: 'tool', notes: 0 },
		],
		current: 'acme/web',
	})

	const [added] = await svc.saveReviewerNote('acme/web', { id: null, text: 'Terse on purpose.', rule: 'convention', paths: [], on: true })
	assert.equal(added.editedAt, null)
	assert.equal(svc.notesRepos('a').repos[0].notes, 1)

	const off = await svc.saveReviewerNote('acme/web', { ...added, on: false })
	assert.equal(off[0].on, false)
	assert.equal(off[0].editedAt, null, 'switching it off is not an edit')
	const edited = await svc.saveReviewerNote('acme/web', { ...added, text: 'Terse on purpose, see ERRORS.md.', on: false })
	assert.ok(edited[0].editedAt)
	assert.equal(edited[0].addedAt, added.addedAt)

	await assert.rejects(svc.saveReviewerNote('acme/web', { ...added, id: 'missing' }), /no longer exists/)
	assert.deepEqual(await svc.deleteReviewerNote('acme/web', added.id), [])
	assert.equal(store.read().reviewerNotes?.['acme/web'], undefined, 'a repository left without notes is dropped')
})
