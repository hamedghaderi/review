import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { diffInbox, inboxStatus, sortInbox, type WatchedPr } from '../src/shared/inbox.ts'
import { GitHubService, type TokenStore } from '../src/main/github.ts'
import { InboxWatcher, type RepoEvent } from '../src/main/inboxWatch.ts'
import { ReviewStore } from '../src/main/store.ts'
import type { CredentialStorageInfo, PrSummary, PrReviewer } from '../src/shared/types.ts'

const pr = (number: number, mine: Partial<PrReviewer> | null = null, over: Partial<PrSummary> = {}): PrSummary => ({
	number,
	title: `PR ${number}`,
	author: 'bob',
	state: 'open',
	headRef: `h${number}`,
	headOwner: 'o',
	baseRef: 'main',
	crossRepo: false,
	updatedAt: `2026-10-0${number % 9}T00:00:00Z`,
	url: `u${number}`,
	reviewRequested: null,
	reviewers: [],
	review: { decision: null, reviewers: mine ? [{ login: 'Me', verdict: 'commented', at: null, stale: false, ...mine }] : [] },
	...over,
})

test('inbox status: new until looked at, re-requested after your review, new commits after your review', () => {
	assert.equal(inboxStatus(pr(1), 'me', true, false), 'new')
	assert.equal(inboxStatus(pr(1), 'me', true, true), 'waiting')
	assert.equal(inboxStatus(pr(1, {}), 'me', true, false), 're-requested', 'requested again after reviewing (login case ignored)')
	assert.equal(inboxStatus(pr(1, { stale: true }), 'me', false, true), 'updated')
	assert.equal(inboxStatus(pr(1, {}), 'me', false, true), 'reviewed')
	assert.equal(inboxStatus(pr(1), 'me', false, true), null, 'neither requested nor reviewed: not in the inbox')
	const sorted = sortInbox([
		{ ...pr(1), inbox: 'reviewed' },
		{ ...pr(2), inbox: 'new' },
		{ ...pr(3), inbox: 're-requested' },
		{ ...pr(4), inbox: 'new' },
	])
	assert.deepEqual(
		sorted.map((x) => x.number),
		[3, 4, 2, 1],
		'asked again first, then new (newest first), then reviewed',
	)
})

const w = (number: number, over: Partial<WatchedPr> = {}): WatchedPr => ({
	repo: 'Octo/App',
	number,
	title: `PR ${number}`,
	url: `u${number}`,
	author: 'bob',
	draft: false,
	reviewed: false,
	...over,
})

test('notifications: what changed since the last look; nothing on the first look; drafts wait until ready', () => {
	const first = diffInbox(null, [w(1), w(2, { draft: true })])
	assert.deepEqual(first.events, [], 'first look is a baseline')
	const next = diffInbox(first.state, [w(1), w(2), w(3), w(4, { draft: true }), w(5, { reviewed: true })])
	assert.deepEqual(
		next.events.map((e) => [e.kind, e.pr.number]),
		[
			['ready', 2],
			['requested', 3],
			['re-requested', 5],
		],
	)
	// Reviewed and asked again between two looks: still listed, now with your review.
	const again = diffInbox(next.state, [w(1, { reviewed: true })])
	assert.deepEqual(
		again.events.map((e) => [e.kind, e.pr.number]),
		[['re-requested', 1]],
	)
	assert.deepEqual(diffInbox(again.state, [w(1, { reviewed: true })]).events, [], 'no repeat')
})

function tokens(): TokenStore {
	const m = new Map<string, string>()
	const info: CredentialStorageInfo = { secure: true, backend: 'test', message: null }
	return {
		async save(id, secret) {
			m.set(id, secret)
			return 'saved'
		},
		async read(id) {
			const secret = m.get(id)
			return secret ? { state: 'saved', secret } : { state: 'none' }
		},
		peek: (id) => (m.has(id) ? 'saved' : 'none'),
		async remove(id) {
			m.delete(id)
		},
		storageInfo: () => info,
	}
}

