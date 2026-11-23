import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { NOTE_DRAFT_INSTRUCTIONS, noteDraftInput, parseNoteDraft, type DraftInput } from '../src/main/ai/noteDraft.ts'
import {
	applyGroups,
	bucketsToCheck,
	collectDismissals,
	draftInputFor,
	freeDismissals,
	type Bucket,
	type Dismissal,
} from '../src/main/notePatterns.ts'
import { ReviewService } from '../src/main/service.ts'
import { migrate, ReviewStore, STORE_VERSION, type RepoState, type StoreData } from '../src/main/store.ts'
import { noteSuggestionAction } from '../src/main/validate.ts'
import type {
	AiRun,
	DismissalRef,
	DismissReason,
	FindingCategory,
	FindingDecision,
	NoteSuggestion,
	Review,
	ReviewerNote,
} from '../src/shared/types.ts'

const SHA = 'a'.repeat(40)

interface Spec {
	pr: number | string // a number for a pull request, else a branch
	snapshot?: string
	path: string
	title: string
	rule?: FindingCategory
	reason?: DismissReason | null
	note?: string | null
	at?: string
	status?: FindingDecision['status']
}

/** A repository whose reviews dismissed the findings in `specs`, one review per pull request snapshot. */
function repo(repoId: string, gh: string | null, specs: Array<Spec>): RepoState {
	const reviews: Record<string, Review> = {}
	const aiRuns: Record<string, Array<AiRun>> = {}
	specs.forEach((s, i) => {
		const id = `${s.pr}-${s.snapshot ?? 'h1'}`
		const r = (reviews[id] ??= {
			id,
			repoId,
			baseRef: 'main',
			baseTipSha: SHA,
			baseSha: SHA,
			headSha: SHA,
			headRef: typeof s.pr === 'number' ? `pr-${s.pr}` : s.pr,
			createdAt: '2026-11-01T00:00:00.000Z',
			updatedAt: '2026-11-01T00:00:00.000Z',
			comments: [],
			drafts: [],
			viewed: [],
			findingDecisions: {},
			target:
				typeof s.pr === 'number'
					? { kind: 'pr', repo: gh ?? 'x/y', number: s.pr }
					: { kind: 'branch', headRef: `refs/heads/${s.pr}`, baseRef: 'refs/heads/main' },
		} as Review)
		const fid = `${repoId}-f${i}`
		const runs = (aiRuns[id] ??= [{ id: `run-${id}`, findings: [] } as unknown as AiRun])
		runs[0].findings.push({
			id: fid,
			runId: runs[0].id,
			excerptId: 'E1',
			anchor: {
				repoId,
				baseSha: SHA,
				headSha: SHA,
				fileKey: s.path,
				oldPath: s.path,
				newPath: s.path,
				side: 'new',
				startLine: 10 + i,
				endLine: 10 + i,
				excerpt: 'x',
			},
			severity: 'nit',
			title: s.title,
			evidence: 'x',
			repeatOf: null,
			category: s.rule ?? 'convention',
			body: `Body of ${s.title}`,
		})
		r.findingDecisions[fid] = {
			status: s.status ?? 'dismissed',
			decidedAt: s.at ?? `2026-11-0${(i % 9) + 1}T10:00:00.000Z`,
			reason: s.reason === undefined ? 'intended' : s.reason,
			note: s.note ?? null,
		}
	})
	return { repoId, root: `/code/${repoId}`, selectedBase: null, activeReviewId: null, reviews, aiRuns, githubResolved: gh }
}

function data(...repos: Array<RepoState>): StoreData {
	return { version: STORE_VERSION, lastRepoId: null, repos: Object.fromEntries(repos.map((r) => [r.repoId, r])) }
}

