import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { findOriginals } from '../src/main/backports.ts'
import { backportSummary, cherryPickedFrom, isBackport } from '../src/shared/backports.ts'

test('the cherry-pick line names the original; the last one when picked twice', () => {
	const sha = 'a'.repeat(40)
	assert.equal(cherryPickedFrom(`Fix it\n\n(cherry picked from commit ${sha})`), sha)
	assert.equal(cherryPickedFrom(`x\n\n(cherry picked from commit 1234567)\n(cherry picked from commit ${sha})`), sha)
	assert.equal(cherryPickedFrom('Fix it\n\ncherry picked from nowhere'), null)
})

test('the summary counts each kind, and only commits with an original make it a backport', () => {
	const row = (state: 'same' | 'differs' | 'none') => ({ sha: '', subject: '', state, original: null, via: null, pr: null, diff: [] })
	const b = { defaultBranch: 'main', commits: [row('same'), row('same'), row('differs'), row('none')], error: null }
	assert.equal(backportSummary(b), '2 same as on main, 1 differs, 1 new')
	assert.equal(isBackport(b), true)
	assert.equal(isBackport({ ...b, commits: [row('none')] }), false)
})

test('from Git: a backport’s commits matched with their originals on main', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'review-backports-'))
	const git = (...a: Array<string>): string =>
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
			cwd: dir,
			encoding: 'utf8',
		}).trim()
	const lines = (at: Record<number, string>) => Array.from({ length: 30 }, (_, i) => at[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'
	const commit = (files: Record<string, string>, msg: string): string => {
		for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t)
		git('add', '-A')
		git('commit', '-qm', msg)
		return git('rev-parse', 'HEAD')
	}
	git('init', '-q', '-b', 'main')
	commit({ 'a.py': lines({}), 'b.py': lines({}), 'c.py': lines({}), 'd.py': lines({}) }, 'base')
	git('branch', 'release')
	const fixA = commit({ 'a.py': lines({ 5: 'fixed a' }) }, 'Fix a')
	const fixB = commit({ 'b.py': lines({ 5: 'fixed b', 6: 'uses new_api()' }) }, 'Fix b')
	const fixC = commit({ 'c.py': lines({ 9: 'fixed c' }) }, 'Fix c')
	const fixD = commit({ 'd.py': lines({ 2: 'fixed d' }) }, 'Fix d')
	commit({ 'a.py': lines({ 5: 'fixed a', 20: 'later on main' }) }, 'Unrelated')
	const mainTip = git('rev-parse', 'HEAD')

	git('checkout', '-q', 'release')
	const base = git('rev-parse', 'HEAD')
	git('cherry-pick', '-x', fixA) // same patch, names it
	const pickedA = git('rev-parse', 'HEAD')
	git('cherry-pick', '-x', fixB) // names it, then changed while backporting: the old API on this branch
	writeFileSync(join(dir, 'b.py'), lines({ 5: 'fixed b', 6: 'uses old_api()' }))
	git('commit', '-qa', '--amend', '--no-edit')
	const pickedB = git('rev-parse', 'HEAD')
	const sameSubject = commit({ 'c.py': lines({ 9: 'fixed c differently' }) }, 'Fix c') // no -x, one commit on main has its subject
	const samePatch = commit({ 'd.py': lines({ 2: 'fixed d' }) }, 'Backport the d fix') // no -x, other subject, same patch
	const fresh = commit({ 'e.py': 'only here\n' }, 'Release notes')
	const head = git('rev-parse', 'HEAD')

	const r = await findOriginals(dir, { base, head, mainTip, mainLabel: 'main' })
	assert.equal(r.error, null)
	assert.deepEqual(
		r.commits.map((c) => [c.sha, c.state, c.original, c.via]),
		[
			[pickedA, 'same', fixA, 'cherry-pick'],
			[pickedB, 'differs', fixB, 'cherry-pick'],
			[sameSubject, 'differs', fixC, 'subject'],
			[samePatch, 'same', fixD, 'patch'],
			[fresh, 'none', null, null],
		],
	)
	// The diff of the diff shows what the backport changed: the line that uses the old API instead.
	const b = r.commits[1].diff
	assert.ok(b.includes('-+uses new_api()'), b.join('\n'))
	assert.ok(b.includes('++uses old_api()'), b.join('\n'))
	assert.deepEqual(r.commits[0].diff, [])
})

test('from Git: a subject that several commits on main share names no original', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'review-backports-'))
	const git = (...a: Array<string>): string =>
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
			cwd: dir,
			encoding: 'utf8',
		}).trim()
	const commit = (file: string, text: string, msg: string): string => {
		writeFileSync(join(dir, file), text)
		git('add', '-A')
		git('commit', '-qm', msg)
		return git('rev-parse', 'HEAD')
	}
	git('init', '-q', '-b', 'main')
	commit('a.txt', 'a\n', 'base')
	git('branch', 'release')
	commit('a.txt', 'b\n', 'Fix typo')
	commit('a.txt', 'c\n', 'Fix typo')
	const mainTip = git('rev-parse', 'HEAD')
	git('checkout', '-q', 'release')
	const base = git('rev-parse', 'HEAD')
	commit('a.txt', 'd\n', 'Fix typo')
	const head = git('rev-parse', 'HEAD')
	const r = await findOriginals(dir, { base, head, mainTip, mainLabel: 'main' })
	assert.deepEqual(
		r.commits.map((c) => c.state),
		['none'],
	)
})
