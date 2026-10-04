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
import { discussedAt } from '../src/renderer/src/discussed.ts'
import type { Anchor, Comparison, CredentialStorageInfo, DiscussionThread } from '../src/shared/types.ts'

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
