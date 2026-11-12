import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createReviewTools, shownLines } from '../src/main/ai/lookup.ts'
import { commitsSince } from '../src/main/git.ts'

test('what landed on the base branch since the branch point: merged PRs count once, and only commits touching the files are listed', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'review-drift-'))
	const git = (...a: Array<string>): string =>
		execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=a@a', '-c', 'commit.gpgsign=false', ...a], {
			cwd: dir,
			encoding: 'utf8',
		}).trim()
	const commit = (file: string, text: string, message: string): string => {
		writeFileSync(join(dir, file), text)
		git('add', '-A')
		git('commit', '-qm', message)
		return git('rev-parse', 'HEAD')
	}
	git('init', '-q', '-b', 'main')
	commit('dates.ts', 'export function parseDate() {}\n', 'base')
	commit('other.ts', 'x\n', 'other')
	const branchPoint = git('rev-parse', 'HEAD')
	// The pull request changes dates.ts; main moves on meanwhile.
	commit('readme.md', 'docs\n', 'Unrelated docs')
	commit('dates.ts', 'export function parseDay() {}\n', 'Rename parseDate to parseDay')
	git('checkout', '-qb', 'feature')
	commit('dates.ts', 'export function parseDay() {}\nexport const x = 1\n', 'Feature work')
	commit('other.ts', 'y\n', 'More feature work')
	git('checkout', '-q', 'main')
	git('-c', 'user.name=Ann', 'merge', '-q', '--no-ff', 'feature', '-m', 'Merge pull request #9')
	const tip = git('rev-parse', 'HEAD')

	const r = await commitsSince(dir, branchPoint, tip, ['dates.ts'], 10)
	assert.ok(r)
	assert.equal(r.behind, 3, 'docs, the rename and the merge: the merged branch counts once')
	assert.equal(r.touching, 2)
	assert.deepEqual(
		r.commits.map((c) => [c.subject, c.files, c.author]),
		[
			['Merge pull request #9', ['dates.ts'], 'Ann'],
			['Rename parseDate to parseDay', ['dates.ts'], 'Ann'],
		],
	)
	assert.equal((await commitsSince(dir, branchPoint, tip, ['dates.ts'], 1))!.commits.length, 1, 'newest first, up to the limit')
	assert.deepEqual(await commitsSince(dir, tip, tip, ['dates.ts'], 10), { behind: 0, touching: 0, commits: [] }, 'up to date')
	assert.equal(await commitsSince(dir, branchPoint, 'f'.repeat(40), ['dates.ts'], 10), null, 'the history is not in this clone')
})

test('lookups read the base branch as it is now with version "tip", and say so when there is none', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'review-tip-'))
	const git = (...a: Array<string>): string =>
		execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=a@a', '-c', 'commit.gpgsign=false', ...a], {
			cwd: dir,
			encoding: 'utf8',
		}).trim()
	git('init', '-q', '-b', 'main')
	writeFileSync(join(dir, 'dates.ts'), 'export function parseDate() {}\n')
	git('add', '-A')
	git('commit', '-qm', 'base')
	const base = git('rev-parse', 'HEAD')
	writeFileSync(join(dir, 'dates.ts'), 'export function parseDay() {}\n')
	git('commit', '-qam', 'rename')
	const tip = git('rev-parse', 'HEAD')
	const budget = { maxCalls: 5, maxChars: 10_000 }
	const read = { path: 'dates.ts', version: 'tip', start_line: null, end_line: null }
	const withTip = createReviewTools({ root: dir, baseSha: base, headSha: base, tipSha: tip }, budget)
	const r = await withTip.call('read_file', read, new AbortController().signal)
	assert.equal(r.error, false)
	assert.match(r.text, /^dates\.ts \(tip\), lines 1-1 of 1:\n1 \| export function parseDay\(\) \{\}/)
	assert.deepEqual(shownLines('read_file', r.text), [{ path: 'dates.ts', version: 'tip', start: 1, end: 1 }])
	const without = createReviewTools({ root: dir, baseSha: base, headSha: base }, budget)
	const none = await without.call('read_file', read, new AbortController().signal)
	assert.equal(none.error, true)
	assert.match(none.text, /There is no base branch tip for this review/)
})
