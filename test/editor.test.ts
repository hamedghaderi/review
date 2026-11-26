import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkoutWorktree, setManagedClones } from '../src/main/git.ts'
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