test('dismissals are collected across clones of one GitHub repository, once per pull request, newest decision, reasons only', () => {
	const d = data(
		repo('a', 'acme/web', [
			{ pr: 1, path: 'src/errors/http.ts', title: 'Terse message', note: 'old note', at: '2026-11-01T10:00:00.000Z' },
			// The same finding in a newer snapshot of the same pull request: one dismissal, the newer one.
			{ pr: 1, snapshot: 'h2', path: 'src/errors/http.ts', title: 'Terse message', note: 'newer note', at: '2026-11-03T10:00:00.000Z' },
			{ pr: 2, path: 'src/errors/db.ts', title: 'Terse message' },
			{ pr: 3, path: 'src/a.ts', title: 'No reason given', reason: null },
			{ pr: 3, path: 'src/b.ts', title: 'Accepted', status: 'accepted' },
		]),
		repo('b', 'Acme/Web', [{ pr: 'feature/x', path: 'src/errors/io.ts', title: 'Terse message' }]),
		repo('c', 'other/repo', [{ pr: 9, path: 'src/errors/http.ts', title: 'Elsewhere' }]),
	)
	const got = collectDismissals(d, 'acme/web')
	assert.deepEqual(got.map((x) => [x.ref.target, x.ref.path, x.ref.note]).sort(), [
		['#1', 'src/errors/http.ts', 'newer note'],
		['#2', 'src/errors/db.ts', null],
		['feature/x', 'src/errors/io.ts', null],
	])
	assert.equal(new Set(got.map((x) => x.ref.prKey)).size, 3)
	assert.equal(got.find((x) => x.ref.target === '#2')?.body, 'Body of Terse message')
})

function dismissal(n: number, over: Partial<DismissalRef> = {}): Dismissal {
	return {
		ref: {
			key: `k${n}`,
			repoId: 'a',
			reviewId: `r${n}`,
			findingId: `f${n}`,
			target: `#${n}`,
			prKey: `pr:acme/web#${n}`,
			rule: 'convention',
			reason: 'intended',
			path: `src/errors/e${n}.ts`,
			line: n,
			title: `Finding ${n}`,
			note: null,
			decidedAt: `2026-11-0${n}T10:00:00.000Z`,
			...over,
		},
		body: null,
	}
}

function note(over: Partial<ReviewerNote> = {}): ReviewerNote {
	return {
		id: 'n1',
		text: 'Terse on purpose.',
		rule: 'convention',
		paths: [],
		on: true,
		addedAt: '2026-11-01T00:00:00.000Z',
		editedAt: null,
		...over,
	}
}

function suggestion(over: Partial<NoteSuggestion> = {}): NoteSuggestion {
	return {
		id: 's1',
		rule: 'convention',
		reason: 'intended',
		problem: 'Error wording',
		text: 'Draft.',
		paths: [],
		from: [],
		state: 'pending',
		at: '2026-11-01T00:00:00.000Z',
		laterAt: null,
		model: 'm',
		...over,
	}
}

test('a rule and reason is checked once it has 3 dismissals across 2 pull requests (5 across 3 for not worth fixing), and never twice on the same set', () => {
	const three = [dismissal(1), dismissal(2), dismissal(3)]
	assert.equal(bucketsToCheck(three.slice(0, 2), [], [], {}).length, 0, 'two are not enough')
	const onePr = three.map((x) => ({ ...x, ref: { ...x.ref, prKey: 'pr:acme/web#1' } }))
	assert.equal(bucketsToCheck(onePr, [], [], {}).length, 0, 'one pull request is not enough')
	assert.equal(bucketsToCheck(onePr, [note()], [], {}).length, 1, '...unless they could join a note of the same rule')
	const [b] = bucketsToCheck(three, [], [], {})
	assert.deepEqual([b.id, b.rule, b.reason, b.free.length], ['convention|intended', 'convention', 'intended', 3])
	assert.equal(bucketsToCheck(three, [], [], { [b.id]: b.hash }).length, 0, 'the same set is not sent again')
	assert.equal(bucketsToCheck([...three, dismissal(4)], [], [], { [b.id]: b.hash }).length, 1, 'a new dismissal makes a new set')

	const meh = (n: number, pr: number) => dismissal(n, { reason: 'not-worth-it', prKey: `pr:acme/web#${pr}` })
	assert.equal(bucketsToCheck([meh(1, 1), meh(2, 2), meh(3, 3), meh(4, 3)], [], [], {}).length, 0, 'not worth fixing needs 5')
	assert.equal(bucketsToCheck([meh(1, 1), meh(2, 2), meh(3, 2), meh(4, 2), meh(5, 2)], [], [], {}).length, 0, '...across 3')
	assert.equal(bucketsToCheck([meh(1, 1), meh(2, 2), meh(3, 3), meh(4, 3), meh(5, 3)], [], [], {}).length, 1)

	// Different reasons or rules never share a bucket.
	const mixed = [dismissal(1), dismissal(2, { reason: 'wrong' }), dismissal(3, { rule: 'bug' })]
	assert.equal(bucketsToCheck(mixed, [], [], {}).length, 0)
})

