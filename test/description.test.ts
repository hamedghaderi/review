import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GitHubService, type TokenStore } from '../src/main/github.ts'
import type { CredentialStorageInfo } from '../src/shared/types.ts'

function tokens(signedIn: boolean): TokenStore {
	const info: CredentialStorageInfo = { secure: true, backend: 'test', message: null }
	return {
		async save() {},
		async read() {
			return signedIn ? { state: 'saved', secret: 'ghp_test' } : { state: 'none', secret: null }
		},
		peek: () => (signedIn ? 'saved' : 'none'),
		async remove() {},
		storageInfo: () => info,
	} as TokenStore
}

/** A fake GitHub holding one pull request's description; records every request. */
function fakeGitHub(pr: { body: string; viewerCanUpdate?: boolean }) {
	const calls: Array<{ url: string; method: string; body: unknown; accept: string | undefined }> = []
	const node = () => ({
		id: 'PR_1',
		body: pr.body,
		bodyHTML: `<p>${pr.body}</p>`,
		viewerCanUpdate: pr.viewerCanUpdate ?? true,
		updatedAt: '2026-10-16T10:00:00Z',
		url: 'https://github.com/octo/app/pull/7',
	})
	const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } })
	const fetch = async (url: string, init: RequestInit): Promise<Response> => {
		const body = init.body ? JSON.parse(String(init.body)) : null
		calls.push({ url, method: init.method ?? 'GET', body, accept: (init.headers as Record<string, string>)?.accept })
		if (url.endsWith('/graphql')) {
			if (String(body.query).includes('updatePullRequest')) {
				pr.body = body.variables.input.body
				return json({ data: { updatePullRequest: { pullRequest: node() } } })
			}
			return json({ data: { repository: { pullRequest: node() } } })
		}
		if (url.endsWith('/markdown')) return new Response(`<h1>${body.text}</h1>`, { status: 200 })
		if (url.endsWith('/pulls/7'))
			return json({ body: pr.body, body_html: `<p>${pr.body}</p>`, updated_at: null, html_url: 'https://github.com/octo/app/pull/7' })
		return new Response('{}', { status: 404 })
	}
	return { fetch, calls, pr }
}

test('description: Markdown with line endings normalised, GitHub’s HTML, and whether you may edit it', async () => {
	const gh = fakeGitHub({ body: 'Fixes #12\r\n\r\n- one', viewerCanUpdate: false })
	const svc = new GitHubService(tokens(true), { fetch: gh.fetch, base: 'https://api.test' })
	const d = await svc.description('octo/app', 7)
	assert.equal(d.body, 'Fixes #12\n\n- one')
	assert.match(d.html, /<p>Fixes #12/)
	assert.equal(d.canEdit, false)
	assert.match(d.editIssue ?? '', /author and people with write access/)
})

test('description without a token: the REST pull request in its HTML form, never editable', async () => {
	const gh = fakeGitHub({ body: 'Hello' })
	const svc = new GitHubService(tokens(false), { fetch: gh.fetch, base: 'https://api.test' })
	const d = await svc.description('octo/app', 7)
	assert.equal(d.html, '<p>Hello</p>')
	assert.equal(d.canEdit, false)
	assert.equal(gh.calls[0].accept, 'application/vnd.github.full+json')
})

test('preview is rendered by GitHub in the repository’s context', async () => {
	const gh = fakeGitHub({ body: '' })
	const svc = new GitHubService(tokens(true), { fetch: gh.fetch, base: 'https://api.test' })
	assert.equal(await svc.renderMarkdown('octo/app', 'Title'), '<h1>Title</h1>')
	assert.deepEqual(gh.calls[0].body, { text: 'Title', mode: 'gfm', context: 'octo/app' })
})

test('saving replaces the description; a change on GitHub since the edit began is never overwritten', async () => {
	const gh = fakeGitHub({ body: 'Old\r\ntext' })
	const svc = new GitHubService(tokens(true), { fetch: gh.fetch, base: 'https://api.test' })
	const saved = await svc.updateDescription('octo/app', 7, 'Old\ntext', 'New text')
	assert.equal(saved.body, 'New text', 'CRLF on GitHub matches the LF text the edit started from')
	assert.equal(gh.pr.body, 'New text')

	gh.pr.body = 'Someone else edited this'
	await assert.rejects(svc.updateDescription('octo/app', 7, 'New text', 'Mine'), { code: 'pr-changed' })
	assert.equal(gh.pr.body, 'Someone else edited this')

	const readOnly = fakeGitHub({ body: 'x', viewerCanUpdate: false })
	const other = new GitHubService(tokens(true), { fetch: readOnly.fetch, base: 'https://api.test' })
	await assert.rejects(other.updateDescription('octo/app', 7, 'x', 'y'), { code: 'github-forbidden' })
	assert.ok(!readOnly.calls.some((c) => String((c.body as { query?: string })?.query).includes('updatePullRequest')))

	const anon = new GitHubService(tokens(false), { fetch: gh.fetch, base: 'https://api.test' })
	await assert.rejects(anon.updateDescription('octo/app', 7, 'x', 'y'), { code: 'github-auth' })
})
