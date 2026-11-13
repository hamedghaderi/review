import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { RunConfig } from '../src/main/ai/connections.ts'
import { AiController } from '../src/main/ai/controller.ts'
import { createFakeProvider } from '../src/main/ai/fake.ts'
import { fixedThread, fixedThreadCandidates } from '../src/main/fixedThreads.ts'
import { ReviewStore } from '../src/main/store.ts'
import type {
	AiRun,
	Anchor,
	DiscussionThread,
	Finding,
	FindingVerification,
	GoneFinding,
	Review,
	ReviewComment,
} from '../src/shared/types.ts'

const anchor = (path: string, line: number): Anchor => ({
	repoId: 'r',
	baseSha: 'b',
	headSha: 'h',
	fileKey: path,
	oldPath: path,
	newPath: path,
	side: 'new',
	startLine: line,
	endLine: line,
	excerpt: '',
})

const gone = (id: string, over: Partial<GoneFinding> = {}): GoneFinding => ({
	finding: { id, title: `Problem ${id}`, anchor: anchor('src/a.ts', 10) } as unknown as Finding,
	state: 'fixed',
	why: 'its lines changed',
	decision: null,
	comment: `c-${id}`,
	at: anchor('src/a.ts', 14),
	...over,
})

// A comment carried to this snapshot from the one it was posted in, remembering where it was published.
const carried = (origin: string, url: string): ReviewComment =>
	({ id: `now-${origin}`, body: 'x', carried: { originId: origin, published: { url } } }) as unknown as ReviewComment

const thread = (id: string, first: { id: string; url: string | null; author: string }, resolved: boolean | null = false) =>
	({ id, resolved, url: `https://github.com/o/n/pull/1#t-${id}`, comments: [{ ...first, body: 'x' }] }) as unknown as DiscussionThread

const url = (n: string) => `https://github.com/o/n/pull/1#discussion_r${n}`

test('candidates: your open threads posted from findings the run marked fixed, matched by id or by link', () => {
	const run = {
		history: {
			gone: [
				gone('a'), // carried, matched by its link
				gone('b'), // posted from this snapshot, matched by GitHub id
				gone('c', { state: 'not-seen' }), // not shown fixed: not offered
				gone('d', { comment: null }), // never posted
				gone('e'), // its thread is resolved already
				gone('f'), // someone else started that thread
				gone('g'), // resolved state unknown (no token)
			],
		},
	} as unknown as Pick<AiRun, 'history'>
	const review = {
		comments: [
			carried('c-a', url('1')),
			{ id: 'c-b', body: 'x' } as unknown as ReviewComment,
			carried('c-e', url('5')),
			carried('c-f', url('6')),
			carried('c-g', url('7')),
		],
		publication: {
			repo: 'o/n',
			number: 1,
			reviews: [],
			comments: { 'c-b': { githubId: 'node-b', url: url('2'), reviewId: 'r1', body: 'x', at: '' } },
		},
	} as unknown as Pick<Review, 'comments' | 'publication'>
	const discussion = {
		viewer: 'me',
		threads: [
			thread('ta', { id: 'node-a', url: url('1'), author: 'me' }),
			thread('tb', { id: 'node-b', url: null, author: 'me' }),
			thread('te', { id: 'node-e', url: url('5'), author: 'me' }, true),
			thread('tf', { id: 'node-f', url: url('6'), author: 'someone' }),
			thread('tg', { id: 'node-g', url: url('7'), author: 'me' }, null),
		],
	}
	const found = fixedThreadCandidates(run, review, discussion).map((c) => `${c.gone.finding.id}->${c.thread.id}`)
	assert.deepEqual(found, ['a->ta', 'b->tb'])
	assert.deepEqual(fixedThreadCandidates(run, review, { ...discussion, viewer: null }), [], 'without knowing who you are, nothing')
})

test('rows: confirmed only when the double-check ran cleanly and says the problem is gone', () => {
	const t = thread('t1', { id: 'n', url: null, author: 'me' })
	const check = (verdict: FindingVerification['verdict'], error = false) =>
		({ verdict, reason: `said ${verdict}`, level: null, checked: [], ...(error ? { error: true } : {}) }) as FindingVerification
	const row = (g: GoneFinding) => fixedThread('run1', { gone: g, thread: t }, 'abc1234def')
	assert.deepEqual(row(gone('a', { check: check('wrong') })), {
		runId: 'run1',
		findingId: 'a',
		title: 'Problem a',
		place: 'src/a.ts:14',
		threadId: 't1',
		url: 'https://github.com/o/n/pull/1#t-t1',
		state: 'confirmed',
		reason: 'said wrong',
		commit: 'abc1234def',
	})
	assert.equal(row(gone('a')).state, 'unchecked')
	assert.equal(row(gone('a', { check: check('holds') })).state, 'not-confirmed')
	assert.equal(row(gone('a', { check: check('unsure') })).state, 'not-confirmed')
	assert.equal(row(gone('a', { check: check('wrong', true) })).state, 'not-confirmed', 'a failed check proves nothing')
	assert.equal(row(gone('a', { at: null })).place, 'src/a.ts:10', 'where it was, when its file is gone from the change')
})

test('after a run: the double-checks run one by one without a budget, and none start once a budget you set is reached', async () => {
	const store = ReviewStore.in(mkdtempSync(join(tmpdir(), 'review-fixed-')))
	await store.load()
	const run = { id: 'run1', status: 'completed', connectionId: 'conn', history: { gone: [] } } as unknown as AiRun
	await store.update((d) => {
		d.repos.r = { repoId: 'r', root: '/x', selectedBase: null, activeReviewId: 'rv', reviews: {}, aiRuns: { rv: [run] } }
	})
	const config = async (): Promise<RunConfig> => ({
		provider: createFakeProvider({ script: () => ({}) }),
		connectionId: 'conn',
		connectionLabel: 'Fixture',
		endpoint: 'fixture://local',
		limits: { contextLines: 5, maxBatchChars: 100_000, maxRunChars: 1_000_000, verify: false, relatedCode: false },
	})
	const ai = new AiController(store, config, () => {})
	const checked: Array<string> = []
	ai.checkFixed = async (_a, _r, _run, id) => {
		checked.push(id)
		if (id === 'b') throw new Error('offline')
		return run
	}
	const access = { comparison: { repoId: 'r' } } as unknown as Parameters<AiController['checkFixedMany']>[0]

	await ai.checkFixedMany(access, 'rv', 'run1', ['a', 'b', 'c'], null)
	assert.deepEqual(checked, ['a', 'b', 'c'], 'one failing does not stop the rest')

	ai.attachBudget({ active: () => true, check: () => ({ over: ['Daily budget reached.'], limit: null }) as never })
	await ai.checkFixedMany(access, 'rv', 'run1', ['d'], null)
	assert.deepEqual(checked, ['a', 'b', 'c'], 'over budget: nothing started')

	ai.attachBudget({ active: () => false, check: () => ({ over: [], limit: null }) as never })
	await ai.checkFixedMany(access, 'rv', 'run1', ['d'], { connectionId: 'other', modelId: 'm' })
	assert.deepEqual(checked, ['a', 'b', 'c', 'd'])
})
