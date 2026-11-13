import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DATA_NOTE } from '../src/main/agentData.ts'
import { AGENT_TOOLS, callAgentTool, checkoutAt, dataDir, relationOf, storeReader, type AgentDeps } from '../src/main/agentServer.ts'
import type { StoreData } from '../src/main/store.ts'
import { claudeCommand, mcpJson } from '../src/shared/agentSetup.ts'
import type { AiRun, Anchor, Finding, Review } from '../src/shared/types.ts'

const anchor = (path: string, line: number): Anchor => ({
	repoId: '/repo',
	baseSha: 'b'.repeat(40),
	headSha: 'h'.repeat(40),
	fileKey: path,
	oldPath: path,
	newPath: path,
	side: 'new',
	startLine: line,
	endLine: line + 2,
	excerpt: '',
})

const finding = (id: string, over: Partial<Finding> = {}): Finding =>
	({
		id,
		title: `Problem ${id}`,
		severity: 'blocking',
		category: 'bug',
		body: `Body of ${id}.`,
		evidence: `  12  code of ${id}`,
		anchor: anchor('src/cart.ts', 12),
		...over,
	}) as Finding

const review = (id: string, over: Partial<Review> = {}): Review =>
	({
		id,
		repoId: '/repo',
		baseRef: 'main',
		baseTipSha: 'b'.repeat(40),
		baseSha: 'b'.repeat(40),
		headSha: 'h'.repeat(40),
		headRef: null,
		createdAt: '2026-11-10T10:00:00Z',
		updatedAt: '2026-11-10T10:00:00Z',
		comments: [],
		drafts: [],
		viewed: [],
		findingDecisions: {},
		...over,
	}) as Review

const run = (id: string, status: AiRun['status'], findings: Array<Finding>, over: Partial<AiRun> = {}): AiRun =>
	({
		id,
		status,
		providerLabel: 'Team',
		model: '2 reviewers',
		baseSha: 'b'.repeat(40),
		headSha: 'h'.repeat(40),
		startedAt: '2026-11-10T10:00:00Z',
		finishedAt: status === 'running' ? null : '2026-11-10T10:05:00Z',
		coverage: { files: [], skippedRanges: [], supplied: [], batchesTotal: 0, batchesDone: 0, batchesFailed: 0, inputChars: 0 },
		findings,
		notices: [],
		errors: [],
		limitations: [],
		limitsUsed: null,
		team: null,
		...over,
	}) as AiRun

function store(): StoreData {
	const pr = review('pr-snap', {
		pr: { number: 12, title: 'Apply coupons', headLabel: 'octo:feat/coupons' } as Review['pr'],
		updatedAt: '2026-11-12T10:00:00Z',
		findingDecisions: { b: { status: 'dismissed', decidedAt: 't', reason: 'intended', note: 'by design' } },
		comments: [{ id: 'c1', findingId: 'c', body: 'x', carried: { published: { url: 'u' } } } as never],
	})
	const branch = review('branch-snap', { target: { kind: 'branch', headRef: 'fix/login', baseRef: 'main' } })
	return {
		version: 2,
		lastRepoId: '/repo',
		repos: {
			'/repo': {
				repoId: '/repo',
				root: '/repo',
				selectedBase: null,
				activeReviewId: null,
				reviews: { 'pr-snap': pr, 'branch-snap': branch },
				aiRuns: {
					'pr-snap': [
						run('r1', 'completed', [
							finding('a', { verification: { verdict: 'holds', reason: 'Traced it.', level: 'blocking', checked: [] } as never }),
							finding('b', { severity: 'should_fix', anchor: anchor('src/other.ts', 3) }),
							finding('c', { severity: 'nit' }),
							finding('m', { mergedInto: 'a' }),
						]),
						run('r2', 'running', []),
					],
				},
			},
		},
	} as unknown as StoreData
}

const deps = (over: Partial<AgentDeps> = {}): AgentDeps => ({
	readStore: async () => store(),
	checkout: async (dir) => (dir.startsWith('/repo') ? { root: '/repo', branch: 'feat/coupons', head: 'h'.repeat(40) } : null),
	relation: async () => ({ kind: 'ahead', commits: 2 }),
	cwd: '/repo/src',
	realRoot: (p) => p,
	...over,
})

