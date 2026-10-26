import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fromGraphql, fromRest, safeUrl, type Activity, type RawThread } from '../src/main/activity.ts'
import { discussionOf, placeThreads } from '../src/main/discussion.ts'
import { compareSnapshot } from '../src/main/git.ts'
import { GitHubService, type TokenStore } from '../src/main/github.ts'
import { asksYou, discussedAt, hasReply, isNewSince, matchesThread, ownThread, sinceMine } from '../src/renderer/src/discussed.ts'
import type { Anchor, Comparison, CredentialStorageInfo, DiscussionComment, DiscussionThread, MyLastReview } from '../src/shared/types.ts'

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'review-disc-'))
}

const lines = (n: number, edit: Record<number, string> = {}, top: Array<string> = []): string =>
	[...top, ...Array.from({ length: n }, (_, i) => edit[i + 1] ?? `l${i + 1}`)].join('\n') + '\n'

/** base → v1 (the snapshot being reviewed) → v2 (the PR head GitHub reports positions for). */
function world() {
	const dir = tmp()
	const run = (...a: Array<string>): string =>
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
			cwd: dir,
			encoding: 'utf8',
		}).trim()
	const commit = (files: Record<string, string>, msg: string): string => {
		for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text)
		run('add', '-A')
		run('commit', '-qm', msg)
		return run('rev-parse', 'HEAD')
	}
	run('init', '-q', '-b', 'main')
	const base = commit({ 'f.txt': lines(20), 'g.txt': 'g\n' }, 'base')
	const v1 = commit({ 'f.txt': lines(20, { 5: 'A5', 15: 'A15' }) }, 'v1')
	// v2 adds two lines at the top and rewrites line 15 again.
	const v2 = commit({ 'f.txt': lines(20, { 5: 'A5', 15: 'B15' }, ['n1', 'n2']) }, 'v2')
	return { dir, base, v1, v2 }
}

async function snapshot(dir: string, base: string, head: string): Promise<Comparison> {
	const d = await compareSnapshot(dir, {
		repoId: dir,
		baseRef: 'main',
		baseTipSha: base,
		baseSha: base,
		headSha: head,
		headRef: 'feat',
		target: { kind: 'pr', repo: 'octo/app', number: 7 },
		pr: {
			repo: 'octo/app',
			number: 7,
			title: 't',
			url: '',
			state: 'open',
			baseRef: 'main',
			headLabel: 'feat',
			baseSha: base,
			headSha: head,
		},
	})
	return d.comparison
}

function thread(o: Partial<RawThread>): RawThread {
	return {
		id: o.id ?? 'T',
		path: 'f.txt',
		subject: 'line',
		side: 'new',
		line: null,
		startLine: null,
		originalLine: null,
		originalStartLine: null,
		originalCommit: null,
		resolved: false,
		resolvedBy: null,
		outdated: false,
		diffHunk: null,
		comments: [
			{
				id: `${o.id}-c`,
				author: 'alice',
				association: 'MEMBER',
				body: 'hi',
				bodyTruncated: false,
				createdAt: null,
				url: null,
				pending: false,
			},
		],
		commentsOmitted: 0,
		url: null,
		...o,
	}
}

function activity(headSha: string, baseSha: string, threads: Array<RawThread>): Activity {
	return {
		headSha,
		baseSha,
		threads,
		reviews: [],
		conversation: [],
		omitted: { threads: 0, comments: 0, reviews: 0, conversation: 0 },
		partial: null,
	}
}

