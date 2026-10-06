import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ensureCommits, findRoot, readRepo, KEEP_PREFIX } from '../src/main/git.ts'
import { GitHubService, type TokenStore } from '../src/main/github.ts'
import { mapping, pushHead, ReviewService } from '../src/main/service.ts'
import { ReviewStore } from '../src/main/store.ts'
import { browserState, githubToken, reviewTarget } from '../src/main/validate.ts'
import { branchRows, matchBranches } from '../src/renderer/src/branches.ts'
import { buildSearch, parseGitHubRemote, parsePrQuery } from '../src/shared/prQuery.ts'
import type { BranchRef, CredentialStorageInfo } from '../src/shared/types.ts'

// ─── Fixtures ────────────────────────────────────────────────────────────────

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'review-browse-'))
}

function runner(dir: string) {
	return (...a: Array<string>): string =>
		execFileSync(
			'git',
			['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...a],
			{
				cwd: dir,
				encoding: 'utf8',
			},
		).trim()
}

function commit(run: ReturnType<typeof runner>, dir: string, file: string, text: string, msg: string): string {
	writeFileSync(join(dir, file), text)
	run('add', '-A')
	run('commit', '-qm', msg)
	return run('rev-parse', 'HEAD')
}

/**
 * upstream (bare, "octo/app") ← PRs live here, including refs/pull/N/head like GitHub.
 * fork (bare, "alice/app") has the PR branch.
 * clone: origin = fork, upstream = upstream. Also has a local "main" that differs from origin/main and upstream/main.
 */
function world() {
	const root = tmp()
	const up = join(root, 'upstream.git')
	const fork = join(root, 'fork.git')
	const seed = join(root, 'seed')
	const clone = join(root, 'clone')
	execFileSync('git', ['init', '-q', '--bare', '-b', 'main', up])
	execFileSync('git', ['init', '-q', '--bare', '-b', 'main', fork])
	execFileSync('git', ['init', '-q', '-b', 'main', seed])
	const s = runner(seed)
	const base = commit(s, seed, 'a.txt', 'one\n', 'base')
	s('push', '-q', up, 'main')
	s('push', '-q', fork, 'main')
	// PR #7 from the fork: branch feat/login.
	s('checkout', '-qb', 'feat/login')
	const pr1 = commit(s, seed, 'login.txt', 'login v1\n', 'login v1')
	s('push', '-q', fork, 'feat/login')
	s('push', '-q', up, `${pr1}:refs/pull/7/head`)
	// upstream main moves on after the PR was opened.
	s('checkout', '-q', 'main')
	const upMain = commit(s, seed, 'b.txt', 'upstream\n', 'upstream moves')
	s('push', '-q', up, 'main')

	execFileSync('git', ['clone', '-q', '-o', 'origin', fork, clone])
	const c = runner(clone)
	c('remote', 'add', 'upstream', up)
	c('fetch', '-q', 'upstream')
	c('remote', 'set-head', 'upstream', 'main')
	c('checkout', '-q', '-b', 'feat/local-only')
	commit(c, clone, 'local.txt', 'local\n', 'local work')
	c('checkout', '-q', 'main')
	commit(c, clone, 'c.txt', 'local main\n', 'local main diverges')
	// Remote URLs are rewritten to GitHub-style URLs for mapping; insteadOf keeps fetching local.
	c('config', `url.file://${up}.insteadOf`, 'https://github.com/octo/app.git')
	c('config', `url.file://${fork}.insteadOf`, 'git@github.com:alice/app.git')
	c('remote', 'set-url', 'upstream', 'https://github.com/octo/app.git')
	c('remote', 'set-url', 'origin', 'git@github.com:alice/app.git')
	return { root, up, fork, seed, clone, s, c, base, pr1, upMain }
}

function memoryTokens(): TokenStore {
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

interface MockPr {
	number: number
	title: string
	state: 'open' | 'closed'
	merged?: boolean
	draft?: boolean
	author: string
	headRef: string
	headRepo: string | null
	baseRef: string
	baseSha: string
	headSha: string
	updatedAt: string
}

/** Enough of api.github.com for these tests: pulls/:n, search/issues (paginated) and GraphQL search. Records requests. */
async function mockGitHub(prs: Array<MockPr>, hooks: { onDetail?(n: number, count: number): void } = {}) {
	const seen: Array<{ method: string; url: string; auth: string | undefined; body: string }> = []
	const detailCount = new Map<number, number>()
	const pull = (p: MockPr) => ({
		number: p.number,
		title: p.title,
		body: `Body of ${p.number}`,
		html_url: `https://github.com/octo/app/pull/${p.number}`,
		state: p.state,
		draft: !!p.draft,
		merged_at: p.merged ? '2026-01-01T00:00:00Z' : null,
		closed_at: p.state === 'closed' ? '2026-01-01T00:00:00Z' : null,
		created_at: '2026-01-01T00:00:00Z',
		updated_at: p.updatedAt,
		user: { login: p.author },
		head: {
			ref: p.headRef,
			sha: p.headSha,
			user: { login: p.headRepo?.split('/')[0] ?? 'ghost' },
			repo: p.headRepo ? { full_name: p.headRepo } : null,
		},
		base: { ref: p.baseRef, sha: p.baseSha, user: { login: 'octo' }, repo: { full_name: 'octo/app' } },
		commits: 1,
		changed_files: 1,
		additions: 1,
		deletions: 0,
		requested_reviewers: [{ login: 'me' }],
		requested_teams: [],
	})
	const filter = (q: string) => {
		let r = [...prs]
		const author = /author:(\S+)/.exec(q)?.[1]
		if (author) r = r.filter((p) => p.author === author)
		const head = /head:(\S+)/.exec(q)?.[1]
		if (head) r = r.filter((p) => p.headRef === head)
		if (q.includes('is:open')) r = r.filter((p) => p.state === 'open')
		if (q.includes('is:merged')) r = r.filter((p) => p.merged)
		const words = q
			.split(' ')
			.filter((w) => !w.includes(':'))
			.map((w) => w.replace(/"/g, '').toLowerCase())
		if (q.includes('in:title')) r = r.filter((p) => words.every((w) => p.title.toLowerCase().includes(w)))
		return r.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
	}
	const server = http.createServer((req, res) => {
		let body = ''
		req.on('data', (c) => (body += c))
		req.on('end', () => {
			const url = new URL(req.url!, 'http://x')
			seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body })
			const send = (status: number, data: unknown, headers: Record<string, string> = {}) => {
				res.writeHead(status, {
					'content-type': 'application/json',
					'x-ratelimit-remaining': '4999',
					'x-ratelimit-limit': '5000',
					'x-ratelimit-reset': '9999999999',
					...headers,
				})
				res.end(JSON.stringify(data))
			}
			if (url.pathname === '/repos/octo/app/pulls') {
				const [owner, branch] = url.searchParams.get('head')!.split(':')
				return send(200, prs.filter((p) => p.headRef === branch && (p.headRepo ?? '').split('/')[0] === owner).map(pull))
			}
			const m = /^\/repos\/octo\/app\/pulls\/(\d+)$/.exec(url.pathname)
			if (m) {
				const n = Number(m[1])
				const count = (detailCount.get(n) ?? 0) + 1
				detailCount.set(n, count)
				hooks.onDetail?.(n, count)
				const p = prs.find((x) => x.number === n)
				return p ? send(200, pull(p)) : send(404, { message: 'Not Found' })
			}
			if (url.pathname === '/user')
				return req.headers.authorization ? send(200, { login: 'me' }) : send(401, { message: 'Requires authentication' })
			if (url.pathname === '/search/issues') {
				const all = filter(url.searchParams.get('q')!)
				const per = Number(url.searchParams.get('per_page'))
				const page = Number(url.searchParams.get('page'))
				const items = all.slice((page - 1) * per, page * per).map((p) => ({
					number: p.number,
					title: p.title,
					html_url: `https://github.com/octo/app/pull/${p.number}`,
					state: p.state,
					draft: !!p.draft,
					updated_at: p.updatedAt,
					user: { login: p.author },
					pull_request: { merged_at: p.merged ? '2026-01-01T00:00:00Z' : null },
				}))
				return send(200, { total_count: all.length, incomplete_results: false, items })
			}
			if (url.pathname === '/graphql') {
				const { variables } = JSON.parse(body) as { variables: { q: string; first: number; after: string | null } }
				const all = filter(variables.q)
				const start = variables.after ? Number(variables.after) : 0
				const nodes = all.slice(start, start + variables.first).map((p) => ({
					number: p.number,
					title: p.title,
					url: `https://github.com/octo/app/pull/${p.number}`,
					state: p.merged ? 'MERGED' : p.state.toUpperCase(),
					isDraft: !!p.draft,
					updatedAt: p.updatedAt,
					author: { login: p.author },
					headRefName: p.headRef,
					baseRefName: p.baseRef,
					isCrossRepository: p.headRepo !== 'octo/app',
					headRepositoryOwner: p.headRepo ? { login: p.headRepo.split('/')[0] } : null,
					reviewRequests: { nodes: [] },
				}))
				const end = start + nodes.length
				return send(200, {
					data: {
						viewer: { login: 'me' },
						rateLimit: { remaining: 4990, limit: 5000, resetAt: '2030-01-01T00:00:00Z' },
						search: { issueCount: all.length, pageInfo: { hasNextPage: end < all.length, endCursor: String(end) }, nodes },
					},
				})
			}
			send(404, { message: 'Not Found' })
		})
	})
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
	return { base, seen, detailCount, close: () => new Promise<void>((r) => server.close(() => r())) }
}

function repoState(dir: string) {
	const run = runner(dir)
	return {
		head: run('rev-parse', 'HEAD'),
		symbolic: run('symbolic-ref', '-q', 'HEAD'),
		status: run('status', '--porcelain=v1', '--untracked-files=all'),
		index: readFileSync(join(dir, '.git', 'index')).toString('hex'),
		branches: run('for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes'),
	}
}

async function service(gh: GitHubService) {
	const store = ReviewStore.in(tmp())
	await store.load()
	return { store, svc: new ReviewService(store, gh) }
}

// ─── Pure logic ───────────────────────────────────────────────────────────────

test('query parsing: numbers, URLs, qualifiers, @author, scope qualifiers dropped', () => {
	assert.deepEqual(parsePrQuery('#128'), { kind: 'number', number: 128 })
	assert.deepEqual(parsePrQuery(' 42 '), { kind: 'number', number: 42 })
	assert.deepEqual(parsePrQuery('https://github.com/Octo/App/pull/9/files#diff'), { kind: 'url', repo: 'Octo/App', number: 9 })
	const q = parsePrQuery('fix login author:alice head:feat/login base:"release/2.0" @bob repo:evil/x')
	assert.equal(q.kind, 'search')
	if (q.kind !== 'search') return
	assert.deepEqual(q.terms, ['fix', 'login'])
	assert.deepEqual(q.qualifiers, [
		['author', 'alice'],
		['head', 'feat/login'],
		['base', '"release/2.0"'],
		['author', 'bob'],
	])
	assert.deepEqual(q.dropped, ['repo:evil/x'])
	const s = buildSearch('octo/app', 'open', q)
	assert.match(s, /^repo:octo\/app is:pr is:open /)
	assert.ok(!s.includes('evil'), 'search never leaves the repository')
	assert.match(s, /fix login in:title$/)
	assert.equal(buildSearch('octo/app', 'closed', { kind: 'empty' }), 'repo:octo/app is:pr is:closed is:unmerged')
	assert.equal(buildSearch('octo/app', 'drafts', { kind: 'empty' }), 'repo:octo/app is:pr is:open draft:true')
})

test('GitHub remotes: HTTPS, SSH, scp-like, with and without .git; others rejected', () => {
	for (const u of [
		'https://github.com/octo/app.git',
		'https://github.com/octo/app',
		'https://user@github.com/octo/app.git',
		'git@github.com:octo/app.git',
		'ssh://git@github.com/octo/app.git',
		'ssh://git@ssh.github.com:443/octo/app.git',
		'git://github.com/octo/app',
		'github.com:octo/app',
	])
		assert.equal(parseGitHubRemote(u), 'octo/app', u)
	assert.equal(parseGitHubRemote('https://gitlab.com/octo/app.git'), null)
	assert.equal(parseGitHubRemote('https://github.com.evil.com/octo/app'), null)
	assert.equal(parseGitHubRemote('/local/path'), null)
	assert.equal(parseGitHubRemote('https://github.com/octo/app/extra'), null)
})

test('branch tree groups namespaces per section and search keeps remote identity', () => {
	const b = (ref: string): BranchRef => {
		const remote = ref.startsWith('refs/remotes/') ? ref.split('/')[2] : null
		const short = ref.replace(/^refs\/(heads|remotes\/[^/]+)\//, '')
		return {
			ref,
			name: remote ? `${remote}/${short}` : short,
			kind: remote ? 'remote' : 'local',
			remote,
			short,
			sha: 'a'.repeat(40),
			date: '',
			subject: '',
			upstream: null,
			ahead: null,
			behind: null,
			upstreamGone: false,
			current: false,
		}
	}
	const all = [
		'refs/heads/main',
		'refs/heads/feat/a',
		'refs/heads/feat/deep/b',
		'refs/remotes/origin/main',
		'refs/remotes/upstream/main',
		'refs/remotes/origin/feat/a',
	].map(b)
	const local = all.filter((x) => x.kind === 'local')
	const collapsed = branchRows(local, 'l', new Set())
	assert.deepEqual(
		collapsed.map((r) => (r.t === 'folder' ? `${r.name}/(${r.count})` : r.label)),
		['main', 'feat/(2)'],
	)
	const open = branchRows(local, 'l', new Set(['l:feat', 'l:feat/deep']))
	assert.deepEqual(
		open.map((r) => `${r.depth}:${r.t === 'folder' ? `${r.name}/` : r.label}`),
		['0:main', '0:feat/', '1:a', '1:deep/', '2:b'],
	)
	const mains = matchBranches(all, 'main').map((x) => x.name)
	assert.deepEqual(mains, ['main', 'origin/main', 'upstream/main'], 'identical names stay distinct and local ranks first')
	assert.deepEqual(
		matchBranches(all, 'upstream/main').map((x) => x.ref),
		['refs/remotes/upstream/main'],
	)
	assert.deepEqual(
		matchBranches(all, 'origin feat').map((x) => x.ref),
		['refs/remotes/origin/feat/a'],
	)
	// 10k branches stay instant.
	const many = Array.from({ length: 10_000 }, (_, i) => b(`refs/heads/team${i % 50}/topic-${i}`))
	const t0 = performance.now()
	assert.equal(matchBranches(many, 'topic-9999').length, 1)
	assert.equal(branchRows(many, 'l', new Set(['l:team3'])).length, 50 + 200)
	assert.ok(performance.now() - t0 < 500, 'large branch lists stay fast')
})

test('IPC validation: targets, browser state bounds and tokens', () => {
	assert.deepEqual(reviewTarget({ kind: 'pr', repo: 'octo/app', number: 3 }), { kind: 'pr', repo: 'octo/app', number: 3 })
	assert.throws(() => reviewTarget({ kind: 'pr', repo: '../x', number: 3 }))
	assert.throws(() => reviewTarget({ kind: 'branch', headRef: '--upload-pack=x', baseRef: 'refs/heads/main' }))
	assert.throws(() => reviewTarget({ kind: 'branch', headRef: 'refs/heads/a b', baseRef: 'refs/heads/main' }))
	assert.throws(() => githubToken('ghp_short'))
	assert.throws(() => githubToken('ghp_' + 'x'.repeat(30) + '\nX: y'))
	const s = browserState({
		view: 'browse',
		section: 'remote:upstream',
		prFilter: 'open',
		prQuery: 'x',
		branchQuery: '',
		selected: { kind: 'branch', ref: 'refs/remotes/upstream/main' },
		baseRef: null,
		expanded: ['a', 'a'],
		pinned: ['refs/heads/main'],
		scroll: { k: 12.4, bad: -1 },
	})
	assert.deepEqual(s.expanded, ['a'])
	assert.deepEqual(s.scroll, { k: 12 })
	assert.throws(() => browserState({ ...s, section: 'evil' }))
})

// ─── Git: branches, bases, isolation ───────────────────────────────────────────

test('reads local and remote branches distinctly, skips HEAD aliases, ranks a repository-specific base', async () => {
	const w = world()
	const repo = await readRepo(await findRoot(w.clone))
	const names = repo.branches.map((b) => b.name).sort()
	assert.ok(names.includes('main') && names.includes('origin/main') && names.includes('upstream/main'))
	assert.ok(!names.some((n) => n.endsWith('/HEAD')), 'symbolic remote HEAD aliases are excluded')
	const localMain = repo.branches.find((b) => b.ref === 'refs/heads/main')!
	const originMain = repo.branches.find((b) => b.ref === 'refs/remotes/origin/main')!
	const upstreamMain = repo.branches.find((b) => b.ref === 'refs/remotes/upstream/main')!
	assert.notEqual(localMain.sha, upstreamMain.sha)
	assert.notEqual(originMain.sha, upstreamMain.sha)
	assert.equal(localMain.current, true)
	assert.equal(localMain.upstream, 'refs/remotes/origin/main')
	assert.equal(localMain.ahead, 1, 'ahead/behind is relative to the upstream')
	assert.equal(localMain.behind, 0)
	assert.equal(repo.baseCandidates[0], 'refs/remotes/upstream/main', 'upstream default branch ranks first')
	assert.deepEqual(
		repo.remotes.map((r) => [r.name, r.github]),
		[
			['origin', 'alice/app'],
			['upstream', 'octo/app'],
		],
	)
	const m = mapping(repo, null)
	assert.equal(m.selected, 'octo/app', 'defaults to upstream')
	assert.equal(mapping(repo, 'alice/app').selected, 'alice/app')
	assert.equal(mapping(repo, 'nope/nope').chosen, false)

	// A repository whose default is "trunk" (and has no main) picks trunk.
	const t = tmp()
	const r = runner(t)
	r('init', '-q', '-b', 'trunk')
	commit(r, t, 'x', 'x', 'x')
	r('checkout', '-qb', 'topic')
	const info = await readRepo(t)
	assert.equal(info.defaultBase, 'refs/heads/trunk')
})

test('branch review: merge-base → head for a non-checked-out branch, with checkout, index and working tree untouched', async () => {
	const w = world()
	writeFileSync(join(w.clone, 'dirty.txt'), 'uncommitted\n')
	runner(w.clone)('add', 'dirty.txt')
	writeFileSync(join(w.clone, 'a.txt'), 'edited but unstaged\n')
	const before = repoState(w.clone)
	const gh = new GitHubService(memoryTokens(), { base: 'http://127.0.0.1:9' })
	const { svc, store } = await service(gh)
	const s = await svc.open(w.clone)
	const r = await svc.loadComparison(s.repo.id, {
		kind: 'target',
		target: { kind: 'branch', headRef: 'refs/heads/feat/local-only', baseRef: 'refs/remotes/upstream/main' },
	})
	const c = r.comparison
	assert.equal(c.headSha, runner(w.clone)('rev-parse', 'feat/local-only'))
	assert.equal(c.baseTipSha, w.upMain)
	assert.equal(c.baseSha, w.base, 'compares against the merge base, not the base tip or local HEAD')
	assert.deepEqual(
		c.files.map((f) => f.key),
		['local.txt'],
	)
	assert.equal(c.headRef, 'feat/local-only')
	assert.deepEqual(repoState(w.clone), before, 'checkout, index, working tree and branches are unchanged')
	// Probe detects new commits on the target branch and never switches the review.
	runner(w.clone)(
		'update-ref',
		'refs/heads/feat/local-only',
		runner(w.clone)('commit-tree', '-p', c.headSha, '-m', 'more', `${c.headSha}^{tree}`),
	)
	const p = await svc.probeTarget(s.repo.id, c.id)
	assert.equal(p.changed, true)
	assert.match(p.summary!, /feat\/local-only is now at/)
	assert.equal(store.read().repos[s.repo.id].activeReviewId, c.id)

	// Missing refs and unrelated histories are explicit.
	await assert.rejects(
		svc.loadComparison(s.repo.id, { kind: 'target', target: { kind: 'branch', headRef: 'refs/heads/nope', baseRef: 'refs/heads/main' } }),
		{ code: 'not-found' },
	)
	const run = runner(w.clone)
	const orphan = run('commit-tree', '-m', 'orphan', '4b825dc642cb6eb9a060e54bf8d69288fbee4904') // the empty tree
	run('update-ref', 'refs/heads/orphan', orphan)
	await svc.refresh(s.repo.id)
	await assert.rejects(
		svc.loadComparison(s.repo.id, { kind: 'target', target: { kind: 'branch', headRef: 'refs/heads/orphan', baseRef: 'refs/heads/main' } }),
		{ code: 'unrelated-histories' },
	)
})

test('shallow clones report missing history instead of "unrelated"', async () => {
	const w = world()
	const shallow = join(w.root, 'shallow')
	execFileSync('git', ['clone', '-q', '--depth', '1', '--no-single-branch', `file://${w.fork}`, shallow])
	const gh = new GitHubService(memoryTokens(), { base: 'http://127.0.0.1:9' })
	const { svc } = await service(gh)
	const s = await svc.open(shallow)
	assert.equal(s.repo.shallow, true)
	await assert.rejects(
		svc.loadComparison(s.repo.id, {
			kind: 'target',
			target: { kind: 'branch', headRef: 'refs/remotes/origin/feat/login', baseRef: 'refs/remotes/origin/main' },
		}),
		{ code: 'shallow-history' },
	)
})

test('ensureCommits fetches exact SHAs into app-owned refs only, and pins present commits without network', async () => {
	const w = world()
	// A commit that exists only on the upstream server (like a PR head from a fork nobody has fetched).
	const sd = runner(w.seed)
	sd('checkout', '-q', '-b', 'server-only', w.base)
	const only = commit(sd, w.seed, 'z.txt', 'z\n', 'server only')
	sd('push', '-q', w.up, `${only}:refs/pull/20/head`)
	const before = repoState(w.clone)
	const fetchHead = readFileSync(join(w.clone, '.git', 'FETCH_HEAD'), 'utf8')
	const { fetched } = await ensureCommits(w.clone, 'upstream', [only, w.upMain])
	assert.deepEqual(fetched, [only], 'only the missing commit is fetched')
	const after = repoState(w.clone)
	assert.deepEqual(after, before, 'no branch or remote-tracking ref moved, index and tree untouched')
	const run = runner(w.clone)
	assert.equal(run('rev-parse', `${KEEP_PREFIX}${only}`), only)
	assert.equal(run('rev-parse', `${KEEP_PREFIX}${w.upMain}`), w.upMain)
	assert.equal(readFileSync(join(w.clone, '.git', 'FETCH_HEAD'), 'utf8'), fetchHead, 'FETCH_HEAD not rewritten')
	await assert.rejects(ensureCommits(w.clone, 'upstream', ['f'.repeat(40)]), { code: 'pr-unavailable' })
	await assert.rejects(ensureCommits(w.clone, '--upload-pack=touch /tmp/x', [only]), { code: 'invalid-input' })
})

// ─── Pull requests end to end (mock API, real Git fetch) ───────────────────────

const PR7 = (w: ReturnType<typeof world>): MockPr => ({
	number: 7,
	title: 'Add login',
	state: 'open',
	author: 'alice',
	headRef: 'feat/login',
	headRepo: 'alice/app',
	baseRef: 'main',
	baseSha: w.upMain, // GitHub's base SHA is the base branch tip, not the merge base
	headSha: w.pr1,
	updatedAt: '2026-09-01T00:00:00Z',
})

test('fork PR opens at merge-base(base, head)..head without touching the checkout, and pins its snapshot', async () => {
	const w = world()
	const mock = await mockGitHub([PR7(w)])
	try {
		const gh = new GitHubService(memoryTokens(), { base: mock.base })
		const { svc, store } = await service(gh)
		const s = await svc.open(w.clone)
		assert.equal(s.github.selected, 'octo/app')
		const before = repoState(w.clone)
		const r = await svc.loadComparison(s.repo.id, { kind: 'target', target: { kind: 'pr', repo: 'octo/app', number: 7 } })
		const c = r.comparison
		assert.equal(c.headSha, w.pr1)
		assert.equal(c.pr!.baseSha, w.upMain, 'original base SHA kept')
		assert.equal(c.baseSha, w.base, 'merge base kept separately')
		assert.notEqual(c.baseSha, c.pr!.baseSha)
		assert.equal(c.headRef, 'alice:feat/login')
		assert.deepEqual(
			c.files.map((f) => f.key),
			['login.txt'],
			'upstream-only changes on main do not appear',
		)
		assert.equal(r.notice, null)
		assert.deepEqual(repoState(w.clone), before, 'opening a PR changes no branch, index or working tree')
		assert.equal(store.read().repos[s.repo.id].reviews[c.id].pr!.number, 7)
		assert.ok(!mock.seen.some((x) => x.url.includes('/merge')), 'never asks for the synthetic merge commit')

		// A new push shows "update available"; the old snapshot and its comments stay put.
		const sd = runner(w.seed)
		sd('checkout', '-q', 'feat/login')
		const pr2 = commit(sd, w.seed, 'login.txt', 'login v2\n', 'login v2')
		sd('push', '-q', w.up, `${pr2}:refs/pull/7/head`)
		const review = r.review
		const anchor = {
			repoId: s.repo.id,
			baseSha: c.baseSha,
			headSha: c.headSha,
			fileKey: 'login.txt',
			oldPath: null,
			newPath: 'login.txt',
			side: 'new' as const,
			startLine: 1,
			endLine: 1,
			excerpt: 'login v1',
		}
		const now = new Date().toISOString()
		await svc.saveReview({
			...review,
			comments: [{ id: 'c1', anchor, body: 'nice', createdAt: now, updatedAt: now, findingId: null }],
			viewed: ['login.txt'],
		})
		const pr = PR7(w)
		pr.headSha = pr2
		mock.close()
		const mock2 = await mockGitHub([pr])
		try {
			const svc2 = new ReviewService(store, new GitHubService(memoryTokens(), { base: mock2.base }))
			const s2 = await svc2.open(w.clone)
			const probe = await svc2.probeTarget(s2.repo.id, c.id)
			assert.equal(probe.changed, true)
			assert.match(probe.summary!, /New head/)
			const next = await svc2.loadComparison(s2.repo.id, { kind: 'target', target: { kind: 'pr', repo: 'octo/app', number: 7 } })
			assert.equal(next.comparison.headSha, pr2)
			assert.equal(next.review.comments.length, 1, 'comments carry over to the new snapshot')
			assert.equal(next.review.comments[0].carried?.outdated?.reason, 'The commented lines changed.')
			assert.deepEqual(next.review.comments[0].carried?.outdated?.code, ['login v1'])
			assert.deepEqual(next.review.viewed, [], 'viewed files stay with the old snapshot')
			const old = await svc2.loadComparison(s2.repo.id, { kind: 'snapshot', reviewId: c.id })
			assert.equal(old.review.comments[0].body, 'nice', 'previous comments stay with the original snapshot')
			assert.deepEqual(old.review.viewed, ['login.txt'])
		} finally {
			await mock2.close()
		}
	} finally {
		await mock.close().catch(() => {})
	}
})

test('a PR that moves while loading resolves to one consistent snapshot, with a notice', async () => {
	const w = world()
	const sd = runner(w.seed)
	sd('checkout', '-q', 'feat/login')
	const pr2 = commit(sd, w.seed, 'login.txt', 'login v2\n', 'login v2')
	sd('push', '-q', w.up, `${pr2}:refs/pull/8/head`)
	const pr = { ...PR7(w), number: 8 }
	// First read says head = pr1; the re-read after fetching says pr2 (the author pushed meanwhile).
	const mock = await mockGitHub([pr], {
		onDetail: (_n, count) => {
			if (count === 2) pr.headSha = pr2
		},
	})
	try {
		const { svc } = await service(new GitHubService(memoryTokens(), { base: mock.base }))
		const s = await svc.open(w.clone)
		const r = await svc.loadComparison(s.repo.id, { kind: 'target', target: { kind: 'pr', repo: 'octo/app', number: 8 } })
		assert.equal(r.comparison.headSha, pr2)
		assert.equal(r.comparison.pr!.headSha, pr2, 'metadata and diff come from the same version')
		assert.equal(r.comparison.baseSha, w.base)
		assert.match(r.notice!, /updated while it was loading/)
		assert.ok(mock.detailCount.get(8)! >= 3, 'metadata re-read after each fetch')
	} finally {
		await mock.close()
	}
})

test('a PR that keeps changing fails explicitly instead of mixing snapshots', async () => {
	const w = world()
	const sd = runner(w.seed)
	sd('checkout', '-q', 'feat/login')
	const heads = [w.pr1]
	for (let i = 0; i < 4; i++) heads.push(commit(sd, w.seed, 'login.txt', `v${i}\n`, `v${i}`))
	for (const h of heads) sd('push', '-q', '-f', w.up, `${h}:refs/pull/9/head`)
	for (const h of heads) sd('push', '-q', '-f', w.up, `${h}:refs/keep/${h}`)
	const pr = { ...PR7(w), number: 9 }
	const mock = await mockGitHub([pr], { onDetail: (_n, count) => (pr.headSha = heads[Math.min(count, heads.length - 1)]) })
	try {
		const { svc } = await service(new GitHubService(memoryTokens(), { base: mock.base }))
		const s = await svc.open(w.clone)
		await assert.rejects(svc.loadComparison(s.repo.id, { kind: 'target', target: { kind: 'pr', repo: 'octo/app', number: 9 } }), {
			code: 'pr-changed',
		})
	} finally {
		await mock.close()
	}
})

test('historical PR whose commits are gone explains itself and does not show an empty diff', async () => {
	const w = world()
	const pr: MockPr = { ...PR7(w), number: 11, state: 'closed', headSha: 'e'.repeat(40) }
	const mock = await mockGitHub([pr])
	try {
		const { svc } = await service(new GitHubService(memoryTokens(), { base: mock.base }))
		const s = await svc.open(w.clone)
		await assert.rejects(
			svc.loadComparison(s.repo.id, { kind: 'target', target: { kind: 'pr', repo: 'octo/app', number: 11 } }),
			(e: { code: string; message: string }) => {
				assert.equal(e.code, 'pr-unavailable')
				assert.match(e.message, /Open it on GitHub/)
				return true
			},
		)
	} finally {
		await mock.close()
	}
})

test('PR search is provider-side and paginates beyond the first page; exact lookups and stale requests', async () => {
	const w = world()
	const prs: Array<MockPr> = Array.from({ length: 130 }, (_, i) => ({
		...PR7(w),
		number: 1000 + i,
		title: i === 120 ? 'Needle in the haystack' : `Change ${i}`,
		author: i % 2 ? 'alice' : 'bob',
		updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
	}))
	const mock = await mockGitHub(prs)
	try {
		// Anonymous: REST search, page-numbered.
		const anon = new GitHubService(memoryTokens(), { base: mock.base })
		const { svc } = await service(anon)
		const s = await svc.open(w.clone)
		const p1 = await svc.searchPrs(s.repo.id, { filter: 'open', text: '', cursor: null })
		assert.equal(p1.items.length, 50)
		assert.equal(p1.total, 130)
		assert.equal(p1.items[0].number, 1129, 'most recently updated first')
		const p3 = await svc.searchPrs(s.repo.id, {
			filter: 'open',
			text: '',
			cursor: (await svc.searchPrs(s.repo.id, { filter: 'open', text: '', cursor: p1.next })).next,
		})
		assert.equal(p3.items.length, 30)
		assert.equal(p3.next, null)
		// The needle is on page 1 of the result only because the search ran on the provider, not on downloaded pages.
		const needle = await svc.searchPrs(s.repo.id, { filter: 'all', text: 'needle', cursor: null })
		assert.deepEqual(
			needle.items.map((x) => x.number),
			[1120],
		)
		const q = mock.seen.find((x) => x.url.includes('needle'))!
		assert.match(new URL(q.url, 'http://x').searchParams.get('q')!, /^repo:octo\/app is:pr needle in:title sort:updated-desc$/)
		const byAuthor = await svc.searchPrs(s.repo.id, { filter: 'all', text: 'author:bob', cursor: null })
		assert.equal(byAuthor.total, 65)
		const exact = await svc.searchPrs(s.repo.id, { filter: 'open', text: '#1005', cursor: null })
		assert.equal(exact.exact, true)
		assert.equal(exact.items[0].number, 1005)
		assert.equal(exact.items[0].headRef, 'feat/login')
		const url = await svc.searchPrs(s.repo.id, { filter: 'open', text: 'https://github.com/octo/app/pull/1003', cursor: null })
		assert.equal(url.items[0].number, 1003)
		const other = await svc.searchPrs(s.repo.id, { filter: 'open', text: 'https://github.com/other/repo/pull/3', cursor: null })
		assert.equal(other.items.length, 0)
		assert.match(other.notice!, /other\/repo/)
		const missing = await svc.searchPrs(s.repo.id, { filter: 'open', text: '#5', cursor: null })
		assert.equal(missing.items.length, 0)
		await assert.rejects(svc.searchPrs(s.repo.id, { filter: 'mine', text: '', cursor: null }), { code: 'github-auth' })
		assert.ok(
			mock.seen.every((x) => !x.auth),
			'anonymous requests carry no Authorization header',
		)

		// Stale responses: a newer search in the same slot cancels the older one.
		const slow = svc.searchPrs(s.repo.id, { filter: 'all', text: 'Change', cursor: null })
		const fast = svc.searchPrs(s.repo.id, { filter: 'all', text: 'Needle', cursor: null })
		await assert.rejects(slow, { code: 'cancelled' })
		assert.equal((await fast).items[0].number, 1120)

		// With a token: GraphQL search with cursor pagination and branch names in rows.
		const tokens = memoryTokens()
		const authed = new GitHubService(tokens, { base: mock.base })
		await authed.setToken('ghp_' + 'a'.repeat(36), true)
		assert.equal(authed.status().state, 'connected')
		assert.equal(authed.status().login, 'me')
		const g1 = await authed.search('octo/app', { filter: 'open', text: '', cursor: null })
		assert.equal(g1.items.length, 50)
		assert.equal(g1.items[0].headRef, 'feat/login')
		assert.equal(g1.items[0].crossRepo, true)
		let cursor = g1.next
		const seen = new Set(g1.items.map((x) => x.number))
		while (cursor) {
			const g = await authed.search('octo/app', { filter: 'open', text: '', cursor })
			for (const x of g.items) seen.add(x.number)
			cursor = g.next
		}
		assert.equal(seen.size, 130, 'every page reachable')
		const gq = mock.seen.find((x) => x.url === '/graphql')!
		assert.equal(gq.auth, `Bearer ghp_${'a'.repeat(36)}`)
		assert.ok(!JSON.stringify(authed.status()).includes('ghp_'), 'status never contains the token')
	} finally {
		await mock.close()
	}
})

test('GitHub errors map to explicit states and cached results are served with their refresh time', async () => {
	let mode: 'ok' | 'rate' | 'forbidden' | 'down' | 'private' = 'ok'
	const server = http.createServer((req, res) => {
		if (mode === 'private') {
			res.writeHead(422, { 'content-type': 'application/json' })
			return res.end(
				JSON.stringify({
					message: 'Validation Failed',
					errors: [
						{
							message:
								'The listed users and repositories cannot be searched either because the resources do not exist or you do not have permission to view them.',
						},
					],
				}),
			)
		}
		if (mode === 'rate') {
			res.writeHead(403, { 'content-type': 'application/json', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9999999999' })
			return res.end('{"message":"API rate limit exceeded"}')
		}
		if (mode === 'forbidden') {
			res.writeHead(403, { 'content-type': 'application/json' })
			return res.end('{"message":"Resource not accessible by personal access token"}')
		}
		if (mode === 'down') return req.socket.destroy()
		res.writeHead(200, { 'content-type': 'application/json' })
		res.end(
			JSON.stringify({
				total_count: 1,
				incomplete_results: true,
				items: [
					{
						number: 1,
						title: 't',
						html_url: 'u',
						state: 'open',
						updated_at: '2026-01-01T00:00:00Z',
						user: { login: 'a' },
						pull_request: { merged_at: null },
					},
				],
			}),
		)
	})
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
	try {
		const gh = new GitHubService(memoryTokens(), { base })
		const q = { filter: 'open' as const, text: '', cursor: null }
		const fresh = await gh.search('octo/app', q)
		assert.equal(fresh.incomplete, true, 'provider-reported incomplete results are surfaced')
		mode = 'rate'
		const cached = await gh.search('octo/app', q)
		assert.equal(cached.stale, true)
		assert.equal(cached.error!.code, 'github-rate-limited')
		assert.equal(cached.fetchedAt, fresh.fetchedAt)
		await assert.rejects(gh.search('octo/app', { ...q, text: 'other' }), { code: 'github-rate-limited' })
		mode = 'forbidden'
		await assert.rejects(gh.detail('octo/app', 1), { code: 'github-forbidden' })
		mode = 'down'
		await assert.rejects(gh.search('octo/app', { ...q, text: 'x' }), { code: 'offline' })
		mode = 'private'
		await assert.rejects(gh.search('octo/app', { ...q, text: 'y' }), {
			code: 'github-not-found',
			message: /Private repositories need a GitHub token/,
		})
		await assert.rejects(gh.search('bad repo', q), { code: 'invalid-input' })
	} finally {
		await new Promise<void>((r) => server.close(() => r()))
	}
})

test('browser state and GitHub repository choice persist per repository; opening a review never starts AI', async () => {
	const w = world()
	const gh = new GitHubService(memoryTokens(), { base: 'http://127.0.0.1:9' })
	const { svc, store } = await service(gh)
	const s = await svc.open(w.clone)
	assert.equal(s.browser.section, 'prs')
	const state = {
		...s.browser,
		section: 'remote:upstream' as const,
		branchQuery: 'main',
		pinned: ['refs/remotes/upstream/main'],
		expanded: ['r:origin:feat'],
		scroll: { x: 40 },
	}
	await svc.saveBrowserState(s.repo.id, state)
	await svc.setGitHubRepo(s.repo.id, 'alice/app')
	await assert.rejects(svc.setGitHubRepo(s.repo.id, 'evil/app'), { code: 'invalid-input' })
	const again = await new ReviewService(store, gh).open(w.clone)
	assert.deepEqual(again.browser, state)
	assert.equal(again.github.selected, 'alice/app')
	assert.equal(again.github.chosen, true)

	let started = 0
	svc.attachAi({ cancelUnless() {}, runsFor: () => [], start: async () => (started++, null as never) } as never)
	await svc.loadComparison(s.repo.id, {
		kind: 'target',
		target: { kind: 'branch', headRef: 'refs/heads/feat/local-only', baseRef: 'refs/heads/main' },
	})
	assert.equal(started, 0)

	// Legacy reviews (before targets existed) still reopen and probe as HEAD vs base.
	const legacy = Object.values(store.read().repos[s.repo.id].reviews)[0]
	await store.update((d) => {
		const r = d.repos[s.repo.id].reviews[legacy.id]
		delete r.target
		delete r.pr
	})
	const reopened = await svc.loadComparison(s.repo.id, { kind: 'snapshot', reviewId: legacy.id })
	assert.equal(reopened.comparison.id, legacy.id)
	assert.equal((await svc.probeTarget(s.repo.id, legacy.id)).error, null)
})

test('branches find their pull request by the owner they are pushed to', async () => {
	const w = world()
	const c = runner(w.clone)
	// A local branch tracking the fork's feat/login, and one with no upstream.
	c('branch', '-q', '--track', 'login-work', 'origin/feat/login')
	const merged: MockPr = { ...PR7(w), number: 3, state: 'closed', merged: true, updatedAt: '2026-01-01T00:00:00Z' }
	const mock = await mockGitHub([PR7(w), merged])
	try {
		const { svc } = await service(new GitHubService(memoryTokens(), { base: mock.base }))
		const s = await svc.open(w.clone)
		assert.equal(pushHead(s.repo, 'refs/heads/login-work'), 'alice:feat/login', 'upstream remote owner and upstream branch name')
		assert.equal(pushHead(s.repo, 'refs/remotes/origin/feat/login'), 'alice:feat/login')
		assert.equal(pushHead(s.repo, 'refs/remotes/upstream/main'), 'octo:main')
		assert.equal(pushHead(s.repo, 'refs/heads/feat/local-only'), 'alice:feat/local-only', 'no upstream: same name on origin')
		assert.equal(pushHead(s.repo, 'refs/heads/nope'), null)
		const r = await svc.branchPr(s.repo.id, 'refs/heads/login-work')
		assert.equal(r.repo, 'octo/app')
		assert.deepEqual(
			r.prs.map((p) => [p.number, p.state]),
			[
				[7, 'open'],
				[3, 'merged'],
			],
			'open first, then older',
		)
		const calls = mock.seen.length
		await svc.branchPr(s.repo.id, 'refs/heads/login-work')
		assert.equal(mock.seen.length, calls, 'cached')
		assert.deepEqual((await svc.branchPr(s.repo.id, 'refs/heads/feat/local-only')).prs, [])
		// refs/remotes/pr/<n> (from `git fetch origin pull/<n>/head:refs/remotes/pr/<n>`) resolves by number.
		c('update-ref', 'refs/remotes/pr/7', w.pr1)
		await svc.refresh(s.repo.id)
		const byNumber = await svc.branchPr(s.repo.id, 'refs/remotes/pr/7')
		assert.equal(byNumber.head, '#7')
		assert.equal(byNumber.prs[0].number, 7)
	} finally {
		await mock.close()
	}
})

test('GitHub CLI login: used only when enabled, never stored, re-read after rejection; a saved token wins', async () => {
	let cliToken = 'gho_' + 'a'.repeat(36)
	let reads = 0
	const cli = {
		detect: async () => ({ login: 'cli-user' }),
		token: async () => {
			reads++
			return cliToken
		},
	}
	const seen: Array<string | undefined> = []
	const server = http.createServer((req, res) => {
		seen.push(req.headers.authorization)
		const ok = req.headers.authorization === `Bearer ${cliToken}` || req.headers.authorization === `Bearer ghp_${'s'.repeat(36)}`
		res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json', 'x-oauth-scopes': 'repo, read:org' })
		res.end(
			JSON.stringify(
				ok ? { login: req.headers.authorization!.includes('ghp_') ? 'saved-user' : 'cli-user' } : { message: 'Bad credentials' },
			),
		)
	})
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
	const dir = tmp()
	try {
		const tokens = memoryTokens()
		const gh = new GitHubService(tokens, { base, cli, dir })
		await gh.load()
		assert.deepEqual(gh.status().cli, { available: true, login: 'cli-user', enabled: false })
		assert.equal(gh.status().source, null, 'not used until the user opts in')
		await gh.verify()
		assert.equal(reads, 0)

		await gh.useCli(true)
		assert.equal(gh.status().source, 'gh')
		assert.equal(gh.status().state, 'connected')
		assert.equal(gh.status().login, 'cli-user')
		assert.deepEqual(gh.status().scopes, ['repo', 'read:org'])
		assert.ok(!readFileSync(join(dir, 'github-settings.json'), 'utf8').includes('gho_'), 'the gh token is never written')
		assert.ok(!JSON.stringify(gh.status()).includes('gho_'))

		// gh refreshed its token: the old one is rejected once, then the new one is read.
		cliToken = 'gho_' + 'b'.repeat(36)
		await gh.verify()
		assert.equal(gh.status().state, 'failed')
		await gh.verify()
		assert.equal(gh.status().state, 'connected')

		// A token saved in the app takes precedence; the choice persists across restarts.
		await gh.setToken('ghp_' + 's'.repeat(36), true)
		assert.equal(gh.status().source, 'app')
		assert.equal(gh.status().login, 'saved-user')
		const again = new GitHubService(memoryTokens(), { base, cli, dir })
		await again.load()
		assert.equal(again.status().source, 'gh')

		await assert.rejects(
			new GitHubService(memoryTokens(), { base, cli: { detect: async () => null, token: async () => null } }).useCli(true),
			/gh auth login/,
		)
	} finally {
		await new Promise<void>((r) => server.close(() => r()))
	}
})

test('repository tabs: opening adds a tab once, closing keeps the repository known, closing the last forgets the restore', async () => {
	const w = world()
	const gh = new GitHubService(memoryTokens(), { base: 'http://127.0.0.1:9' })
	const { svc, store } = await service(gh)
	const a = await svc.open(w.clone)
	const b = await svc.open(w.seed)
	assert.deepEqual(
		b.tabs.map((t) => [t.id, t.name]),
		[
			[a.repo.id, 'clone'],
			[b.repo.id, 'seed'],
		],
	)
	// Reopening (switching tabs, a notification) keeps the order and adds nothing.
	const again = await svc.openKnown(a.repo.id)
	assert.deepEqual(
		again.tabs.map((t) => t.id),
		[a.repo.id, b.repo.id],
	)

	assert.deepEqual(
		(await svc.closeTab(a.repo.id)).map((t) => t.id),
		[b.repo.id],
	)
	assert.ok(store.read().repos[a.repo.id], 'a closed tab keeps its reviews and notifications')
	assert.ok(svc.knownGitHubRepos().size > 0)

	// Without a connected GitHub the stored check is stale, so tabs show no count rather than an old one.
	await store.update((d) => void (d.inboxWatch = { login: 'me', state: { 'x/y#1': { draft: false, reviewed: false } }, at: '' }))
	assert.deepEqual(
		svc.tabs().map((t) => t.requests),
		[null],
	)

	assert.deepEqual(await svc.closeTab(b.repo.id), [])
	assert.equal(store.read().lastRepoId, null)
	assert.equal(await svc.restoreLast(), null)
})