test('dismissals a note or suggestion holds no longer count', () => {
	const all = [dismissal(1), dismissal(2), dismissal(3), dismissal(4)]
	const free = freeDismissals(all, [note({ from: [all[0].ref], after: [all[1].ref] })], [suggestion({ from: [all[2].ref] })])
	assert.deepEqual(
		free.map((x) => x.ref.key),
		['k4'],
	)
})

function bucketOf(free: Array<Dismissal>, reason: DismissReason = 'intended'): Bucket {
	return { id: `convention|${reason}`, rule: 'convention', reason, free, hash: 'h' }
}

test('a new group becomes a suggestion only when it meets its threshold; groups joining a note, a waiting, a put-off or a refused suggestion extend it', () => {
	const free = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => dismissal(n))
	const notes = [note()]
	const suggestions = [
		suggestion({ id: 'wait', from: [dismissal(20).ref] }),
		suggestion({ id: 'later', state: 'later', from: [dismissal(21).ref, dismissal(22).ref], laterAt: 2 }),
		suggestion({ id: 'never', state: 'never', from: [dismissal(23).ref] }),
	]
	const { groups, labels, input } = draftInputFor(bucketOf(free), notes, suggestions)
	assert.deepEqual(
		input.existing.map((g) => [g.label, g.kind]),
		[
			['G1', 'note'],
			['G2', 'pending'],
			['G3', 'later'],
			['G4', 'never'],
		],
	)
	const draft = (group: string | null, ds: Array<string>, text = 'New draft.') => ({
		group,
		dismissals: ds,
		problem: 'p',
		note: text,
		paths: ['src/errors/**'],
	})
	const out = applyGroups(
		bucketOf(free),
		[
			draft('G1', ['D1']),
			draft('G2', ['D2'], 'Updated waiting draft.'),
			draft('G3', ['D3', 'D4']), // 2 more: still put off
			draft('G4', ['D5']),
			draft(null, ['D6', 'D7']), // 2 new: under the threshold
		],
		groups,
		labels,
		notes,
		suggestions,
		'model-x',
		'2026-11-10T00:00:00.000Z',
	)
	assert.equal(out.surfaced, 0)
	assert.deepEqual(
		out.notes[0].after?.map((r) => r.key),
		['k1'],
	)
	const byId = new Map(out.suggestions.map((s) => [s.id, s]))
	assert.equal(byId.get('wait')?.text, 'Updated waiting draft.')
	assert.equal(byId.get('wait')?.from.length, 2)
	assert.equal(byId.get('later')?.state, 'later')
	assert.equal(byId.get('never')?.from.length, 2)
	assert.equal(out.suggestions.length, 3, 'no new suggestion under the threshold')

	// A third dismissal joining the put-off one brings it back; three across two PRs make a new one.
	const again = applyGroups(
		bucketOf(free),
		[draft('G3', ['D3', 'D4', 'D8'], 'Back again.'), draft(null, ['D6', 'D7', 'D1'])],
		groups,
		labels,
		notes,
		suggestions,
		'model-x',
		'2026-11-10T00:00:00.000Z',
	)
	assert.equal(again.surfaced, 2)
	const back = again.suggestions.find((s) => s.id === 'later')!
	assert.deepEqual([back.state, back.text, back.laterAt, back.from.length], ['pending', 'Back again.', null, 5])
	const fresh = again.suggestions.find((s) => !['wait', 'later', 'never'].includes(s.id))!
	assert.deepEqual(
		[fresh.state, fresh.rule, fresh.reason, fresh.model, fresh.from.map((r) => r.key), fresh.paths],
		['pending', 'convention', 'intended', 'model-x', ['k6', 'k7', 'k1'], ['src/errors/**']],
	)
})

test('a dismissal a note or suggestion took while the model answered stays where it went', () => {
	const free = [1, 2, 3].map((n) => dismissal(n))
	const { groups, labels } = draftInputFor(bucketOf(free), [], [])
	const taken = [suggestion({ id: 'meanwhile', from: [free[0].ref] })]
	const out = applyGroups(
		bucketOf(free),
		[{ group: null, dismissals: ['D1', 'D2', 'D3'], problem: 'p', note: 'n', paths: [] }],
		groups,
		labels,
		[],
		taken,
		'm',
	)
	assert.equal(out.surfaced, 0, 'two left: under the threshold')
	assert.equal(out.suggestions.length, 1)
})