test('threads are placed on the snapshot only where GitHub reports a current position, carried over unchanged lines', async () => {
	const w = world()
	const snap = await snapshot(w.dir, w.base, w.v1) // reviewing v1 while the PR is at v2
	const a = activity(w.v2, w.base, [
		thread({ id: 'shifted', line: 7, startLine: 7 }), // v2 line 7 = v1 line 5 ("A5")
		thread({ id: 'changed', line: 17 }), // v2 line 17 = "B15", which is A15 in v1
		thread({ id: 'outdated', outdated: true, line: null, originalLine: 3, originalCommit: w.base }),
		thread({ id: 'written-here', outdated: true, line: null, originalLine: 15, originalStartLine: 14, originalCommit: w.v1 }),
		thread({ id: 'file', subject: 'file', side: null }),
		thread({ id: 'old-side', side: 'old', line: 5 }),
		thread({ id: 'elsewhere', path: 'g.txt', line: 1 }),
	])
	const placed = new Map((await placeThreads(w.dir, snap, a)).map((t) => [t.id, t]))
	assert.deepEqual(placed.get('shifted')!.placed, { fileKey: 'f.txt', startLine: 5, endLine: 5 }, 'follows the two inserted lines')
	assert.equal(placed.get('changed')!.placed, null)
	assert.match(placed.get('changed')!.unplaced!, /lines differ/)
	assert.equal(placed.get('outdated')!.placed, null, 'originalLine is never applied to other code')
	assert.match(placed.get('outdated')!.unplaced!, /Outdated on GitHub/)
	assert.deepEqual(placed.get('written-here')!.placed, { fileKey: 'f.txt', startLine: 14, endLine: 15 }, 'exact on its own commit')
	assert.deepEqual(placed.get('file')!.placed, { fileKey: 'f.txt', startLine: null, endLine: null })
	assert.equal(placed.get('old-side')!.placed, null, 'old-side positions belong to the PR head version')
	assert.equal(placed.get('elsewhere')!.placed, null)
	assert.equal(placed.get('elsewhere')!.fileKey, null)
	assert.match(placed.get('elsewhere')!.unplaced!, /not part of this snapshot/)

	// On the snapshot GitHub's positions are for, they apply as they are, on both sides.
	const cur = await snapshot(w.dir, w.base, w.v2)
	const here = new Map(
		(await placeThreads(w.dir, cur, activity(w.v2, w.base, [thread({ id: 'old-side', side: 'old', line: 5, startLine: 4 })]))).map((t) => [
			t.id,
			t,
		]),
	)
	assert.deepEqual(here.get('old-side')!.placed, { fileKey: 'f.txt', startLine: 4, endLine: 5 })

	// A PR head that isn't in the local repository can't be mapped; it is listed, not guessed.
	const missing = await placeThreads(w.dir, snap, activity('f'.repeat(40), w.base, [thread({ id: 'x', line: 7 })]))
	assert.match(missing[0].unplaced!, /newer version of the PR/)

	const d = discussionOf(snap, a, [...placed.values()])
	assert.equal(d.status, 'complete')
	assert.match(d.reason!, /GitHub's positions are for/)
})

test('GraphQL and REST activity are normalised; links outside github.com and empty or pending reviews are dropped', () => {
	assert.equal(safeUrl('https://github.com/o/r/pull/1#discussion_r1'), 'https://github.com/o/r/pull/1#discussion_r1')
	assert.equal(safeUrl('https://evil.example/github.com/'), null)
	assert.equal(safeUrl('javascript:alert(1)'), null)

	const g = fromGraphql([
		{
			headRefOid: 'h',
			baseRefOid: 'b',
			reviewThreads: {
				totalCount: 3,
				pageInfo: { hasNextPage: false, endCursor: null },
				nodes: [
					{
						id: 'T1',
						isResolved: true,
						isOutdated: true,
						resolvedBy: { login: 'bob' },
						path: 'f.txt',
						line: null,
						startLine: null,
						originalLine: 4,
						originalStartLine: null,
						diffSide: 'RIGHT',
						subjectType: 'LINE',
						comments: {
							totalCount: 35,
							nodes: [
								{
									id: 'C1',
									body: 'x'.repeat(25_000),
									author: null,
									authorAssociation: 'NONE',
									createdAt: null,
									url: 'https://evil.example/',
									state: 'SUBMITTED',
									diffHunk: '@@ -1 +1 @@',
									originalCommit: { oid: 'o' },
								},
							],
						},
					},
				],
			},
			reviews: {
				totalCount: 3,
				nodes: [
					{ id: 'R1', author: { login: 'a' }, state: 'APPROVED', body: '', submittedAt: null, url: 'https://github.com/r' },
					{ id: 'R2', author: { login: 'a' }, state: 'COMMENTED', body: '  ', submittedAt: null, url: null },
					{ id: 'R3', author: { login: 'a' }, state: 'PENDING', body: 'draft', submittedAt: null, url: null },
				],
			},
			comments: { totalCount: 0, nodes: [] },
		},
	])
	const t = g.threads[0]
	assert.deepEqual([t.resolved, t.resolvedBy, t.outdated, t.side, t.originalCommit, t.url], [true, 'bob', true, 'new', 'o', null])
	assert.equal(t.comments[0].bodyTruncated, true)
	assert.equal(t.comments[0].body.length, 20_000)
	assert.equal(t.commentsOmitted, 34)
	assert.deepEqual(
		g.reviews.map((r) => r.id),
		['R1'],
	)
	assert.deepEqual(g.omitted, { threads: 2, comments: 34, reviews: 0, conversation: 0 })
	assert.equal(g.partial, null)

	const rc = (id: number, o: object) => ({
		id,
		node_id: `N${id}`,
		path: 'f.txt',
		line: 3,
		start_line: null,
		original_line: 3,
		original_start_line: null,
		side: 'RIGHT',
		diff_hunk: null,
		original_commit_id: 'o',
		user: { login: `u${id}` },
		author_association: 'MEMBER',
		body: `b${id}`,
		created_at: null,
		html_url: `https://github.com/c/${id}`,
		...o,
	})
	const r = fromRest(
		{ headSha: 'h', baseSha: 'b' },
		[rc(1, {}), rc(2, { in_reply_to_id: 1 }), rc(3, { line: null, side: 'LEFT' }), rc(4, { subject_type: 'file', line: null })],
		false,
		[],
		[],
	)
	assert.equal(r.threads.length, 3, 'replies join their thread')
	assert.deepEqual(
		r.threads[0].comments.map((c) => c.author),
		['u1', 'u2'],
	)
	assert.equal(r.threads[0].resolved, null, 'REST cannot tell')
	assert.deepEqual([r.threads[1].outdated, r.threads[1].side], [true, 'old'])
	assert.deepEqual([r.threads[2].subject, r.threads[2].outdated], ['file', false])
	assert.match(r.partial!, /without a GitHub token/)
})

test('"already discussed" matches placed threads on overlapping lines of the same side, file threads for file comments, never its own thread', () => {
	const t = (o: Partial<DiscussionThread>): DiscussionThread => ({
		id: 'T',
		path: 'f.txt',
		subject: 'line',
		side: 'new',
		resolved: false,
		resolvedBy: null,
		outdated: false,
		placed: { fileKey: 'f.txt', startLine: 10, endLine: 12 },
		unplaced: null,
		fileKey: 'f.txt',
		originalLine: null,
		diffHunk: null,
		comments: [
			{
				id: 'G1',
				author: 'a',
				association: null,
				body: '',
				bodyTruncated: false,
				createdAt: null,
				url: 'https://github.com/x',
				pending: false,
			},
		],
		commentsOmitted: 0,
		url: null,
		...o,
	})
	const a = (o: Partial<Anchor>): Anchor => ({
		repoId: 'r',
		baseSha: 'b',
		headSha: 'h',
		fileKey: 'f.txt',
		oldPath: 'f.txt',
		newPath: 'f.txt',
		side: 'new',
		startLine: 12,
		endLine: 14,
		excerpt: '',
		...o,
	})
	const threads = [
		t({ id: 'line' }),
		t({ id: 'old', side: 'old' }),
		t({ id: 'file', subject: 'file', side: null, placed: { fileKey: 'f.txt', startLine: null, endLine: null } }),
		t({ id: 'unplaced', placed: null, unplaced: 'outdated' }),
		t({ id: 'other', placed: { fileKey: 'g.txt', startLine: 10, endLine: 12 } }),
	]
	const ids = (xs: Array<DiscussionThread>) => xs.map((x) => x.id)
	assert.deepEqual(ids(discussedAt(threads, a({}))), ['line'])
	assert.deepEqual(ids(discussedAt(threads, a({ startLine: 13 }))), [], 'adjacent lines are not the same lines')
	assert.deepEqual(ids(discussedAt(threads, a({ side: 'old', startLine: 1, endLine: 10 }))), ['old'])
	assert.deepEqual(ids(discussedAt(threads, a({ side: null, startLine: null, endLine: null }))), ['file'])
	assert.deepEqual(ids(discussedAt(threads, a({}), new Set(['https://github.com/x']))), [], 'its own published thread')

	// The thread a comment was published as is found by its first comment, never by a reply.
	const reply = { ...threads[0].comments[0], id: 'R1', url: 'https://github.com/reply' }
	const mine = t({ id: 'mine', comments: [{ ...threads[0].comments[0], id: 'G9', url: 'https://github.com/mine' }, reply] })
	assert.equal(ownThread([...threads, mine], new Set(['G9']))?.id, 'mine', 'by GitHub id')
	assert.equal(ownThread([...threads, mine], new Set(['https://github.com/mine']))?.id, 'mine', 'by link')
	assert.equal(ownThread([mine], new Set(['https://github.com/reply'])), null, 'a reply is not the thread’s start')
	assert.equal(ownThread([mine], new Set()), null, 'not published')
})

function tokens(token: string | null): TokenStore {
	const info: CredentialStorageInfo = { secure: true, backend: 'test', message: null }
	return {
		async save() {},
		async read() {
			return token ? { state: 'saved', secret: token } : { state: 'none', secret: null }
		},
		peek: () => (token ? 'saved' : 'none'),
		async remove() {},
		storageInfo: () => info,
	}
}

test('activity reads GitHub only: GraphQL pages through threads with a token, REST without one', async () => {
	const seen: Array<string> = []
	const server = http.createServer((req, res) => {
		let raw = ''
		req.on('data', (c) => (raw += c))
		req.on('end', () => {
			seen.push(`${req.method} ${req.url}`)
			const send = (v: unknown) => {
				res.writeHead(200, { 'content-type': 'application/json' })
				res.end(JSON.stringify(v))
			}
			if (req.url === '/graphql') {
				const { query, variables } = JSON.parse(raw)
				assert.doesNotMatch(query, /mutation/)
				const page = variables.after ? 2 : 1
				const node = (id: string) => ({
					id,
					isResolved: false,
					isOutdated: false,
					resolvedBy: null,
					path: 'f.txt',
					line: 1,
					startLine: null,
					originalLine: 1,
					originalStartLine: null,
					diffSide: 'RIGHT',
					subjectType: 'LINE',
					comments: { totalCount: 1, nodes: [] },
				})
				return send({
					data: {
						repository: {
							pullRequest: {
								headRefOid: 'h',
								baseRefOid: 'b',
								reviewThreads: {
									totalCount: 2,
									pageInfo: { hasNextPage: page === 1, endCursor: page === 1 ? 'c1' : null },
									nodes: [node(`T${page}`)],
								},
								...(variables.first ? { reviews: { totalCount: 0, nodes: [] }, comments: { totalCount: 0, nodes: [] } } : {}),
							},
						},
					},
				})
			}
			if (req.url === '/repos/octo/app/pulls/7')
				return send({
					number: 7,
					title: 't',
					body: '',
					html_url: '',
					state: 'open',
					merged_at: null,
					closed_at: null,
					created_at: '',
					updated_at: '',
					user: null,
					head: { ref: 'f', sha: 'h', user: null, repo: null },
					base: { ref: 'main', sha: 'b', user: null, repo: { full_name: 'octo/app' } },
				})
			return send([])
		})
	})
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
	try {
		const authed = await new GitHubService(tokens('ghp_' + 't'.repeat(36)), { base }).activity('octo/app', 7)
		assert.deepEqual(
			authed.threads.map((t) => t.id),
			['T1', 'T2'],
		)
		assert.equal(authed.partial, null)
		assert.ok(seen.every((s) => s === 'POST /graphql'))
		seen.length = 0
		const anon = await new GitHubService(tokens(null), { base }).activity('octo/app', 7)
		assert.match(anon.partial!, /resolved/)
		assert.ok(
			seen.every((s) => s.startsWith('GET ')),
			'anonymous reads are plain GETs',
		)
		assert.ok(seen.includes('GET /repos/octo/app/pulls/7/comments?per_page=100&page=1'))
	} finally {
		await new Promise<void>((r) => server.close(() => r()))
	}
})

test('replyToThread checks the thread is on this PR, then replies and resolves', async () => {
	const sent: Array<string> = []
	const gh = new GitHubService(tokens('ghp_' + 't'.repeat(36)), {
		fetch: async (_url, init) => {
			const q = JSON.parse(String(init?.body)).query as string
			const name = /(addPullRequestReviewThreadReply|resolveReviewThread|node)\(/.exec(q)![1]
			sent.push(name)
			const data =
				name === 'node'
					? { node: { pullRequest: { number: 7, repository: { nameWithOwner: 'o/r' } } } }
					: { [name]: { comment: { id: 'c' } } }
			return new Response(JSON.stringify({ data }), { status: 200 })
		},
	})
	await gh.replyToThread('o/r', 7, 'T1', 'Done', true)
	assert.deepEqual(sent, ['node', 'addPullRequestReviewThreadReply', 'resolveReviewThread'])
	sent.length = 0
	await gh.replyToThread('o/r', 7, 'T1', '  ', true)
	assert.deepEqual(sent, ['node', 'resolveReviewThread'], 'blank text: resolve only')
	sent.length = 0
	await assert.rejects(gh.replyToThread('o/r', 8, 'T1', 'x', false), /not on this pull request/)
	assert.deepEqual(sent, ['node'], 'nothing written to another PR’s thread')
})

test('thread filters: open/resolved, anyone who wrote in it, and whether someone else answered', () => {
	const c = (author: string | null) => ({
		id: author ?? 'x',
		author,
		association: null,
		body: '',
		bodyTruncated: false,
		createdAt: null,
		url: null,
		pending: false,
	})
	const t = (resolved: boolean | null, authors: Array<string | null>, omitted = 0) =>
		({ resolved, comments: authors.map(c), commentsOmitted: omitted }) as unknown as DiscussionThread
	const open = t(false, ['me', 'ann'])
	const done = t(true, ['bob'])
	const unknown = t(null, ['me'])
	const pick = (s: Parameters<typeof matchesThread>[1], a: string | null = null) =>
		[open, done, unknown].filter((x) => matchesThread(x, s, a))
	assert.deepEqual(pick('all'), [open, done, unknown])
	assert.deepEqual(pick('open'), [open])
	assert.deepEqual(pick('resolved'), [done])
	assert.deepEqual(pick('all', 'ann'), [open], 'a reply counts, not only who started it')
	assert.equal(hasReply(open), true)
	assert.equal(hasReply(t(false, ['me', 'me'])), false, 'only my own follow-ups')
	assert.equal(hasReply(t(false, ['me'], 2)), true, 'replies GitHub left out')
})

test('your last review: the newest one you submitted, even with only inline comments; none without knowing who you are', () => {
	const page = (reviews: Array<{ login: string; state: string; at: string; commit: string }>) => ({
		headRefOid: 'h',
		baseRefOid: 'b',
		reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
		reviews: {
			totalCount: reviews.length,
			nodes: reviews.map((r, i) => ({
				id: `R${i}`,
				author: { login: r.login },
				state: r.state,
				body: '',
				submittedAt: r.at,
				url: `https://github.com/r/${i}`,
				commit: { oid: r.commit },
			})),
		},
		comments: { totalCount: 0, nodes: [] },
	})
	const p = page([
		{ login: 'me', state: 'CHANGES_REQUESTED', at: '2026-10-01T10:00:00Z', commit: 'c1' },
		{ login: 'me', state: 'COMMENTED', at: '2026-10-03T10:00:00Z', commit: 'c2' }, // inline comments only
		{ login: 'ann', state: 'APPROVED', at: '2026-10-04T10:00:00Z', commit: 'c3' },
		{ login: 'me', state: 'PENDING', at: '2026-10-05T10:00:00Z', commit: 'c3' },
	])
	const g = fromGraphql([p], 'me')
	assert.deepEqual(g.mine, { viewer: 'me', state: 'COMMENTED', at: '2026-10-03T10:00:00Z', commit: 'c2', url: 'https://github.com/r/1' })
	assert.deepEqual(
		g.reviews.map((r) => r.id),
		['R0', 'R2'],
		'the list still leaves out empty and pending reviews',
	)
	assert.equal(fromGraphql([p]).mine, null)
	const r = fromRest(
		{ headSha: 'h', baseSha: 'b' },
		[],
		false,
		[
			{
				node_id: 'N',
				user: { login: 'me' },
				state: 'APPROVED',
				body: null,
				submitted_at: '2026-10-02T00:00:00Z',
				html_url: null,
				commit_id: 'c9',
			},
		],
		[],
		'me',
	)
	assert.equal(r.mine?.commit, 'c9')
})

test('a thread’s code changed since your review: compared with the commit you reviewed, not when it was written', async () => {
	const w = world()
	const snap = await snapshot(w.dir, w.base, w.v2)
	const mine = { viewer: 'me', state: 'CHANGES_REQUESTED', at: '2026-10-10T00:00:00Z', commit: w.v1, url: null }
	const later = (o: Partial<RawThread>) =>
		thread({ ...o, comments: [{ ...thread({}).comments[0], id: `${o.id}-c`, createdAt: '2026-10-11T00:00:00Z' }] })
	const a: Activity = {
		...activity(w.v2, w.base, [
			thread({ id: 'same', line: 7, startLine: 7 }), // v2 line 7 = v1 line 5, unchanged
			thread({ id: 'fixed', line: 17 }), // v2 line 17 = "B15", was "A15" when you reviewed
			thread({ id: 'out-after', outdated: true, line: null, originalLine: 15, originalCommit: w.v1 }),
			thread({ id: 'out-before', outdated: true, line: null, originalLine: 15, originalCommit: w.base }), // already outdated at v1
			thread({ id: 'file', subject: 'file', side: null }),
			thread({ id: 'old-side', side: 'old', line: 5 }),
			later({ id: 'started-after', line: 7 }),
		]),
		mine,
	}
	const by = async (x: Activity) => new Map((await placeThreads(w.dir, snap, x)).map((t) => [t.id, t.changedSinceMine]))
	const got = await by(a)
	assert.deepEqual(Object.fromEntries(got), {
		same: false,
		fixed: true,
		'out-after': true,
		'out-before': false,
		file: true,
		'old-side': null,
		'started-after': null,
	})
	assert.ok(
		[...(await by({ ...a, mine: { ...mine, commit: w.v2 } })).values()].every((v) => v === false),
		'reviewed the head',
	)
	assert.ok(
		[...(await by({ ...a, mine: null })).values()].every((v) => v === null),
		'no review to compare with',
	)
	assert.ok(
		[...(await by({ ...a, mine: { ...mine, commit: 'e'.repeat(40) } })).values()].every((v) => v === null),
		'the commit you reviewed is not here',
	)
	assert.deepEqual(discussionOf(snap, a, []).mine, mine)
})

test('since your review: new threads, replies, silent fixes and threads still waiting, in that order of interest', () => {
	const mine: MyLastReview = { viewer: 'me', state: 'CHANGES_REQUESTED', at: '2026-10-10T00:00:00Z', commit: 'c', url: null }
	const c = (author: string, at: string, pending = false): DiscussionComment => ({
		id: `${author}${at}`,
		author,
		association: null,
		body: '',
		bodyTruncated: false,
		createdAt: at,
		url: null,
		pending,
	})
	const before = '2026-10-09T00:00:00Z'
	const after = '2026-10-11T00:00:00Z'
	const t = (comments: Array<DiscussionComment>, o: Partial<DiscussionThread> = {}) =>
		({ resolved: false, changedSinceMine: false, comments, commentsOmitted: 0, ...o }) as DiscussionThread
	assert.equal(sinceMine(t([c('ann', after)]), mine), 'new')
	assert.equal(sinceMine(t([c('me', after)]), mine), null, 'your own new thread')
	assert.equal(sinceMine(t([c('me', before), c('ann', after)]), mine), 'replied')
	assert.equal(sinceMine(t([c('bob', before), c('ann', after)]), mine), 'replied', 'answers in others’ threads count too')
	assert.equal(sinceMine(t([c('me', before), c('me', after)]), mine), 'waiting', 'only your own follow-up')
	assert.equal(sinceMine(t([c('me', before)], { changedSinceMine: true }), mine), 'changed')
	assert.equal(sinceMine(t([c('me', before)], { changedSinceMine: true, resolved: true }), mine), 'changed', 'fixed and resolved')
	assert.equal(sinceMine(t([c('me', before)], { resolved: true }), mine), null)
	assert.equal(sinceMine(t([c('bob', before)], { changedSinceMine: true }), mine), null, 'not one you took part in')
	assert.equal(sinceMine(t([c('me', before), c('ann', after, true)]), mine), 'waiting', 'unsubmitted replies are not new')
	assert.equal(isNewSince({ submittedAt: after }, mine), true)
	assert.equal(isNewSince({ createdAt: null }, mine), false)
	const quiet = t([c('bob', before)])
	assert.equal(matchesThread(quiet, 'since', null, mine), false)
	assert.equal(matchesThread(t([c('me', before)]), 'since', null, mine), true)
	assert.equal(matchesThread(quiet, 'since', null, null), false, 'no review to count from')
})

test('asks you: the last word is someone else’s question in your thread, or names you; answering clears it', () => {
	const c = (author: string, body: string, pending = false): DiscussionComment => ({
		id: `${author}:${body}`,
		author,
		association: null,
		body,
		bodyTruncated: false,
		createdAt: '2026-10-01T00:00:00Z',
		url: null,
		pending,
	})
	const t = (comments: Array<DiscussionComment>, o: Partial<DiscussionThread> = {}) =>
		({ resolved: false, comments, commentsOmitted: 0, ...o }) as DiscussionThread
	const mine = (q: string) => t([c('me', 'This can be null.'), c('ann', q)])
	assert.equal(asksYou(mine('Do you agree?'), 'me'), true)
	assert.equal(asksYou(mine('What would you suggest instead? I tried a guard.'), 'me'), true, 'a question mid-text')
	assert.equal(asksYou(mine('wdyt'), 'me'), true)
	assert.equal(asksYou(mine('Fixed in abc123.'), 'me'), false)
	assert.equal(asksYou(mine('Changed `a?.b` to a guard'), 'me'), false, 'a "?" in code')
	assert.equal(asksYou(mine('```ts\nconst x = a ? b : c\n```\nDone'), 'me'), false, 'a "?" in a code block')
	assert.equal(asksYou(mine('> can this be null?\nNo, it is checked above.'), 'me'), false, 'a quoted question')
	assert.equal(asksYou(mine('See https://example.com/?q=1'), 'me'), false, 'a "?" in a link')
	assert.equal(asksYou(t([c('me', 'Null?'), c('ann', 'Yes?'), c('me', 'Then guard it.')]), 'me'), false, 'you answered')
	assert.equal(asksYou({ ...mine('Do you agree?'), resolved: true }, 'me'), false)
	assert.equal(asksYou({ ...mine('Do you agree?'), commentsOmitted: 3 }, 'me'), false, 'the last reply may not be shown')
	assert.equal(asksYou(t([c('bob', 'Hmm.'), c('ann', 'Any idea?')]), 'me'), false, 'not your thread, not named')
	assert.equal(asksYou(t([c('bob', 'Hmm.'), c('ann', '@me can you check this.')]), 'me'), true, 'named, even without "?"')
	assert.equal(asksYou(t([c('bob', 'Hmm.'), c('ann', 'cc @meow')]), 'me'), false, 'a longer login')
	assert.equal(asksYou(t([c('bob', 'Hmm.'), c('ann', 'mail me@example.com')]), 'me'), false)
	assert.equal(asksYou(t([c('me', 'Null?'), c('ann', 'Do you agree?'), c('me', 'draft', true)]), 'me'), true, 'an unsent reply')
	assert.equal(asksYou(mine('Do you agree?'), null), false, 'without knowing who you are')
	const review: MyLastReview = { viewer: 'me', state: 'COMMENTED', at: '2026-10-10T00:00:00Z', commit: null, url: null }
	assert.equal(sinceMine(mine('Do you agree?'), review), 'asked', 'still waiting, though asked before your last review')
})