test('notifications: new commits on a PR you reviewed, once per head commit; asked again after a review', () => {
	const reviewed = (head: string, over: Partial<WatchedPr> = {}) => w(1, { reviewed: true, requested: false, head, ...over })
	const base = diffInbox(null, [reviewed('a')])
	assert.deepEqual(base.events, [])
	assert.deepEqual(diffInbox(base.state, [reviewed('a')]).events, [], 'same head: nothing')
	const pushed = diffInbox(base.state, [reviewed('b', { stale: true })])
	assert.deepEqual(
		pushed.events.map((e) => [e.kind, e.pr.number]),
		[['updated', 1]],
	)
	assert.deepEqual(diffInbox(pushed.state, [reviewed('b', { stale: true })]).events, [], 'reported once per head commit')
	assert.deepEqual(
		diffInbox(pushed.state, [reviewed('c', { stale: true })]).events.map((e) => e.kind),
		['updated'],
		'another push is reported again',
	)
	assert.deepEqual(diffInbox(base.state, [reviewed('b', { stale: false })]).events, [], 'you reviewed the new head already')
	assert.deepEqual(diffInbox(base.state, [reviewed('b', { stale: true, draft: true })]).events, [], 'drafts stay quiet')
	// Reviewed, so listed only as reviewed; then the author asks again.
	assert.deepEqual(
		diffInbox(base.state, [w(1, { reviewed: true, requested: true, head: 'b', stale: true })]).events.map((e) => e.kind),
		['re-requested'],
	)
	// First sight (or state stored before heads were watched): no burst of old reviews.
	assert.deepEqual(diffInbox({}, [reviewed('b', { stale: true })]).events, [])
	assert.deepEqual(diffInbox({ 'octo/app#1': { draft: false, reviewed: true } }, [reviewed('b', { stale: true })]).events, [])
})

const node = (number: number, repo: string, reviewedByMe = false) => ({
	number,
	title: `PR ${number}`,
	url: `u${number}`,
	state: 'OPEN',
	isDraft: false,
	updatedAt: '2026-10-01T00:00:00Z',
	author: { login: 'bob' },
	repository: { nameWithOwner: repo },
	headRefName: `h${number}`,
	baseRefName: 'main',
	isCrossRepository: false,
	headRepositoryOwner: { login: 'octo' },
	reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Team', slug: 'devs' } }] },
	headRefOid: 'head',
	reviewDecision: null,
	latestOpinionatedReviews: { nodes: [] },
	latestReviews: { nodes: reviewedByMe ? [{ author: { login: 'me' }, state: 'COMMENTED', submittedAt: 'x', commit: { oid: 'old' } }] : [] },
})

function fakeGitHub(answer: (q: string) => Array<ReturnType<typeof node>>) {
	const queries: Array<string> = []
	const gh = new GitHubService(tokens(), {
		base: 'http://gh.test',
		fetch: async (url, init) => {
			if (url.endsWith('/user')) return Response.json({ login: 'me' })
			const q = (JSON.parse(String(init.body)) as { variables: { q: string } }).variables.q
			queries.push(q)
			const nodes = answer(q)
			return Response.json({
				data: {
					viewer: { login: 'me' },
					search: { issueCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes },
				},
			})
		},
	})
	return { gh, queries }
}

test('the Inbox combines requested and reviewed PRs; a team request counts as requested', async () => {
	const { gh, queries } = fakeGitHub((q) =>
		q.includes('review-requested:@me') ? [node(1, 'octo/app')] : [node(1, 'octo/app'), node(2, 'octo/app', true)],
	)
	await gh.setToken('t', false)
	const page = await gh.search('octo/app', { filter: 'inbox', text: '', cursor: null })
	assert.equal(queries.length, 2)
	assert.ok(queries.some((q) => q.startsWith('repo:octo/app is:pr is:open reviewed-by:@me -author:@me')))
	assert.deepEqual(
		page.items.map((x) => [x.number, x.reviewRequested]),
		[
			[1, 'you'],
			[2, 'others'], // reviewed by you, now waiting on a team
		],
	)
	assert.equal(page.items[1].review!.reviewers[0].stale, true, 'reviewed on an older commit')
})

