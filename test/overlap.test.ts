import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GitHubService, type TokenStore } from '../src/main/github.ts'
import { overlaps } from '../src/main/overlap.ts'
import type { CredentialStorageInfo, PrGraphNode } from '../src/shared/types.ts'

const node = (number: number, paths: Array<string>, draft = false): PrGraphNode & { paths: Array<string> } => ({
	number,
	title: `PR ${number}`,
	url: `u${number}`,
	draft,
	author: 'a',
	headRef: `h${number}`,
	baseRef: 'main',
	crossRepo: false,
	updatedAt: '2026-11-01T00:00:00Z',
	collects: false,
	paths,
})

test('other PRs sharing a changed file, most shared first; lockfiles and generated files never count', () => {
	const own = ['src/cart.ts', 'src/total.ts', 'package-lock.json', 'dist/app.js']
	const got = overlaps(own, [
		node(1, ['src/cart.ts', 'README.md']),
		node(2, ['package-lock.json', 'dist/app.js']),
		node(3, ['src/total.ts', 'src/cart.ts'], true),
		node(4, []),
	])
	assert.deepEqual(
		got.map((o) => [o.number, o.draft, o.files]),
		[
			[3, true, ['src/total.ts', 'src/cart.ts']],
			[1, false, ['src/cart.ts']],
		],
	)
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

test('file lists are read in one aliased query and re-read only when a PR was updated', async () => {
	const asked: Array<Array<unknown>> = []
	const gh = new GitHubService(tokens(), {
		base: 'http://gh.test',
		fetch: async (url, init) => {
			if (url.endsWith('/user')) return Response.json({ login: 'me' })
			const { variables } = JSON.parse(String(init.body)) as { variables: Record<string, unknown> }
			const ns = Object.entries(variables).filter(([k]) => /^n\d+$/.test(k))
			asked.push(ns.map(([, v]) => v))
			// #9 was closed meanwhile: GitHub returns null for it with an error, and the others still come through.
			const repository = Object.fromEntries(
				ns.map(([k, v]) => [`p${k.slice(1)}`, v === 9 ? null : { files: { nodes: [{ path: `f${v}.ts` }] } }]),
			)
			return Response.json({
				data: { rateLimit: { remaining: 1, limit: 5000, resetAt: '2026-11-01T01:00:00Z' }, repository },
				errors: [{ type: 'NOT_FOUND', path: ['repository', 'p2'], message: 'gone' }],
			})
		},
	})
	await gh.setToken('t', false)
	const prs = [
		{ number: 1, updatedAt: 'a' },
		{ number: 2, updatedAt: 'a' },
		{ number: 9, updatedAt: 'a' },
	]
	const first = await gh.prFilePaths('o/r', prs)
	assert.deepEqual(
		[...first],
		[
			[1, ['f1.ts']],
			[2, ['f2.ts']],
		],
	)
	assert.deepEqual(asked, [[1, 2, 9]])
	await gh.prFilePaths('o/r', [
		{ number: 1, updatedAt: 'a' },
		{ number: 2, updatedAt: 'b' },
	])
	assert.deepEqual(asked[1], [2], 'only the PR that changed is read again')
})
