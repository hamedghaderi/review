import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { foldFixups } from '../src/main/fixupFold.ts'
import { listCommits } from '../src/main/git.ts'
import { foldedMessage, planFixups } from '../src/shared/fixups.ts'

const c = (sha: string, subject: string) => ({ sha: sha.padEnd(40, '0'), subject })

test('fixups fold into the commit they name, by git’s autosquash rule', () => {
	const into = planFixups([
		c('a1', 'parser: parse sections'), // 0
		c('b2c4', 'cli: add flag'), // 1
		c('c3', 'fixup! parser: parse sections'), // 2 → 0, whole subject
		c('d4', 'fixup! fixup! parser: parse sections'), // 3 → 0, prefixes stripped
		c('e5', 'squash! b2c4'), // 4 → 1, a commit id
		c('f6', 'fixup! cli'), // 5 → 1, the start of a subject
		c('a7', 'parser: parse sections'), // 6, same subject as 0
		c('b8', 'fixup! parser: parse sections'), // 7 → 0: the oldest with that subject wins
		c('c9', 'fixup! nothing like it'), // 8: no match
		c('d0', 'amend! later one'), // 9: names a later commit, so nothing
		c('e1', 'later one'), // 10
	])
	assert.deepEqual(
		[...into].sort(([a], [b]) => a - b),
		[
			[2, 0],
			[3, 0],
			[4, 1],
			[5, 1],
			[7, 0],
		],
	)
})

test('the folded message: fixup keeps it, squash adds its body, amend replaces it', () => {
	assert.equal(foldedMessage('parser\n\nwhy', [{ message: 'fixup! parser\n' }]), 'parser\n\nwhy')
	assert.equal(foldedMessage('parser\n\nwhy', [{ message: 'squash! parser\n\nand tests' }]), 'parser\n\nwhy\n\nand tests')
	assert.equal(
		foldedMessage('parser\n\nwhy', [{ message: 'amend! parser\n\nparser: sections\n\nbetter why' }]),
		'parser: sections\n\nbetter why',
	)
})

test('from Git: a fixup folds into its commit’s step; one that clashes with a commit in between stays on its own', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'review-fixups-'))
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
	const base = commit({ 'p.py': lines({}), 'q.py': lines({}) }, 'base')
	const parser = commit({ 'p.py': lines({ 3: 'parse(sectoins)' }) }, 'parser: parse sections')
	const cli = commit({ 'q.py': lines({ 20: 'flag = 1' }) }, 'cli: add flag')
	const tidy = commit({ 'q.py': lines({ 20: 'flag = 1', 25: 'tidy' }) }, 'cli: tidy')
	const fix = commit({ 'p.py': lines({ 3: 'parse(sections)' }) }, 'fixup! parser: parse sections')
	// This one fixes a line the commit in between wrote, not the commit it names: it can't be folded there.
	const clash = commit({ 'q.py': lines({ 20: 'flag = 1', 25: 'tidy!' }) }, 'fixup! cli: add flag')
	const head = git('rev-parse', 'HEAD')

	const { commits } = await listCommits(dir, base, head, 100)
	const r = await foldFixups(dir, commits)
	assert.equal(r.folded, 1)
	assert.deepEqual(
		r.steps.map((s) => [s.subject, s.folded?.original ?? null, s.unfolded?.target ?? null]),
		[
			['parser: parse sections', parser, null],
			['cli: add flag', null, null],
			['cli: tidy', null, null],
			['fixup! cli: add flag', null, cli],
		],
	)
	const step = r.steps[0]
	assert.notEqual(step.sha, parser)
	assert.equal(step.parent, base)
	assert.deepEqual(step.folded?.fixups, [{ sha: fix, subject: 'fixup! parser: parse sections' }])
	// The step shows the commit in its final form: the typo fixed, nothing else.
	const diff = git('diff', '--unified=0', step.parent, step.sha)
	assert.match(diff, /^\+parse\(sections\)$/m)
	assert.doesNotMatch(diff, /sectoins|q\.py/)
	assert.match(r.steps[3].unfolded?.why ?? '', /changes lines a commit in between wrote, in q\.py/)
	assert.equal(clash, head)
	assert.equal(tidy.length, 40)

	// The same commits give the same stand-in, so seen marks and saved commit reviews stay put.
	const again = await foldFixups(dir, commits)
	assert.equal(again.steps[0].sha, step.sha)
})
