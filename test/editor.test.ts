import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkoutWorktree, removeWorktree, setManagedClones } from '../src/main/git.ts'
import { findEditors, pickEditor } from '../src/main/editors.ts'
import { ReviewService } from '../src/main/service.ts'
import { ReviewStore } from '../src/main/store.ts'

const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'review-editor-')))
const sh = (cwd: string, ...a: Array<string>): string =>
	execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
		cwd,
		encoding: 'utf8',
	}).trim()

test('a pull request opens in a worktree of its own: your folder, branch, config and edits there are left alone, and no hook runs', async () => {
	const repo = tmp()
	sh(repo, 'init', '-q', '-b', 'main')
	mkdirSync(join(repo, 'src'))
	writeFileSync(join(repo, 'src', 'a.ts'), 'a\n')
	writeFileSync(join(repo, 'b.ts'), 'b\n')
	// A hooks path inside the repository: checking out would run the pull request's own hook.
	mkdirSync(join(repo, '.hooks'))
	writeFileSync(join(repo, '.hooks', 'post-checkout'), `#!/bin/sh\ntouch "${join(repo, 'HOOK-RAN')}"\n`)
	chmodSync(join(repo, '.hooks', 'post-checkout'), 0o755)
	sh(repo, 'add', '-A')
	sh(repo, 'commit', '-qm', 'one')
	sh(repo, 'checkout', '-qb', 'topic')
	writeFileSync(join(repo, 'src', 'a.ts'), 'a2\n')
	sh(repo, 'commit', '-qam', 'two')
	const first = sh(repo, 'rev-parse', 'HEAD')
	writeFileSync(join(repo, 'src', 'a.ts'), 'a3\n')
	sh(repo, 'commit', '-qam', 'three')
	const second = sh(repo, 'rev-parse', 'HEAD')
	sh(repo, 'checkout', '-q', 'main')
	sh(repo, 'config', 'core.hooksPath', '.hooks')

	const dir = join(tmp(), 'app-pr-7')
	await checkoutWorktree(repo, dir, first)
	assert.equal(sh(dir, 'rev-parse', 'HEAD'), first)
	assert.equal(readFileSync(join(dir, 'src', 'a.ts'), 'utf8'), 'a2\n')
	assert.equal(sh(repo, 'symbolic-ref', '--short', 'HEAD'), 'main', 'your folder stays on its branch')
	assert.equal(sh(repo, 'status', '--porcelain'), '')
	assert.ok(!existsSync(join(repo, 'HOOK-RAN')), 'no hook ran')
	assert.equal(sh(repo, 'config', '--local', '--list').includes('worktreeconfig'), false, 'your config is unchanged')

	// New commits move it; an edit there that doesn't clash is kept.
	writeFileSync(join(dir, 'b.ts'), 'mine\n')
	await checkoutWorktree(repo, dir, second)
	assert.equal(sh(dir, 'rev-parse', 'HEAD'), second)
	assert.equal(readFileSync(join(dir, 'b.ts'), 'utf8'), 'mine\n')
	// One that clashes stops it, with the edit still there.
	writeFileSync(join(dir, 'src', 'a.ts'), 'clash\n')
	await assert.rejects(checkoutWorktree(repo, dir, first), /Couldn't move/)
	assert.equal(readFileSync(join(dir, 'src', 'a.ts'), 'utf8'), 'clash\n')
	assert.ok(!existsSync(join(repo, 'HOOK-RAN')))

	// A worktree folder you deleted is made again.
	rmSync(dir, { recursive: true, force: true })
	await checkoutWorktree(repo, dir, second)
	assert.equal(sh(dir, 'rev-parse', 'HEAD'), second)
})

test("the app's sparse clone gives the worktree every file and stays sparse itself", async () => {
	const work = tmp()
	sh(work, 'init', '-q', '-b', 'main')
	mkdirSync(join(work, 'src'))
	writeFileSync(join(work, 'README.md'), 'hello\n')
	writeFileSync(join(work, 'src', 'app.ts'), 'export const a = 1\n')
	sh(work, 'add', '-A')
	sh(work, 'commit', '-qm', 'first')
	const server = tmp()
	mkdirSync(join(server, 'octo'))
	sh(server, 'clone', '-q', '--bare', work, join(server, 'octo', 'app.git'))
	sh(join(server, 'octo', 'app.git'), 'config', 'uploadpack.allowFilter', 'true')
	setManagedClones(() => 'Authorization: Basic secret', `file://${server}`)
	const store = ReviewStore.in(tmp())
	await store.load()
	const s = await new ReviewService(store, null).openGitHubClone('octo/app', tmp())

	const dir = join(tmp(), 'app-pr-1')
	await checkoutWorktree(s.repo.root, dir, sh(work, 'rev-parse', 'HEAD'))
	assert.equal(readFileSync(join(dir, 'src', 'app.ts'), 'utf8'), 'export const a = 1\n')
	assert.ok(!existsSync(join(s.repo.root, 'src')), 'the clone still has only its top-level files')
})

test('editors are found by app on macOS and by command elsewhere; the chosen one wins while installed', async () => {
	const have = (paths: Array<string>) => async (p: string) => paths.includes(p)
	const mac = await findEditors(
		'darwin',
		'/Users/me',
		'/usr/bin',
		have(['/Applications/Zed.app', '/Users/me/Applications/WebStorm.app', '/Applications/Visual Studio Code.app']),
	)
	assert.deepEqual(
		mac.map((e) => [e.id, e.path]),
		[
			['vscode', '/Applications/Visual Studio Code.app'],
			['zed', '/Applications/Zed.app'],
			['webstorm', '/Users/me/Applications/WebStorm.app'],
		],
	)
	const linux = await findEditors('linux', '/home/me', '/usr/bin:/home/me/.local/bin', have(['/home/me/.local/bin/zeditor']))
	assert.deepEqual(linux, [{ id: 'zed', label: 'Zed', path: '/home/me/.local/bin/zeditor' }])
	const win = await findEditors('win32', 'C:\\Users\\me', 'C:\\bin;C:\\code\\bin', have([join('C:\\code\\bin', 'code.cmd')]))
	assert.deepEqual(
		win.map((e) => e.id),
		['vscode'],
	)

	assert.equal(pickEditor(mac, 'zed')?.id, 'zed')
	assert.equal(pickEditor(mac, 'cursor')?.id, 'vscode', 'uninstalled: the first one found')
	assert.equal(pickEditor(mac, undefined)?.id, 'vscode')
	assert.equal(pickEditor([], 'zed'), null)
})

test("worktrees of merged or closed pull requests are removed unless you changed something there; deleting the app's clone trashes them", async () => {
	const repo = tmp()
	sh(repo, 'init', '-q', '-b', 'main')
	writeFileSync(join(repo, '.gitignore'), 'node_modules\n')
	writeFileSync(join(repo, 'a.ts'), 'a\n')
	sh(repo, 'add', '-A')
	sh(repo, 'commit', '-qm', 'one')
	const head = sh(repo, 'rev-parse', 'HEAD')

	const store = ReviewStore.in(tmp())
	await store.load()
	const states: Record<number, string> = { 1: 'merged', 2: 'closed', 3: 'open', 4: 'merged', 5: 'merged' }
	const github = { detail: async (_repo: string, n: number) => (n === 5 ? Promise.reject(new Error('offline')) : { state: states[n] }) }
	const svc = new ReviewService(store, github as never)
	const pr = (number: number) => ({ pr: { repo: 'octo/app', number } }) as never
	await store.update((d) => {
		d.repos[repo] = { repoId: repo, root: repo, selectedBase: null, activeReviewId: null, reviews: {}, aiRuns: {} }
		for (const n of [1, 2, 3, 4, 5]) d.repos[repo].reviews[`r${n}`] = pr(n)
		d.repos[repo].reviews.again = pr(1) // a second snapshot of #1
	})
	const parent = join(store.dir, 'worktrees', createHash('sha256').update(repo).digest('hex').slice(0, 8))
	const dir = (n: number) => join(parent, `app-pr-${n}`)
	for (const n of [1, 2, 3, 4, 5]) await checkoutWorktree(repo, dir(n), head)
	mkdirSync(join(dir(1), 'node_modules'))
	writeFileSync(join(dir(1), 'node_modules', 'x.js'), '') // ignored files don't keep it
	writeFileSync(join(dir(4), 'notes.md'), 'mine\n') // a new file does

	assert.equal(await svc.sweepWorktrees(), 2)
	assert.deepEqual(
		[1, 2, 3, 4, 5].map((n) => existsSync(dir(n))),
		[false, false, true, true, true],
		'open, changed and unreadable ones stay',
	)
	assert.ok(!sh(repo, 'worktree', 'list').includes('app-pr-1'), 'git forgets them too')
	assert.equal(await removeWorktree(join(repo, 'missing'), dir(3)), false)

	const trashed: Array<string> = []
	await store.update((d) => void (d.appClones = { [repo]: { repo: 'octo/app', at: '2026-11-26T00:00:00Z' } }))
	await new ReviewService(store, null).deleteAppClone(repo, async (p) => void trashed.push(p))
	assert.deepEqual(trashed, [repo, parent])
})
