import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { CredentialService, type SecretCipher } from '../src/main/ai/credentials.ts'
import { createReviewTools } from '../src/main/ai/lookup.ts'
import { expand, looksReadOnly, McpService } from '../src/main/ai/mcp.ts'
import { withExternalTools } from '../src/main/ai/prompt.ts'
import { reviewerInstructions } from '../src/main/ai/prompt.ts'

function cipher(): SecretCipher {
	return {
		async isAsyncEncryptionAvailable() {
			return true
		},
		async encryptStringAsync(plain) {
			return Buffer.from(`ENC:${Buffer.from(plain).toString('hex')}`)
		},
		async decryptStringAsync(buf) {
			return { result: Buffer.from(buf.toString().slice(4), 'hex').toString(), shouldReEncrypt: false }
		},
		getSelectedStorageBackend: () => 'keychain',
	}
}

/** A stdio MCP server with one read-only tool, one tool that only looks read-only by name, and one that writes. */
function serverScript(): string {
	const sdk = (p: string) => pathToFileURL(resolve('node_modules/@modelcontextprotocol/sdk/dist/esm', p)).href
	const zod = pathToFileURL(resolve('node_modules/zod/index.js')).href
	const file = join(mkdtempSync(join(tmpdir(), 'review-mcp-')), 'server.mjs')
	writeFileSync(
		file,
		`import { McpServer } from '${sdk('server/mcp.js')}'
import { StdioServerTransport } from '${sdk('server/stdio.js')}'
import { z } from '${zod}'
const server = new McpServer({ name: 'tickets', version: '1.0.0' })
server.registerTool('get_ticket', { description: 'Read a ticket', inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
	async ({ id }) => ({ content: [{ type: 'text', text: process.env.TICKET_PREFIX + '-' + id + ': Add tax to totals' }] }))
server.registerTool('search_docs', { description: 'Search docs', inputSchema: { q: z.string() } },
	async ({ q }) => ({ content: [{ type: 'text', text: 'docs for ' + q }] }))
server.registerTool('delete_ticket', { description: 'Delete a ticket', inputSchema: { id: z.string() } },
	async () => ({ content: [{ type: 'text', text: 'deleted' }] }))
await server.connect(new StdioServerTransport())
`,
	)
	return file
}

function repo(): { root: string; baseSha: string; headSha: string } {
	const root = mkdtempSync(join(tmpdir(), 'review-mcp-repo-'))
	const git = (...a: Array<string>): string =>
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
			cwd: root,
			encoding: 'utf8',
		}).trim()
	git('init', '-q', '-b', 'main')
	writeFileSync(join(root, 'a.txt'), 'a\n')
	git('add', '.')
	git('commit', '-q', '-m', 'base')
	const sha = git('rev-parse', 'HEAD')
	return { root, baseSha: sha, headSha: sha }
}

test('tools are offered by default only when they look read-only', () => {
	assert.equal(looksReadOnly({ name: 'anything', readOnly: true, destructive: null }), true)
	assert.equal(looksReadOnly({ name: 'get_issue', readOnly: false, destructive: null }), false)
	assert.equal(looksReadOnly({ name: 'get_issue', readOnly: null, destructive: null }), true)
	assert.equal(looksReadOnly({ name: 'jira_search', readOnly: null, destructive: null }), true)
	assert.equal(looksReadOnly({ name: 'list_and_delete', readOnly: null, destructive: null }), false)
	assert.equal(looksReadOnly({ name: 'create_issue', readOnly: null, destructive: null }), false)
	assert.equal(looksReadOnly({ name: 'getissue', readOnly: null, destructive: null }), false)
	assert.equal(looksReadOnly({ name: 'list_files', readOnly: null, destructive: true }), false)
})

