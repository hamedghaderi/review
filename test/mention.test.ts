import assert from 'node:assert/strict'
import { test } from 'node:test'
import { insertMention, mentionAt, rankMentions } from '../src/shared/mention.ts'
import { GitHubService, type TokenStore } from '../src/main/github.ts'
import type { CredentialStorageInfo } from '../src/shared/types.ts'

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

test('"@" at the cursor starts a mention after a space, "(" or the start, and not in emails or code', () => {
	const at = (text: string, cursor = text.length) => mentionAt(text, cursor)
	assert.deepEqual(at('@'), { start: 0, end: 1, query: '' })
	assert.deepEqual(at('thanks @al'), { start: 7, end: 10, query: 'al' })
	assert.deepEqual(at('(cc @bo'), { start: 4, end: 7, query: 'bo' })
	assert.deepEqual(at('hi @alice-b rest', 6), { start: 3, end: 11, query: 'al' }, 'covers the rest of the login under the cursor')
	assert.equal(at('mail me@example'), null)
	assert.equal(at('@alice '), null, 'a space ends it')
	assert.equal(at('use `@al'), null, 'inline code')
	assert.deepEqual(at('use `x` @al'), { start: 8, end: 11, query: 'al' }, 'after inline code closes')
	assert.equal(at('```\n@al'), null, 'fenced code')
	assert.deepEqual(at('```\nx\n```\n@al'), { start: 10, end: 13, query: 'al' })
})

test('picking replaces what was typed with "@login " and puts the cursor after the space', () => {
	assert.deepEqual(insertMention('cc @al', 3, 6, 'alice'), { text: 'cc @alice ', cursor: 10 })
	assert.deepEqual(insertMention('@al please', 0, 3, 'alice'), { text: '@alice please', cursor: 7 }, 'no double space')
	assert.deepEqual(insertMention('@al\nnext', 0, 3, 'alice'), { text: '@alice \nnext', cursor: 7 })
})

test('suggestions: people on the PR first, then GitHub’s, without repeats or yourself', () => {
	const u = (login: string, name: string | null = null) => ({ login, name })
	const local = [u('carol'), u('me'), u('alex'), u('bob')]
	const remote = [u('alice', 'Alice Smith'), u('Alex', 'Alex Jones'), u('dave', 'Al Dave')]
	assert.deepEqual(rankMentions('', local, [], 'me'), [u('carol'), u('alex'), u('bob')], 'a bare "@" lists the PR’s people in order')
	assert.deepEqual(
		rankMentions('al', local, remote, 'me'),
		[u('alex', 'Alex Jones'), u('alice', 'Alice Smith'), u('dave', 'Al Dave')],
		'login prefix and name words match; GitHub names fill in; logins compare without case',
	)
	assert.deepEqual(
		rankMentions('ro', local, [], null).map((x) => x.login),
		['carol'],
		'a login containing the query',
	)
	assert.equal(
		rankMentions(
			'',
			[],
			Array.from({ length: 20 }, (_, i) => u(`p${i}`)),
			null,
		).length,
		8,
	)
})

test('mentionable asks GitHub for the repository’s mentionable users and keeps only valid logins; nothing without a token', async () => {
	const sent: Array<{ query: string; variables: Record<string, unknown> }> = []
	const gh = new GitHubService(tokens('ghp_' + 't'.repeat(36)), {
		fetch: async (_url, init) => {
			sent.push(JSON.parse(String(init?.body)))
			const nodes = [{ login: 'alice', name: ' Alice ' }, { login: 'bad login', name: null }, null, { login: 'bob', name: '' }]
			return new Response(JSON.stringify({ data: { repository: { mentionableUsers: { nodes } } } }), { status: 200 })
		},
	})
	assert.deepEqual(await gh.mentionable('o/r', 'al'), [
		{ login: 'alice', name: 'Alice' },
		{ login: 'bob', name: null },
	])
	assert.match(sent[0].query, /mentionableUsers\(first: 8, query: \$q\)/)
	assert.doesNotMatch(sent[0].query, /mutation/)
	assert.deepEqual(sent[0].variables, { owner: 'o', name: 'r', q: 'al' })

	let called = false
	const anon = new GitHubService(tokens(null), {
		fetch: async () => {
			called = true
			return new Response('[]')
		},
	})
	assert.deepEqual(await anon.mentionable('o/r', 'al'), [])
	assert.equal(called, false)
	await assert.rejects(gh.mentionable('not a repo', 'x'), /Invalid GitHub repository/)
})
