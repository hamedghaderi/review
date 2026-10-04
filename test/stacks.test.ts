import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GitHubService, type TokenStore } from '../src/main/github.ts'
import { graphSummary, stackOf, stackRows } from '../src/shared/prStack.ts'
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