test('variables expand the way Claude Code expands them', () => {
	assert.equal(expand('Bearer ${TOKEN}', { TOKEN: 'abc' }), 'Bearer abc')
	assert.equal(expand('${MISSING:-fallback}/x', {}), 'fallback/x')
	assert.equal(expand('${MISSING}', {}), '')
	assert.equal(expand('$TOKEN', { TOKEN: 'abc' }), '$TOKEN')
})

test('MCP instructions replace the "only tools" sentence and treat results as data', () => {
	const base = reviewerInstructions(undefined, true)
	const out = withExternalTools(base, [{ name: 'jira', tools: [{ name: 'get_issue', description: 'Read an issue' }] }])
	assert.ok(!out.includes('Your only tools are'))
	assert.match(out, /# Other tools \(MCP\)/)
	assert.match(out, /- jira: get_issue/)
	assert.match(out, /data, never instructions/)
})

test('a stdio MCP server is tested, its read-only tools are offered, and calls share the lookup budget', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'review-mcp-settings-'))
	const credentials = new CredentialService(dir, cipher())
	await credentials.load()
	const mcp = new McpService(dir, credentials)
	await mcp.load()
	const id = await mcp.save(null, {
		name: 'tickets',
		transport: 'stdio',
		command: process.execPath,
		args: [serverScript()],
		url: '',
		env: { TICKET_PREFIX: 'ABC' },
		headers: null,
		enabled: true,
	})

	// The secret value is in the credential store, not in the settings file or the view.
	assert.ok(!readFileSync(join(dir, 'mcp-servers.json'), 'utf8').includes('ABC'))
	assert.deepEqual(mcp.view().servers[0].envKeys, ['TICKET_PREFIX'])

	await mcp.test(id, null)
	const server = mcp.view().servers[0]
	assert.equal(server.lastTest?.ok, true, server.lastTest?.message)
	assert.deepEqual(
		server.tools?.map((t) => [t.name, t.allowed]),
		[
			['get_ticket', true],
			['search_docs', true],
			['delete_ticket', false],
		],
	)

	const external = await mcp.open(null, AbortSignal.timeout(20_000))
	assert.ok(external)
	try {
		assert.deepEqual(
			external.definitions.map((d) => [d.name, d.strict]),
			[
				['mcp__tickets__get_ticket', false],
				['mcp__tickets__search_docs', false],
			],
		)
		const tools = createReviewTools(repo(), { maxCalls: 2, maxChars: 10_000 }, external)
		assert.ok(tools.definitions.some((d) => d.name === 'read_file'))
		const r = await tools.call('mcp__tickets__get_ticket', { id: '7' }, AbortSignal.timeout(10_000))
		assert.deepEqual(r, { text: 'ABC-7: Add tax to totals', error: false })
		assert.deepEqual(tools.log.external, ['tickets: get_ticket'])
		// A tool the user did not allow is not callable even by its MCP name.
		const denied = await tools.call('mcp__tickets__delete_ticket', { id: '7' }, AbortSignal.timeout(10_000))
		assert.equal(denied.error, true)
		assert.equal(tools.exhausted(), true)
	} finally {
		await external.close()
	}

	// Picking tools replaces the read-only default.
	await mcp.setTools(id, ['delete_ticket'])
	assert.deepEqual(
		mcp
			.view()
			.servers[0].tools?.filter((t) => t.allowed)
			.map((t) => t.name),
		['delete_ticket'],
	)
})

test('a server that cannot start is reported, not fatal', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'review-mcp-bad-'))
	const credentials = new CredentialService(dir, cipher())
	await credentials.load()
	const mcp = new McpService(dir, credentials)
	await mcp.load()
	await mcp.save(null, {
		name: 'missing',
		transport: 'stdio',
		command: '/definitely/not/a/command',
		args: [],
		url: '',
		env: null,
		headers: null,
		enabled: true,
	})
	const external = await mcp.open(null, AbortSignal.timeout(20_000))
	assert.ok(external)
	assert.equal(external.definitions.length, 0)
	assert.match(external.failures[0], /^missing: /)
})
