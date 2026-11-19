import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GitHubService, type TokenStore } from '../src/main/github.ts'
import { placeComment } from '../src/main/placement.ts'
import { Publisher } from '../src/main/publish.ts'
import { ReviewStore } from '../src/main/store.ts'
import { reviewUpdate } from '../src/main/validate.ts'
import type { Anchor, CredentialStorageInfo, Hunk, Review, ReviewComment } from '../src/shared/types.ts'

const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)
const NEWER = 'c'.repeat(40)
const TOKEN = 'ghp_' + 't'.repeat(36)

// a.ts: lines 10–16 of the new file are in one hunk (3 context, 1 added line 13, 3 context). Old line 13 was removed.
const HUNKS: Array<Hunk> = [
	{
		oldStart: 10,
		oldCount: 7,
		newStart: 10,
		newCount: 7,
		section: '',
		lines: [
			{ kind: 'ctx', oldNo: 10, newNo: 10, text: '' },
			{ kind: 'ctx', oldNo: 11, newNo: 11, text: '' },
			{ kind: 'ctx', oldNo: 12, newNo: 12, text: '' },
			{ kind: 'del', oldNo: 13, newNo: null, text: 'old' },
			{ kind: 'add', oldNo: null, newNo: 13, text: 'new' },
			{ kind: 'ctx', oldNo: 14, newNo: 14, text: '' },
			{ kind: 'ctx', oldNo: 15, newNo: 15, text: '' },
			{ kind: 'ctx', oldNo: 16, newNo: 16, text: '' },
		],
	},
	{ oldStart: 40, oldCount: 1, newStart: 40, newCount: 1, section: '', lines: [{ kind: 'add', oldNo: null, newNo: 40, text: 'x' }] },
]

function anchor(o: Partial<Anchor>): Anchor {
	return {
		repoId: '/r',
		baseSha: BASE,
		headSha: HEAD,
		fileKey: 'a.ts',
		oldPath: 'a.ts',
		newPath: 'a.ts',
		side: 'new',
		startLine: 13,
		endLine: 13,
		excerpt: '',
		...o,
	}
}

test('placement follows GitHub diff rules: in-hunk lines, ranges within one hunk, file comments, outside-diff', () => {
	assert.deepEqual(placeComment(anchor({}), HUNKS), { kind: 'line', path: 'a.ts', side: 'RIGHT', line: 13, startLine: null })
	assert.deepEqual(placeComment(anchor({ startLine: 11, endLine: 15 }), HUNKS), {
		kind: 'line',
		path: 'a.ts',
		side: 'RIGHT',
		line: 15,
		startLine: 11,
	})
	assert.deepEqual(placeComment(anchor({ side: 'old', startLine: 13, endLine: 13 }), HUNKS), {
		kind: 'line',
		path: 'a.ts',
		side: 'LEFT',
		line: 13,
		startLine: null,
	})
	assert.equal(placeComment(anchor({ startLine: 20, endLine: 20 }), HUNKS).kind, 'outside-diff', 'expanded context is not commentable')
	assert.equal(placeComment(anchor({ startLine: 15, endLine: 40 }), HUNKS).kind, 'outside-diff', 'ranges cannot span hunks')
	assert.equal(placeComment(anchor({ startLine: 8, endLine: 12 }), HUNKS).kind, 'outside-diff')
	assert.deepEqual(placeComment(anchor({ side: null, startLine: null, endLine: null }), HUNKS), { kind: 'file', path: 'a.ts' })
	assert.equal(placeComment(anchor({}), null).kind, 'outside-diff', 'binary or too large')
	assert.deepEqual(
		placeComment(anchor({ side: 'old', oldPath: 'old.ts', newPath: 'new.ts' }), HUNKS),
		{ kind: 'line', path: 'new.ts', side: 'LEFT', line: 13, startLine: null },
		'renames use the new path',
	)
})

// ─── Mock of GitHub's pending-review GraphQL API ───────────────────────────────