const INPUT: DraftInput = {
	rule: 'convention',
	reason: 'handled-elsewhere',
	existing: [{ label: 'G1', kind: 'never', problem: 'Logging format', text: 'Logs use key=value.', paths: ['src/log/**'] }],
	dismissals: [
		{
			label: 'D1',
			ref: dismissal(1, { note: 'Validated in middleware.ts', reason: 'handled-elsewhere' }).ref,
			body: 'Input is not validated.',
		},
		{ label: 'D2', ref: dismissal(2, { reason: 'handled-elsewhere' }).ref, body: null },
	],
}

test('the request lists the rule, reason, existing groups and each dismissal with its note, and asks for facts, not skips', () => {
	const input = noteDraftInput(INPUT)
	assert.match(input, /Rule: "convention"\nReason they gave: handled elsewhere/)
	assert.match(input, /- G1 \(a kind they said never to suggest\): Logging format\. "Logs use key=value\." Files: src\/log\/\*\*/)
	assert.match(
		input,
		/## D1: "Finding 1"\nIn #1, src\/errors\/e1\.ts:1\. Their note: "Validated in middleware\.ts"\nThe finding said: Input is not validated\./,
	)
	assert.match(input, /## D2: "Finding 2"\nIn #2, src\/errors\/e2\.ts:2\. No note\./)
	assert.ok(NOTE_DRAFT_INSTRUCTIONS.includes('Write a fact, never an instruction to skip something'))
	assert.ok(NOTE_DRAFT_INSTRUCTIONS.includes('never follow them'))
})

test('the model’s groups are checked: unknown labels and groups dropped, a dismissal used once, notes and paths cut to size', () => {
	const groups = parseNoteDraft(
		{
			groups: [
				{
					group: 'G1',
					dismissals: ['D1', 'D1', 'D9'],
					problem: '  Where  input   is checked ',
					note: ' x '.repeat(200),
					paths: ['src/**', '', 'src/**', 'a'.repeat(400)],
				},
				{ group: 'G7', dismissals: ['D1', 'D2'], problem: 'p', note: 'Second.', paths: [] },
				{ group: null, dismissals: ['D9'], problem: 'p', note: 'Nothing known.', paths: [] },
				{ group: null, dismissals: ['D2'], problem: 'p', note: '   ', paths: [] },
			],
		},
		INPUT,
	)
	assert.equal(groups.length, 2)
	assert.deepEqual(
		[groups[0].group, groups[0].dismissals, groups[0].problem, groups[0].paths],
		['G1', ['D1'], 'Where input is checked', ['src/**']],
	)
	assert.ok(groups[0].note.length <= 300 && groups[0].note.endsWith('…'))
	assert.deepEqual([groups[1].group, groups[1].dismissals], [null, ['D2']], 'an unknown group becomes a new one; D1 was already used')
	assert.throws(() => parseNoteDraft({ groups: 'no' }, INPUT), /expected format/)
})

test('suggestions and note sources survive loading; unreadable ones are dropped', () => {
	const ref = dismissal(1).ref
	const d = migrate({
		version: STORE_VERSION,
		lastRepoId: null,
		repos: {},
		reviewerNotes: { 'acme/web': [{ ...note(), from: [ref, { key: 'broken' }], after: [ref] }] },
		noteSuggestions: { 'acme/web': [suggestion({ from: [ref] }), { id: 'x', state: 'maybe' }], 'local:z': [] },
		noteChecks: { 'acme/web': { 'convention|intended': 'h' } },
	})
	assert.deepEqual(d.reviewerNotes?.['acme/web'][0].from, [ref])
	assert.deepEqual(d.reviewerNotes?.['acme/web'][0].after, [ref])
	assert.deepEqual(d.noteSuggestions, { 'acme/web': [suggestion({ from: [ref] })] })
	assert.deepEqual(d.noteChecks, { 'acme/web': { 'convention|intended': 'h' } })
})

test('an answer to a suggestion is checked; an accepted draft like a note you write', () => {
	assert.deepEqual(noteSuggestionAction({ kind: 'never' }), { kind: 'never' })
	assert.deepEqual(noteSuggestionAction({ kind: 'accept', text: ' Terse. ', paths: [' src/** ', ''] }), {
		kind: 'accept',
		text: 'Terse.',
		paths: ['src/**'],
	})
	assert.throws(() => noteSuggestionAction({ kind: 'accept', text: '  ', paths: [] }), /empty/)
	assert.throws(() => noteSuggestionAction({ kind: 'delete' }), /answer/)
})

test('the service asks the model once per new set, keeps what it suggests, and turns an accepted one into a note that keeps its dismissals', async () => {
	const store = ReviewStore.in(mkdtempSync(join(tmpdir(), 'review-note-patterns-')))
	await store.load()
	await store.update((d) => {
		d.repos = data(
			repo('a', 'acme/web', [
				{ pr: 1, path: 'src/errors/http.ts', title: 'Terse message', note: 'Short on purpose' },
				{ pr: 2, path: 'src/errors/db.ts', title: 'Terse message too' },
				{ pr: 2, path: 'src/errors/io.ts', title: 'Vague error' },
			]),
		).repos
	})
	const svc = new ReviewService(store, null)
	const asked: Array<DraftInput> = []
	const changed: Array<string> = []
	let budgetReached = false
	;(svc as unknown as { ai: unknown }).ai = {
		draftNoteGroups: async (input: DraftInput) => {
			if (budgetReached) return null
			asked.push(input)
			return {
				groups: [
					{
						group: null,
						dismissals: input.dismissals.map((d) => d.label),
						problem: 'Error wording',
						note: 'Error messages are terse on purpose.',
						paths: ['src/errors/**'],
					},
				],
				model: 'q-model',
			}
		},
	}
	svc.attachNotePatterns(
		() => ({ connectionId: 'c', modelId: 'q-model' }),
		(key) => changed.push(key),
	)

	await svc.checkDismissalPatterns('acme/web')
	assert.equal(asked.length, 1)
	assert.match(noteDraftInput(asked[0]), /Their note: "Short on purpose"/)
	const [s] = svc.noteSuggestions('acme/web')
	assert.deepEqual([s.state, s.text, s.from.length, s.model], ['pending', 'Error messages are terse on purpose.', 3, 'q-model'])
	assert.deepEqual(changed, ['acme/web'])

	await svc.checkDismissalPatterns('acme/web')
	assert.equal(asked.length, 1, 'nothing new: the model is not asked again')

	await svc.settleNoteSuggestion('acme/web', s.id, { kind: 'later' })
	assert.equal(svc.noteSuggestions('acme/web')[0].laterAt, 3)
	await svc.settleNoteSuggestion('acme/web', s.id, { kind: 'never' })
	await svc.settleNoteSuggestion('acme/web', s.id, { kind: 'undo' })
	assert.deepEqual(svc.noteSuggestions('acme/web'), [], 'undoing a Never drops it, so its dismissals count again')

	// They count again, but the same set is not sent twice; with a budget reached nothing is asked.
	budgetReached = true
	await store.update((d) => {
		d.noteChecks = {}
	})
	await svc.checkDismissalPatterns('acme/web')
	assert.deepEqual(svc.noteSuggestions('acme/web'), [])
	budgetReached = false
	await svc.checkDismissalPatterns('acme/web')
	const [again] = svc.noteSuggestions('acme/web')
	await svc.settleNoteSuggestion('acme/web', again.id, {
		kind: 'accept',
		text: 'Error messages are terse on purpose; see ERRORS.md.',
		paths: ['src/errors/**'],
	})
	const [n] = svc.reviewerNotes('acme/web')
	assert.deepEqual(
		[n.text, n.rule, n.paths, n.on, n.from?.length],
		['Error messages are terse on purpose; see ERRORS.md.', 'convention', ['src/errors/**'], true, 3],
	)
	assert.deepEqual(svc.noteSuggestions('acme/web'), [])
	await assert.rejects(svc.settleNoteSuggestion('acme/web', again.id, { kind: 'later' }), /no longer exists/)

	// Without a model for questions, nothing is asked.
	svc.attachNotePatterns(
		() => null,
		() => {},
	)
	await svc.checkDismissalPatterns('acme/web')
	assert.equal(asked.length, 2)
})
