import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GitHubService, type TokenStore } from '../src/main/github.ts'
import { graphSummary, stackGuide, stackOf, stackRows, type MyReview } from '../src/shared/prStack.ts'
import { myReviewsIn } from '../src/main/service.ts'
import type { CredentialStorageInfo, PrGraph, PrGraphNode, PrSummary } from '../src/shared/types.ts'

const node = (number: number, headRef: string, baseRef: string, over: Partial<PrGraphNode> = {}): PrGraphNode => ({
	number,
	title: `PR ${number}`,
	url: `https://github.com/o/r/pull/${number}`,
	draft: false,
	author: 'a',
	headRef,
	baseRef,
	crossRepo: false,
	updatedAt: '2026-10-01T00:00:00Z',
	...over,
})

// The shape of the Workflows stack: three persistence parts, features on part 3, more on top of the builder.
const graph: PrGraph = {
	truncated: false,
	fetchedAt: '2026-10-01T00:00:00Z',
	nodes: [
		node(1, 'p1', 'master'),
		node(2, 'p2', 'p1'),
		node(3, 'p3', 'p2'),
		node(10, 'csv', 'p3'),
		node(11, 'builder', 'p3'),
		node(12, 'e2e', 'builder'),
		node(13, 'email', 'e2e'),
		node(14, 'exports', 'email'),
		node(20, 'standalone', 'master'),
		node(30, 'p3', 'master', { crossRepo: true }), // a fork's branch with the same name is never a parent
	],
}
const summary = (number: number): PrSummary => graphSummary(graph.nodes.find((n) => n.number === number)!)

test('results are grouped under the PR they are stacked on; missing parents are added as context rows', () => {
	// Search order (newest first): 13, 20, 10 — the persistence parts are not in the results.
	const rows = stackRows([summary(13), summary(20), summary(10)], graph)
	assert.deepEqual(
		rows.map((r) => [r.pr.number, r.depth, r.context]),
		[
			[1, 0, true],
			[2, 1, true],
			[3, 2, true],
			[10, 3, false],
			[11, 3, true],
			[12, 4, true],
			[13, 5, false],
			[20, 0, false],
		],
	)
})

test('without a graph, or for PRs that are not stacked, the results stay flat and in order', () => {
	assert.deepEqual(
		stackRows([summary(20), summary(13)], null).map((r) => [r.pr.number, r.depth]),
		[
			[20, 0],
			[13, 0],
		],
	)
	const merged: PrSummary = { ...summary(20), number: 99, state: 'merged', headRef: 'old', baseRef: 'master' }
	assert.deepEqual(
		stackRows([merged, summary(20)], graph).map((r) => r.pr.number),
		[99, 20],
	)
})

test('branches that target each other are still listed', () => {
	const loop: PrGraph = { ...graph, nodes: [node(1, 'a', 'b'), node(2, 'b', 'a')] }
	const rows = stackRows([graphSummary(loop.nodes[0]), graphSummary(loop.nodes[1])], loop)
	assert.deepEqual(rows.map((r) => r.pr.number).sort(), [1, 2])
})