interface MockComment {
	id: string
	body: string
	path: string
	line: number | null
	side?: string
	startLine?: number | null
	subjectType: string
}
interface MockReview {
	id: string
	author: string
	commit: string
	state: 'PENDING' | 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED'
	body: string
	comments: Array<MockComment>
}

// Input fields GitHub's GraphQL schema accepts (from the public schema, schema.docs.graphql). Anything else is rejected the
// way GitHub rejects it, so a wrong field name fails here instead of against the real API.
const INPUT_FIELDS: Record<string, Array<string>> = {
	AddPullRequestReviewInput: ['body', 'clientMutationId', 'comments', 'commitOID', 'event', 'pullRequestId', 'threads'],
	DraftPullRequestReviewThread: ['body', 'line', 'path', 'side', 'startLine', 'startSide'],
	AddPullRequestReviewThreadInput: [
		'body',
		'clientMutationId',
		'line',
		'path',
		'pullRequestId',
		'pullRequestReviewId',
		'side',
		'startLine',
		'startSide',
		'subjectType',
	],
	UpdatePullRequestReviewCommentInput: ['body', 'clientMutationId', 'pullRequestReviewCommentId'],
	SubmitPullRequestReviewInput: ['body', 'clientMutationId', 'event', 'pullRequestId', 'pullRequestReviewId'],
}

function schemaError(type: string, input: Record<string, unknown>, path = ''): string | null {
	for (const k of Object.keys(input)) {
		if (!INPUT_FIELDS[type].includes(k))
			return `Variable $input of type ${type}! was provided invalid value for ${path}${k} (Field is not defined on ${type})`
	}
	if (type === 'AddPullRequestReviewInput')
		for (const [i, t] of ((input.threads as Array<Record<string, unknown>>) ?? []).entries()) {
			const bad = Object.keys(t).find((k) => !INPUT_FIELDS.DraftPullRequestReviewThread.includes(k))
			if (bad)
				return `Variable $input of type AddPullRequestReviewInput! was provided invalid value for threads.${i}.${bad} (Field is not defined on DraftPullRequestReviewThread)`
		}
	return null
}