const text = async (name: string, args: Record<string, unknown> = {}, d = deps()) => {
	const r = await callAgentTool(name, args, d)
	return { ...r, lines: r.text }
}

test('tools: three, all read-only by name; unknown ones, wrong folders and unopened repositories are errors the agent can act on', async () => {
	assert.deepEqual(
		AGENT_TOOLS.map((t) => t.name),
		['reviews', 'findings', 'run'],
	)
	assert.deepEqual(await callAgentTool('post_comment', {}, deps()), { text: 'There is no tool named post_comment.', error: true })
	const outside = await text('findings', { path: '/elsewhere' })
	assert.equal(outside.error, true)
	assert.match(outside.text, /\/elsewhere is not in a Git repository/)
	const unopened = await text('reviews', {}, deps({ checkout: async () => ({ root: '/other', branch: 'x', head: null }) }))
	assert.match(unopened.text, /Review has not opened \/other/)
	const noStore = await text('reviews', {}, deps({ readStore: async () => Promise.reject(new Error('Review’s data was not found')) }))
	assert.equal(noStore.error, true)
})

test('reviews: newest first, named by PR or branch, with the last run and open findings', async () => {
	const r = await text('reviews')
	assert.match(r.text, /^Reviews of \/repo in Review, newest first:/)
	assert.match(r.text, /- PR #12 "Apply coupons" .* a run is in progress .* review: pr-snap/)
	assert.match(r.text, /- branch fix\/login .* no AI run .* review: branch-snap/)
	assert.ok(r.text.indexOf('pr-snap') < r.text.indexOf('branch-snap'))
})

test('findings: the current branch picks the review; dismissed left out unless asked; with evidence, double-check, decision and how far the checkout moved', async () => {
	const r = await text('findings')
	assert.equal(r.error, false)
	assert.match(
		r.text,
		/Findings for PR #12 "Apply coupons" \(review pr-snap\), from the run finished 2026-11-10 10:05 on commit hhhhhhh by Team\./,
	)
	assert.match(r.text, /Your checkout is 2 commits past the reviewed commit hhhhhhh: some findings may already be fixed/)
	assert.ok(r.text.includes(DATA_NOTE))
	assert.match(
		r.text,
		/1\. \[blocking\] Problem a: src\/cart\.ts:12-14\nBody of a\.\nEvidence:\n  12  code of a\nDouble-check: not disproved\. Traced it\.\nYour decision: not decided/,
	)
	assert.match(r.text, /\[nit\] Problem c: .*\n[\s\S]*?Your decision: accepted, posted on GitHub/)
	assert.doesNotMatch(r.text, /Problem b|Problem m/, 'dismissed and merged ones left out')
	assert.match(r.text, /2 findings \(dismissed ones left out\)/)

	const all = await text('findings', { include_dismissed: true })
	assert.match(all.text, /\[should fix\] Problem b: src\/other\.ts:3-5[\s\S]*?Your decision: dismissed \(intended: by design\)/)

	const filtered = await text('findings', { levels: ['nit'], file: 'cart' })
	assert.match(filtered.text, /Problem c/)
	assert.doesNotMatch(filtered.text, /Problem a/)

	assert.match((await text('findings', { pr: 12 })).text, /review pr-snap/)
	assert.match((await text('findings', { branch: 'fix/login' })).text, /branch fix\/login has no finished AI run/)
	assert.match((await text('findings', { pr: 99 })).text, /no review of pull request #99/)
	const detached = await text('findings', {}, deps({ checkout: async () => ({ root: '/repo', branch: null, head: null }) }))
	assert.match(detached.text, /detached HEAD/)
})

test('run: the newest run by default, saying a run that sent nothing yet is still reading; or one by id', async () => {
	const now = Date.parse('2026-11-10T10:12:00Z')
	const { runText, pickReview, repoAt } = await import('../src/main/agentData.ts')
	const repo = repoAt(store(), '/repo')!
	const picked = pickReview(repo, { root: '/repo', branch: 'feat/coupons', head: null }, {})
	assert.ok('review' in picked)
	const newest = runText(repo, picked.review, undefined, now)
	assert.match(newest, /Run r2 of PR #12 .*: running since 2026-11-10 10:00 \(12 min\)\./)
	assert.match(newest, /It has not sent any request yet: it is still reading the change/)
	assert.match(newest, /Other runs of this review: r1 \(completed/)
	assert.match((await text('run', { run: 'r1' })).text, /Run r1 .*: completed/)
})

test('data folder: REVIEW_DATA_DIR first, else where each platform keeps it', () => {
	assert.equal(dataDir({ REVIEW_DATA_DIR: '/x' }, 'darwin', '/h'), '/x')
	assert.equal(dataDir({}, 'darwin', '/h'), '/h/Library/Application Support/Review')
	assert.equal(dataDir({ APPDATA: 'C:\\AppData' }, 'win32', '/h'), join('C:\\AppData', 'Review'))
	assert.equal(dataDir({}, 'linux', '/h'), '/h/.config/Review')
})

test('store reader: parsed again only when the file changes; a file it can’t read is reported and left where it is', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'review-agent-'))
	const file = join(dir, 'review-store.json')
	await assert.rejects(storeReader(file)(), /Review's data was not found/)
	writeFileSync(file, JSON.stringify({ version: 2, lastRepoId: null, repos: {} }))
	const read = storeReader(file)
	const first = await read()
	assert.equal(await read(), first, 'unchanged file: the same parse')
	writeFileSync(file, JSON.stringify({ version: 2, lastRepoId: '/r', repos: {} }))
	assert.equal((await read()).lastRepoId, '/r')
	writeFileSync(file, '{ not json')
	await assert.rejects(read())
	assert.ok(existsSync(file), 'never renamed or removed')
	assert.deepEqual(readdirSync(dir), ['review-store.json'])
})

test('checkout and relation from a real repository: same commit, commits ahead, another line of history', async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'review-agent-git-')))
	const g = (...a: Array<string>) =>
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir })
			.toString()
			.trim()
	g('init', '-q', '-b', 'main')
	g('commit', '-q', '--allow-empty', '-m', 'one')
	const one = g('rev-parse', 'HEAD')
	g('commit', '-q', '--allow-empty', '-m', 'two')
	g('commit', '-q', '--allow-empty', '-m', 'three')
	const three = g('rev-parse', 'HEAD')
	const co = await checkoutAt(join(dir, '.'))
	assert.deepEqual(co, { root: dir, branch: 'main', head: three })
	assert.deepEqual(await relationOf(dir, three, three), { kind: 'same' })
	assert.deepEqual(await relationOf(dir, one, three), { kind: 'ahead', commits: 2 })
	g('checkout', '-q', '--orphan', 'other')
	g('commit', '-q', '--allow-empty', '-m', 'unrelated')
	assert.deepEqual(await relationOf(dir, three, g('rev-parse', 'HEAD')), { kind: 'other' })
	assert.deepEqual(await relationOf(dir, three, null), { kind: 'unknown' })
	assert.equal(await checkoutAt(tmpdir()), null)
})

test('setup: a Claude Code command that survives spaces and quotes, and the same server as MCP JSON', () => {
	const setup = {
		name: 'review-app',
		command: '/Applications/Review.app/Contents/MacOS/Review',
		args: ['/Applications/Review.app/Contents/Resources/app.asar/out/main/agent.js'],
		env: { ELECTRON_RUN_AS_NODE: '1', REVIEW_DATA_DIR: "/Users/a b/Library/Application Support/Review's" },
		ready: true,
	}
	assert.equal(
		claudeCommand(setup),
		"claude mcp add --scope user review-app -e ELECTRON_RUN_AS_NODE=1 -e 'REVIEW_DATA_DIR=/Users/a b/Library/Application Support/Review'\\''s' -- /Applications/Review.app/Contents/MacOS/Review /Applications/Review.app/Contents/Resources/app.asar/out/main/agent.js",
	)
	assert.deepEqual(JSON.parse(mcpJson(setup)), {
		mcpServers: { 'review-app': { command: setup.command, args: setup.args, env: setup.env } },
	})
})