test('stack position: the PRs below down to the base branch, and what is stacked on top with counts', () => {
	const s = stackOf(
		graph,
		graph.nodes.find((n) => n.number === 11)!,
	)!
	assert.equal(s.base, 'master')
	assert.deepEqual(
		s.parents.map((n) => n.number),
		[1, 2, 3],
	)
	assert.deepEqual(
		s.children.map((c) => [c.node.number, c.above]),
		[[12, 2]],
	)
	assert.equal(
		stackOf(
			graph,
			graph.nodes.find((n) => n.number === 20)!,
		),
		null,
		'a PR on master with nothing on top is not stacked',
	)
	const bottom = stackOf(
		graph,
		graph.nodes.find((n) => n.number === 1)!,
	)!
	assert.deepEqual(bottom.parents, [])
	assert.equal(bottom.children[0].above, 6)
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

test('the open-PR graph is read page by page, cached, and not read without a token', async () => {
	const calls: Array<string | null> = []
	const gql = (n: number, hasNextPage: boolean, endCursor: string | null) => ({
		data: {
			rateLimit: { remaining: 4999, limit: 5000, resetAt: '2026-10-01T01:00:00Z' },
			repository: {
				pullRequests: {
					pageInfo: { hasNextPage, endCursor },
					nodes: [
						{
							number: n,
							title: `PR ${n}`,
							url: `u${n}`,
							isDraft: n === 2,
							updatedAt: '2026-10-01T00:00:00Z',
							author: { login: 'a' },
							headRefName: `h${n}`,
							baseRefName: 'main',
							isCrossRepository: false,
						},
					],
				},
			},
		},
	})
	const gh = new GitHubService(tokens(), {
		base: 'http://gh.test',
		fetch: async (url, init) => {
			if (url.endsWith('/user')) return Response.json({ login: 'me' })
			const after = (JSON.parse(String(init.body)) as { variables: { after: string | null } }).variables.after
			calls.push(after)
			return Response.json(after ? gql(2, false, null) : gql(1, true, 'c1'))
		},
	})
	assert.equal(await gh.openPrGraph('o/r'), null, 'no token, no read')
	assert.deepEqual(calls, [])
	await gh.setToken('t', false)
	await gh.openPrGraph('o/r2').then(() => {}) // a different repository is cached separately
	calls.length = 0
	const g = (await gh.openPrGraph('o/r'))!
	assert.deepEqual(calls, [null, 'c1'])
	assert.deepEqual(
		g.nodes.map((n) => [n.number, n.headRef, n.draft]),
		[
			[1, 'h1', false],
			[2, 'h2', true],
		],
	)
	assert.equal(g.truncated, false)
	await gh.openPrGraph('O/R')
	assert.equal(calls.length, 2, 'served from the cache')
})

test('stack guide: the whole stack bottom up from any member, where it sits, and the lowest PR that needs you', () => {
	const mine = new Map<number, MyReview>([
		[1, 'approved'],
		[2, 'needs-you'],
		[12, 'needs-you'],
	])
	const g = stackGuide(graph, 12, mine)!
	assert.equal(g.base, 'master')
	assert.deepEqual(
		g.members.map((m) => [m.node.number, m.depth, m.mine]),
		[
			[1, 0, 'approved'],
			[2, 1, 'needs-you'],
			[3, 2, null],
			[10, 3, null],
			[11, 3, null],
			[12, 4, 'needs-you'],
			[13, 5, null],
			[14, 6, null],
		],
		'depth-first, PRs on the same parent in number order; a fork branch named like a parent is not part of it',
	)
	assert.equal(g.index, 5, '#12 is 6th from the bottom')
	assert.equal(g.bottom.node.number, 1, 'everything is built on #1, so it merges first')
	assert.deepEqual(
		g.members.map((m) => m.parent),
		[null, 1, 2, 3, 3, 11, 12, 13],
		'#10 and #11 both sit on #3: the stack forks there',
	)
	assert.equal(g.next?.node.number, 2, 'start at the lowest PR that needs you, even from higher up')
	// Every member of a stack agrees on its next PR; the bottom finds the same stack.
	assert.equal(stackGuide(graph, 1, mine)?.next?.node.number, 2)
	assert.equal(stackGuide(graph, 1, mine)?.members.length, 8)
	assert.equal(stackGuide(graph, 11, mine)?.bottom.node.number, 1, 'past a fork, still the same bottom')

	// Once #2 is reviewed, the next one is #12; drafts are skipped; nothing left means no next.
	mine.set(2, 'commented')
	assert.equal(stackGuide(graph, 3, mine)?.next?.node.number, 12)
	const drafty = { ...graph, nodes: graph.nodes.map((n) => (n.number === 12 ? { ...n, draft: true } : n)) }
	assert.equal(stackGuide(drafty, 3, mine)?.next?.node.number, 12, 'a draft when no ready PR needs you')
	mine.set(13, 'needs-you')
	assert.equal(stackGuide(drafty, 3, mine)?.next?.node.number, 13, 'a ready PR comes before a lower draft')
	mine.delete(13)
	mine.set(12, 'changes-requested')
	assert.equal(stackGuide(graph, 3, mine)?.next, null, 'nothing left for you')
	assert.equal(stackGuide(graph, 3, null)?.next, null, 'without your status there is no next')

	assert.equal(stackGuide(graph, 20, mine), null, 'not stacked')
	assert.equal(stackGuide(graph, 99, mine), null, 'not in the graph')
})

test('your review status per PR, from the requested and reviewed searches, for one repository', () => {
	const w = (number: number, over: object) => ({
		repo: 'O/R',
		number,
		title: '',
		url: '',
		author: null,
		draft: false,
		reviewed: false,
		...over,
	})
	assert.deepEqual(
		myReviewsIn(
			[
				w(1, { requested: true }),
				w(2, { reviewed: true, requested: false, stale: true }), // new commits since your review
				w(3, { reviewed: true, requested: false, verdict: 'approved' }),
				w(4, { reviewed: true, requested: true, verdict: 'approved' }), // asked again
				w(6, { reviewed: true, requested: false, verdict: 'changes-requested' }),
				w(7, { reviewed: true, requested: false, verdict: 'commented' }),
				w(8, { reviewed: true, requested: false, verdict: 'dismissed' }),
				w(9, { reviewed: true, requested: false }), // stored before verdicts were kept: never shown as approved
				{ ...w(5, { requested: true }), repo: 'other/repo' },
			],
			'o/r',
		),
		{
			1: 'needs-you',
			2: 'needs-you',
			3: 'approved',
			4: 'needs-you',
			6: 'changes-requested',
			7: 'commented',
			8: 'commented',
			9: 'commented',
		},
		'your own verdict, never a bare "reviewed" that reads as approved',
	)
})