async function mockGitHub(
	opts: {
		headSha?: string
		failThreadAfter?: number // later threads are refused one by one, the way GitHub refuses a line outside the diff
		forbidThreadAfter?: number // later threads are refused for lack of access
		failRequests?: number // this many batch requests fail as a whole (a 502) before any write is made
		loseResponses?: number // this many batch requests are made, but their answer never arrives (a 502 after the writes)
		forbidWrites?: boolean
	} = {},
) {
	const reviews: Array<MockReview> = []
	const writes: Array<{ op: string; input: Record<string, unknown> }> = []
	const batches: Array<number> = [] // writes per batch request that reached GitHub
	let reads = 0
	let seq = 0
	let threadsAdded = 0
	let failRequests = opts.failRequests ?? 0
	let loseResponses = opts.loseResponses ?? 0
	const state = { headSha: opts.headSha ?? HEAD }
	const reviewJson = (r: MockReview) => ({
		id: r.id,
		url: `https://github.com/octo/app/pull/7#pullrequestreview-${r.id}`,
		viewerDidAuthor: r.author === 'me',
		commit: { oid: r.commit },
		comments: {
			nodes: r.comments.map((c) => ({ ...c, url: `https://github.com/octo/app/pull/7#discussion_${c.id}`, originalLine: c.line })),
		},
	})
	const comment = (c: Record<string, unknown>): MockComment => ({
		id: `C${++seq}`,
		body: String(c.body),
		path: String(c.path),
		line: (c.line as number) ?? null,
		side: c.side as string,
		startLine: (c.startLine as number) ?? null,
		subjectType: String(c.subjectType ?? 'LINE'),
	})
	const server = http.createServer((req, res) => {
		let raw = ''
		req.on('data', (d) => (raw += d))
		req.on('end', () => {
			const send = (data: unknown) => {
				res.writeHead(200, { 'content-type': 'application/json' })
				res.end(JSON.stringify(data))
			}
			assert.equal(req.headers.authorization, `Bearer ${TOKEN}`)
			const { query, variables } = JSON.parse(raw) as { query: string; variables: Record<string, any> }
			const input = variables.input as Record<string, any>
			const isWrite = query.trimStart().startsWith('mutation')
			if (isWrite && opts.forbidWrites)
				return send({ data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by personal access token' }] })
			// Threads and edits come batched: one aliased mutation per write, run in order, each failing on its own.
			const batch = [...query.matchAll(/(w\d+): (addPullRequestReviewThread|updatePullRequestReviewComment)\(input: \$(i\d+)\)/g)]
			if (batch.length) {
				if (failRequests > 0) {
					failRequests--
					res.writeHead(502, { 'content-type': 'application/json' })
					return res.end(JSON.stringify({ message: 'Bad Gateway' }))
				}
				for (const [, , op, v] of batch) {
					const bad = schemaError(
						op === 'addPullRequestReviewThread' ? 'AddPullRequestReviewThreadInput' : 'UpdatePullRequestReviewCommentInput',
						variables[v],
					)
					if (bad) return send({ errors: [{ message: bad }] })
				}
				batches.push(batch.length)
				const data: Record<string, unknown> = {}
				const errors: Array<{ type?: string; message: string; path: Array<string> }> = []
				for (const [, alias, op, v] of batch) {
					const input = variables[v] as Record<string, any>
					if (op === 'updatePullRequestReviewComment') {
						writes.push({ op: 'update', input })
						const c = reviews.flatMap((r) => r.comments).find((x) => x.id === input.pullRequestReviewCommentId)!
						c.body = input.body
						data[alias] = { pullRequestReviewComment: { id: c.id, url: `u/${c.id}` } }
						continue
					}
					if (opts.forbidThreadAfter !== undefined && threadsAdded >= opts.forbidThreadAfter) {
						data[alias] = null
						errors.push({ type: 'FORBIDDEN', message: 'Resource not accessible by personal access token', path: [alias] })
						continue
					}
					if (opts.failThreadAfter !== undefined && threadsAdded >= opts.failThreadAfter) {
						data[alias] = null
						errors.push({ message: 'Something went wrong', path: [alias] })
						continue
					}
					threadsAdded++
					writes.push({ op: 'thread', input })
					const r = reviews.find((x) => x.id === input.pullRequestReviewId && x.state === 'PENDING')!
					const c = comment(input)
					r.comments.push(c)
					data[alias] = { thread: { comments: { nodes: [{ id: c.id, url: `u/${c.id}` }] } } }
				}
				if (loseResponses > 0) {
					loseResponses--
					res.writeHead(502, { 'content-type': 'application/json' })
					return res.end(JSON.stringify({ message: 'Bad Gateway' }))
				}
				return send({ data, ...(errors.length ? { errors } : {}) })
			}
			if (query.includes('addPullRequestReview(')) {
				writes.push({ op: 'review', input })
				assert.ok(!reviews.some((r) => r.author === 'me' && r.state === 'PENDING'), 'GitHub allows one pending review per user')
				const r: MockReview = {
					id: `R${++seq}`,
					author: 'me',
					commit: input.commitOID,
					state: input.event
						? ({ COMMENT: 'COMMENTED', APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED' } as const)[input.event as 'COMMENT']
						: 'PENDING',
					body: input.body ?? '',
					comments: ((input.threads as Array<Record<string, unknown>> | undefined) ?? []).map(comment),
				}
				reviews.push(r)
				return send({
					data: {
						addPullRequestReview: {
							pullRequestReview: {
								...reviewJson(r),
								comments: { nodes: r.comments.slice(0, 1).map((c) => ({ id: c.id, url: `u/${c.id}` })) },
							},
						},
					},
				})
			}
			if (query.includes('submitPullRequestReview')) {
				writes.push({ op: 'submit', input })
				const r = reviews.find((x) => x.id === input.pullRequestReviewId)!
				r.state = ({ COMMENT: 'COMMENTED', APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED' } as const)[input.event as 'COMMENT']
				r.body = input.body ?? ''
				return send({
					data: { submitPullRequestReview: { pullRequestReview: { id: r.id, url: `u/${r.id}`, submittedAt: '2026-10-01T00:00:00Z' } } },
				})
			}
			// Review state query.
			reads++
			const ids = variables.ids as Array<string>
			const nodes = ids.map((id) => {
				const r = reviews.find((x) => x.id === id)
				return r ? { id: r.id, state: r.state, url: `u/${r.id}`, submittedAt: r.state === 'PENDING' ? null : '2026-10-01T00:00:00Z' } : null
			})
			send({
				data: {
					viewer: { login: 'me' },
					repository: {
						pullRequest: {
							id: 'PR_7',
							url: 'https://github.com/octo/app/pull/7',
							headRefOid: state.headSha,
							reviews: { nodes: reviews.filter((r) => r.state === 'PENDING').map(reviewJson) },
						},
					},
					nodes,
				},
				errors: nodes.some((n) => !n) ? [{ type: 'NOT_FOUND', message: 'Could not resolve to a node', path: ['nodes', 0] }] : undefined,
			})
		})
	})
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
	return { base, reviews, writes, batches, reads: () => reads, state, close: () => new Promise<void>((r) => server.close(() => r())) }
}

function tokens(): TokenStore {
	const info: CredentialStorageInfo = { secure: true, backend: 'test', message: null }
	return {
		async save() {},
		async read() {
			return { state: 'saved', secret: TOKEN }
		},
		peek: () => 'saved',
		async remove() {},
		storageInfo: () => info,
	}
}

function comment(id: string, body: string, a: Partial<Anchor> = {}): ReviewComment {
	return { id, anchor: anchor(a), body, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', findingId: null }
}

async function setup(mockOpts: Parameters<typeof mockGitHub>[0] = {}, comments: Array<ReviewComment> = []) {
	const mock = await mockGitHub(mockOpts)
	const store = ReviewStore.in(mkdtempSync(join(tmpdir(), 'review-pub-')))
	await store.load()
	const id = `${BASE}..${HEAD}`
	const review: Review = {
		id,
		repoId: '/r',
		baseRef: 'main',
		baseTipSha: BASE,
		baseSha: BASE,
		headSha: HEAD,
		headRef: 'alice:feat',
		target: { kind: 'pr', repo: 'octo/app', number: 7 },
		pr: {
			repo: 'octo/app',
			number: 7,
			title: 't',
			url: 'https://github.com/octo/app/pull/7',
			state: 'open',
			baseRef: 'main',
			headLabel: 'alice:feat',
			baseSha: BASE,
			headSha: HEAD,
		},
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z',
		comments,
		drafts: [],
		viewed: [],
		findingDecisions: {},
	}
	await store.update((d) => {
		d.repos['/r'] = { repoId: '/r', root: '/r', selectedBase: null, activeReviewId: id, reviews: { [id]: review }, aiRuns: {} }
	})
	const gh = new GitHubService(tokens(), { base: mock.base })
	const pub = new Publisher(store, gh, async () => HUNKS, { retryMs: 10 })
	// One comment at a time, as most tests here send them.
	const one = async (commentId: string, outside: 'file' | 'skip' = 'skip') => (await pub.publish('/r', id, [commentId], outside))[0]
	const setComments = (c: Array<ReviewComment>) =>
		store.update((d) => {
			d.repos['/r'].reviews[id].comments = c
		})
	return { mock, store, id, pub, one, setComments }
}

test('publishing creates one pending review on the snapshot commit, adds threads to it, and never duplicates', async () => {
	const { mock, store, id, pub, one } = await setup({}, [
		comment('c1', 'line comment'),
		comment('c2', 'range', { startLine: 11, endLine: 15 }),
		comment('c3', 'about the file', { side: null, startLine: null, endLine: null }),
		comment('c4', 'expanded context', { startLine: 20, endLine: 21 }),
		comment('c5', 'on removed line', { side: 'old' }),
	])
	try {
		const plan = await pub.plan('/r', id)
		assert.equal(mock.writes.length, 0, 'planning never writes')
		assert.equal(plan.pending.kind, 'none')
		assert.deepEqual(
			plan.items.map((i) => [i.commentId, i.status, i.placement.kind]),
			[
				['c1', 'new', 'line'],
				['c2', 'new', 'line'],
				['c3', 'new', 'file'],
				['c4', 'new', 'outside-diff'],
				['c5', 'new', 'line'],
			],
		)
		for (const c of ['c1', 'c2', 'c3', 'c5']) assert.equal((await one(c, 'skip')).status, 'published')
		assert.equal((await one('c4', 'skip')).status, 'skipped')
		assert.equal(mock.reviews.length, 1, 'one pending review')
		const r = mock.reviews[0]
		assert.equal(r.state, 'PENDING', 'nothing is visible to others yet')
		assert.equal(r.commit, HEAD, 'attached to the snapshot head, not the latest commit')
		assert.deepEqual(
			r.comments.map((c) => [c.path, c.subjectType, c.side, c.startLine, c.line]),
			[
				['a.ts', 'LINE', 'RIGHT', null, 13],
				['a.ts', 'LINE', 'RIGHT', 11, 15],
				['a.ts', 'FILE', undefined, null, null],
				['a.ts', 'LINE', 'LEFT', null, 13],
			],
		)
		// Publishing again is a no-op.
		const before = mock.writes.length
		assert.equal((await one('c1', 'skip')).status, 'skipped')
		assert.equal(mock.writes.length, before)
		// Outside-diff as a file comment keeps the line reference.
		assert.equal((await one('c4', 'file')).status, 'published')
		assert.match(r.comments.at(-1)!.body, /^\*\*lines 20–21:\*\* expanded context$/)
		assert.equal(r.comments.at(-1)!.subjectType, 'FILE')
		const after = await pub.plan('/r', id)
		assert.ok(after.items.every((i) => i.status === 'published'))
		assert.equal(after.pending.kind !== 'none' && after.pending.comments, 5, 'the plan says how many comments are still pending')
		assert.equal(Object.keys(store.read().repos['/r'].reviews[id].publication!.comments).length, 5)
	} finally {
		await mock.close()
	}
})

test('edits update the pending comment; comments deleted on GitHub become publishable again; submit makes it public', async () => {
	const { mock, store, id, pub, one, setComments } = await setup({}, [comment('c1', 'first')])
	try {
		await one('c1', 'skip')
		await setComments([comment('c1', 'first, edited')])
		assert.equal((await pub.plan('/r', id)).items[0].status, 'changed')
		assert.equal((await one('c1', 'skip')).status, 'updated')
		assert.equal(mock.reviews[0].comments[0].body, 'first, edited')
		assert.equal(mock.reviews[0].comments.length, 1)

		mock.reviews[0].comments = [] // deleted on GitHub
		assert.equal((await pub.plan('/r', id)).items[0].status, 'new')
		await one('c1', 'skip')
		assert.equal(mock.reviews[0].comments.length, 1)

		const prepared = { event: 'REQUEST_CHANGES' as const, body: 'b', head: 'h', at: 't', runId: 'r', reviewer: 'm', comments: 1 }
		await store.update((d) => void (d.repos['/r'].reviews[id].prepared = prepared))
		const s = await pub.submit('/r', id, 'REQUEST_CHANGES', 'Please fix')
		assert.equal(s.state, 'submitted')
		assert.equal(store.read().repos['/r'].reviews[id].prepared, null, 'a prepared review is done once you submit')
		assert.equal(mock.reviews[0].state, 'CHANGES_REQUESTED')
		assert.equal(mock.reviews[0].body, 'Please fix')
		const plan = await pub.plan('/r', id)
		assert.equal(plan.submitted.length, 1)
		assert.equal(plan.pending.kind, 'none')
		// Submitted comments cannot be edited through a pending review.
		await setComments([comment('c1', 'edited after submit')])
		assert.equal((await one('c1', 'skip')).status, 'skipped')
	} finally {
		await mock.close()
	}
})

test('a comment sent before a crash but not recorded is adopted, not posted twice', async () => {
	const { mock, store, id, pub, one } = await setup({}, [comment('c1', 'one'), comment('c2', 'two')])
	try {
		await one('c1', 'skip')
		await one('c2', 'skip')
		// Simulate losing the record of c2 (the app died between GitHub's response and the store write).
		await store.update((d) => {
			delete d.repos['/r'].reviews[id].publication!.comments.c2
		})
		const writes = mock.writes.length
		assert.equal((await one('c2', 'skip')).status, 'published')
		assert.equal(mock.writes.length, writes, 'no new write')
		assert.equal(mock.reviews[0].comments.length, 2)
	} finally {
		await mock.close()
	}
})

test('an existing pending review on another commit blocks publishing; one started on GitHub for this commit is reused', async () => {
	const other = await setup({}, [comment('c1', 'x')])
	try {
		other.mock.reviews.push({ id: 'R0', author: 'me', commit: NEWER, state: 'PENDING', body: '', comments: [] })
		const plan = await other.pub.plan('/r', other.id)
		assert.equal(plan.pending.kind, 'other')
		assert.match(plan.blocked!.message, /one pending review per pull request/)
		await assert.rejects(other.one('c1', 'skip'), /not this snapshot/)
		assert.equal(other.mock.writes.length, 0)
	} finally {
		await other.mock.close()
	}
	const same = await setup({ headSha: NEWER }, [comment('c1', 'x')])
	try {
		same.mock.reviews.push({
			id: 'R0',
			author: 'me',
			commit: HEAD,
			state: 'PENDING',
			body: '',
			comments: [{ id: 'X', body: 'mine from the web', path: 'a.ts', line: 1, subjectType: 'LINE' }],
		})
		const plan = await same.pub.plan('/r', same.id)
		assert.equal(plan.headMoved, true, 'PR has newer commits than the snapshot')
		assert.equal(plan.pending.kind, 'other')
		assert.equal(plan.blocked, null)
		await same.one('c1', 'skip')
		assert.deepEqual(
			same.mock.writes.map((w) => w.op),
			['thread'],
			'added to the existing review',
		)
		assert.equal(same.mock.reviews[0].comments.length, 2)
		// Someone else's pending review is invisible to the viewer and never touched.
		same.mock.reviews.push({ id: 'R9', author: 'bob', commit: HEAD, state: 'PENDING', body: '', comments: [] })
		await same.pub.submit('/r', same.id, 'COMMENT', '')
		assert.equal(same.mock.reviews[0].state, 'COMMENTED')
		assert.equal(same.mock.reviews.find((r) => r.id === 'R9')!.state, 'PENDING')
	} finally {
		await same.mock.close()
	}
})

test('failures are explicit: missing write permission, mid-batch errors, empty submissions, non-PR reviews', async () => {
	const ro = await setup({ forbidWrites: true }, [comment('c1', 'x')])
	try {
		await assert.rejects(ro.one('c1', 'skip'), (e: { code: string; message: string }) => {
			assert.equal(e.code, 'github-forbidden')
			assert.match(e.message, /Read and write/)
			return true
		})
		assert.equal(ro.store.read().repos['/r'].reviews[ro.id].publication, undefined, 'nothing recorded')
	} finally {
		await ro.mock.close()
	}
	const flaky = await setup({ failThreadAfter: 1 }, [comment('c1', 'one'), comment('c2', 'two')])
	try {
		await flaky.one('c1', 'skip')
		const writes = flaky.mock.batches.length
		const refused = await flaky.one('c2', 'skip')
		assert.equal(refused.status, 'failed')
		assert.match(refused.message!, /Something went wrong/)
		assert.equal(flaky.mock.batches.length, writes + 1, 'GitHub refused that comment itself: not tried again')
		const plan = await flaky.pub.plan('/r', flaky.id)
		assert.deepEqual(
			plan.items.map((i) => i.status),
			['published', 'new'],
			'first kept, second retryable',
		)
		// With a pending review, an empty summary is fine: its comments are the content.
		assert.equal((await flaky.pub.submit('/r', flaky.id, 'COMMENT', '')).state, 'submitted')
	} finally {
		await flaky.mock.close()
	}
	const empty = await setup({}, [])
	try {
		await assert.rejects(empty.pub.submit('/r', empty.id, 'COMMENT', '  '), { code: 'invalid-input' })
		const approved = await empty.pub.submit('/r', empty.id, 'APPROVE', '')
		assert.equal(approved.event, 'APPROVE')
		assert.equal(empty.mock.reviews[0].state, 'APPROVED')
		await empty.store.update((d) => {
			d.repos['/r'].reviews[empty.id].pr = null
		})
		await assert.rejects(empty.pub.plan('/r', empty.id), { code: 'invalid-input' })
	} finally {
		await empty.mock.close()
	}
})

test('a failure after creating the pending review reuses that empty review on retry', async () => {
	const t = await setup({ failThreadAfter: 0 }, [comment('c1', 'file note', { side: null, startLine: null, endLine: null })])
	try {
		assert.equal((await t.one('c1', 'skip')).status, 'failed')
		assert.equal(t.mock.reviews.length, 1, 'the empty pending review exists on GitHub')
		assert.equal(t.mock.reviews[0].comments.length, 0)
		assert.equal((await t.pub.plan('/r', t.id)).pending.kind, 'ours', 'and is recorded as this app’s')
	} finally {
		await t.mock.close()
	}
})

test('many comments: one read and one request per ten, in the order given', async () => {
	const many = Array.from({ length: 12 }, (_, i) => comment(`c${i + 1}`, `note ${i + 1}`))
	const t = await setup({}, many)
	try {
		const out = await t.pub.publish(
			'/r',
			t.id,
			many.map((c) => c.id),
			'skip',
		)
		assert.deepEqual(
			out.map((o) => [o.commentId, o.status]),
			many.map((c) => [c.id, 'published']),
		)
		assert.equal(t.mock.reads(), 1, 'GitHub is read once for the lot')
		assert.deepEqual(t.mock.batches, [10, 2])
		assert.deepEqual(
			t.mock.reviews[0].comments.map((c) => c.body),
			many.map((c) => c.body),
		)
		assert.equal(Object.keys(t.store.read().repos['/r'].reviews[t.id].publication!.comments).length, 12)
		// New comments and edits go in the same batch.
		await t.setComments([...many.slice(0, 11), { ...many[11], body: 'note 12, edited' }, comment('c13', 'thirteen')])
		const next = await t.pub.publish('/r', t.id, ['c12', 'c13'], 'skip')
		assert.deepEqual(
			next.map((o) => o.status),
			['updated', 'published'],
		)
		assert.deepEqual(t.mock.batches, [10, 2, 2])
		assert.equal(t.mock.reviews[0].comments[11].body, 'note 12, edited')
	} finally {
		await t.mock.close()
	}
})

test('a batch whose request failed is tried once more, and a write that got through is adopted, not posted twice', async () => {
	const cs = [comment('c1', 'one'), comment('c2', 'two'), comment('c3', 'three')]
	const failed = await setup({ failRequests: 1 }, cs)
	try {
		const out = await failed.pub.publish('/r', failed.id, ['c1', 'c2', 'c3'], 'skip')
		assert.deepEqual(
			out.map((o) => o.status),
			['published', 'published', 'published'],
		)
		assert.equal(failed.mock.reviews[0].comments.length, 3)
	} finally {
		await failed.mock.close()
	}
	const lost = await setup({ loseResponses: 1 }, cs)
	try {
		const out = await lost.pub.publish('/r', lost.id, ['c1', 'c2', 'c3'], 'skip')
		assert.deepEqual(
			out.map((o) => o.status),
			['published', 'published', 'published'],
		)
		assert.equal(lost.mock.reviews[0].comments.length, 3, 'the retry found them in the pending review')
		assert.deepEqual(lost.mock.batches, [3], 'and sent nothing again')
	} finally {
		await lost.mock.close()
	}
	const down = await setup({ failRequests: 2 }, cs)
	try {
		const out = await down.pub.publish('/r', down.id, ['c1', 'c2'], 'skip')
		assert.deepEqual(
			out.map((o) => [o.status, o.message]),
			[
				['failed', 'GitHub returned 502: Bad Gateway.'],
				['failed', 'GitHub returned 502: Bad Gateway.'],
			],
			'only once more',
		)
	} finally {
		await down.mock.close()
	}
})

test('access refused partway stops publishing, and what got through stays recorded', async () => {
	const cs = [comment('c1', 'one'), comment('c2', 'two'), comment('c3', 'three')]
	const t = await setup({ forbidThreadAfter: 1 }, cs)
	try {
		await assert.rejects(t.pub.publish('/r', t.id, ['c1', 'c2', 'c3'], 'skip'), { code: 'github-forbidden' })
		assert.deepEqual(
			(await t.pub.plan('/r', t.id)).items.map((i) => i.status),
			['published', 'new', 'new'],
		)
	} finally {
		await t.mock.close()
	}
})

test('file-level comments go into the pending review as FILE threads, never inline in addPullRequestReview', async () => {
	const t = await setup({}, [comment('c1', 'about the file', { side: null, startLine: null, endLine: null })])
	try {
		assert.equal((await t.one('c1', 'skip')).status, 'published')
		assert.deepEqual(
			t.mock.writes.map((w) => w.op),
			['review', 'thread'],
		)
		assert.equal(t.mock.writes[0].input.threads, undefined, 'the review is created empty')
		assert.equal(t.mock.writes[1].input.subjectType, 'FILE')
		assert.equal(t.mock.reviews[0].state, 'PENDING')
	} finally {
		await t.mock.close()
	}
})

test('the renderer cannot overwrite publication records through saveReview', () => {
	const stored = {
		id: 'x',
		repoId: '/r',
		baseSha: BASE,
		headSha: HEAD,
		comments: [],
		drafts: [],
		viewed: [],
		findingDecisions: {},
	} as unknown as Review
	const next = reviewUpdate({ ...stored, publication: { comments: { evil: {} } } }, stored, new Map())
	assert.deepEqual(Object.keys(next).sort(), ['comments', 'context', 'drafts', 'findingDecisions', 'viewed'])
	assert.equal(next.context, undefined)
})

test('carried comments: one published from an earlier snapshot is not posted again; an outdated one is outside the diff', async () => {
	const earlier = anchor({ headSha: NEWER, startLine: 13, endLine: 14 })
	const carried = (published: boolean, outdated: boolean) => ({
		reviewId: 'earlier',
		commentId: 'old',
		originId: 'old',
		anchor: earlier,
		outdated: outdated ? { reason: 'The commented lines changed.', code: ['x', 'y'] } : null,
		published: published ? { url: 'https://github.com/octo/app/pull/7#discussion_r1' } : null,
	})
	const t = await setup({}, [
		{ ...comment('c1', 'already on GitHub'), carried: carried(true, false) },
		{ ...comment('c2', 'outdated', { side: null, startLine: null, endLine: null }), carried: carried(false, true) },
	])
	try {
		const plan = await t.pub.plan('/r', t.id)
		assert.deepEqual(
			plan.items.map((i) => [i.commentId, i.status, i.placement.kind, i.label]),
			[
				['c1', 'published', 'line', 'a.ts:13'],
				['c2', 'new', 'outside-diff', 'a.ts:13–14'],
			],
		)
		assert.equal(plan.items[0].url, 'https://github.com/octo/app/pull/7#discussion_r1')
		assert.equal((await t.one('c1', 'file')).status, 'skipped')
		assert.equal((await t.one('c2', 'skip')).status, 'skipped')
		assert.equal(t.mock.writes.length, 0)
		assert.equal((await t.one('c2', 'file')).status, 'published')
		const posted = t.mock.reviews[0].comments[0]
		assert.equal(posted.subjectType, 'FILE')
		assert.equal(posted.body, `**lines 13–14 at ${NEWER.slice(0, 7)}:** outdated`, 'names the lines and the commit they were on')
	} finally {
		await t.mock.close()
	}
})