test('the watcher notifies only for repositories opened in the app, and remembers what it saw across restarts', async () => {
	let open = [node(1, 'octo/app'), node(2, 'other/repo')]
	const { gh } = fakeGitHub(() => open)
	await gh.setToken('t', false)
	const dir = mkdtempSync(join(tmpdir(), 'inbox-'))
	const store = ReviewStore.in(dir)
	await store.load()
	const notified: Array<RepoEvent> = []
	const badges: Array<number> = []
	const make = (s: ReviewStore) =>
		new InboxWatcher({
			github: gh,
			store: s,
			known: () => new Map([['octo/app', 'repo-1']]),
			notify: (e) => notified.push(...e),
			badge: (n) => badges.push(n),
		})
	const watcher = make(store)
	await watcher.check()
	assert.deepEqual(notified, [], 'first check is a baseline')
	assert.deepEqual(badges, [1], 'badge counts only repositories opened in the app')
	open = [...open, node(3, 'octo/app'), node(4, 'other/repo'), node(5, 'octo/app', true)]
	await watcher.check()
	watcher.stop()
	assert.deepEqual(
		notified.map((e) => [e.kind, e.pr.number, e.repoId]),
		[
			['requested', 3, 'repo-1'],
			['re-requested', 5, 'repo-1'],
		],
	)
	await store.flush()

	// After a restart, a request that arrived while the app was closed is reported.
	const reopened = ReviewStore.in(dir)
	await reopened.load()
	open = [...open, node(6, 'octo/app')]
	notified.length = 0
	const later = make(reopened)
	await later.check()
	later.stop()
	assert.deepEqual(
		notified.map((e) => e.pr.number),
		[6],
	)

	await gh.setNotifications({ enabled: false, sound: true })
	notified.length = 0
	open = [...open, node(7, 'octo/app')]
	const off = make(reopened)
	await off.check()
	off.stop()
	assert.deepEqual(notified, [], 'turned off: no checks, no notifications')
	assert.equal(badges.at(-1), 0, 'and the badge is cleared')
})

test('the watcher reports new commits on a PR you reviewed, and tells open lists when anything changed', async () => {
	let head = 'h1'
	const { gh, queries } = fakeGitHub((q) => (q.includes('reviewed-by:@me') ? [{ ...node(9, 'octo/app', true), headRefOid: head }] : []))
	await gh.setToken('t', false)
	const store = ReviewStore.in(mkdtempSync(join(tmpdir(), 'inbox-')))
	await store.load()
	const notified: Array<RepoEvent> = []
	const badges: Array<number> = []
	let changes = 0
	const watcher = new InboxWatcher({
		github: gh,
		store,
		known: () => new Map([['octo/app', 'repo-1']]),
		notify: (e) => notified.push(...e),
		badge: (n) => badges.push(n),
		changed: () => changes++,
	})
	await watcher.check()
	assert.ok(queries.some((q) => q.startsWith('is:pr is:open reviewed-by:@me -author:@me')))
	assert.equal(changes, 1, 'the first look counts as a change')
	await watcher.check()
	assert.equal(changes, 1, 'nothing changed')
	head = 'h2'
	await watcher.check()
	watcher.stop()
	assert.deepEqual(
		notified.map((e) => [e.kind, e.pr.number, e.repoId]),
		[['updated', 9, 'repo-1']],
	)
	assert.equal(changes, 2)
	assert.deepEqual(badges, [0, 0, 0], 'the badge counts requests only')
})
