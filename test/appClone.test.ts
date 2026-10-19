import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { git, isManagedClone, setManagedClones } from '../src/main/git.ts'
import { ReviewService } from '../src/main/service.ts'
import { ReviewStore } from '../src/main/store.ts'

const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'review-app-clone-')))
const sh = (cwd: string, ...a: Array<string>): string =>
	execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
		cwd,
		encoding: 'utf8',
	}).trim()

test("the app clones a repository you have no clone of where you choose, only it gets the token's header, and it can be deleted", async () => {
	// A stand-in for github.com: a bare repository at <server>/octo/app.git that allows partial clones.
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

	const parent = tmp()
	setManagedClones(() => 'Authorization: Basic secret', `file://${server}`)
	const store = ReviewStore.in(tmp())
	await store.load()
	const svc = new ReviewService(store, null)

	const s = await svc.openGitHubClone('octo/app', parent)
	const root = join(parent, 'app')
	assert.equal(s.repo.root, root)
	assert.ok(isManagedClone(root))
	assert.equal(sh(root, 'config', '--get', 'remote.origin.partialclonefilter'), 'blob:none', 'a partial clone')
	assert.equal(sh(root, 'ls-files').split('\n').length, 2, 'every file is tracked')
	assert.equal(sh(root, 'status', '--porcelain'), '', 'only top-level files are checked out, and nothing reads as deleted')

	// Git sees the header only in the app's clones, and it is never written to their config.
	const header = async (cwd: string) =>
		(await git(cwd, ['config', '--get', 'http.https://github.com/.extraHeader'])).stdout.toString().trim()
	assert.equal(await header(root), 'Authorization: Basic secret')
	assert.equal(await header(work), '')
	assert.ok(!readFileSync(join(root, '.git', 'config'), 'utf8').includes('secret'))

	// File contents that were never downloaded are fetched when a review reads them.
	sh(work, 'checkout', '-qb', 'topic')
	writeFileSync(join(work, 'src', 'app.ts'), 'export const a = 2\n')
	sh(work, 'commit', '-qam', 'topic')
	sh(work, 'push', '-q', join(server, 'octo', 'app.git'), 'topic')
	sh(root, 'fetch', '-q', 'origin', 'topic:refs/remotes/origin/topic')
	const { comparison } = await svc.loadComparison(s.repo.id, {
		kind: 'target',
		target: { kind: 'branch', headRef: 'refs/remotes/origin/topic', baseRef: 'refs/heads/main' },
	})
	assert.deepEqual(
		comparison.files.map((f) => f.key),
		['src/app.ts'],
	)
	const lines = await svc.loadFileLines(comparison.id, 'src/app.ts')
	assert.equal(lines.kind === 'text' && lines.lines.join('\n'), 'export const a = 2')
	sh(work, 'checkout', '-q', 'main')

	// Opening it again reuses the clone. (A github.com remote maps to "octo/app" by itself; this file:// one does not.)
	await store.update((d) => void (d.repos[s.repo.id].githubResolved = 'octo/app'))
	sh(work, 'commit', '-q', '--allow-empty', '-m', 'second')
	const again = await svc.openGitHubClone('octo/app', tmp())
	assert.equal(again.repo.id, s.repo.id)
	assert.equal(store.read().cloneParent, parent, 'the folder picker starts here next time')
	assert.deepEqual(
		(await svc.appClones()).map((c) => [c.repoId, c.repo, c.root, (c.bytes ?? 0) > 0]),
		[[s.repo.id, 'octo/app', root, true]],
	)

	// A clone you opened yourself wins over the app's.
	await store.update((d) => {
		d.repos['mine'] = {
			repoId: 'mine',
			root: work,
			selectedBase: null,
			activeReviewId: null,
			reviews: {},
			aiRuns: {},
			githubResolved: 'Octo/App',
		}
	})
	assert.equal(svc.knownGitHubRepos().get('octo/app'), 'mine')

	await assert.rejects(svc.openGitHubClone('octo/..', parent), /Invalid GitHub repository/)

	// Only the app's own clones can be deleted; the folder goes to the trash first, then the app forgets the repository.
	const trashed: Array<string> = []
	const trash = async (p: string) => void trashed.push(p)
	await assert.rejects(svc.deleteAppClone('mine', trash), /not cloned by the app/)
	const failing = async () => {
		throw new Error('Trash is full')
	}
	await assert.rejects(svc.deleteAppClone(s.repo.id, failing), /Trash is full/)
	assert.ok(store.read().repos[s.repo.id], 'nothing forgotten when the folder could not be moved')
	const tabs = await svc.deleteAppClone(s.repo.id, trash)
	assert.deepEqual(trashed, [root])
	assert.ok(!store.read().repos[s.repo.id])
	assert.ok(!tabs.some((t) => t.id === s.repo.id))
	assert.deepEqual(await svc.appClones(), [])
	assert.ok(!isManagedClone(root), 'no longer gets the header')
	assert.ok(existsSync(root), 'the fake trash leaves the folder; the real one moves it')

	// A clone deleted by hand is listed as missing, and deleting it only forgets it.
	const gone = join(parent, 'gone')
	await store.update((d) => {
		d.repos[gone] = { repoId: gone, root: gone, selectedBase: null, activeReviewId: null, reviews: {}, aiRuns: {} }
		d.appClones = { [gone]: { repo: 'octo/gone', at: '2026-10-19T00:00:00Z' } }
	})
	assert.deepEqual(
		(await svc.appClones()).map((c) => [c.repo, c.missing]),
		[['octo/gone', true]],
	)
	await svc.deleteAppClone(gone, failing)
	assert.deepEqual(await svc.appClones(), [])
	assert.ok(!store.read().repos[gone])
})
