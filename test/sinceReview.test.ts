import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { looksSquashed, parseRangeDiff, rangeSummary, type RangeCommit } from '../src/shared/rangeDiff.ts'
import { lineUpCommits } from '../src/main/sinceReview.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const D = 'd'.repeat(40)
const NONE = '-'.repeat(40)

test('range-diff output: each commit with its state, and a changed one with its diff of the diff', () => {
	const text = [
		`1:  ${A} = 1:  ${B} Spell out numbers`,
		`2:  ${C} ! 2:  ${D} Add b`,
		'    @@ a.txt',
		'     -7',
		'    -+six',
		'    ++SIX',
		'     +seven',
		'',
		`3:  ${A} < -:  ${NONE} Drop me`,
		`-:  ${NONE} > 3:  ${B} Brand new: with a colon = and signs`,
		'',
	].join('\n')
	const commits = parseRangeDiff(text)
	assert.deepEqual(
		commits.map((c) => [c.state, c.old, c.new, c.subject]),
		[
			['same', A, B, 'Spell out numbers'],
			['changed', C, D, 'Add b'],
			['dropped', A, null, 'Drop me'],
			['new', null, B, 'Brand new: with a colon = and signs'],
		],
	)
	assert.deepEqual(commits[1].diff, ['@@ a.txt', ' -7', '-+six', '++SIX', ' +seven'])
	assert.equal(rangeSummary(commits), '1 changed, 1 new, 1 dropped, 1 unchanged')
})

test('squashed: several commits became one, or nothing pairs up; a plain rebase is not', () => {
	const c = (state: RangeCommit['state']): RangeCommit => ({
		state,
		old: state === 'new' ? null : A,
		new: state === 'dropped' ? null : B,
		subject: 's',
		diff: [],
	})
	assert.equal(looksSquashed([c('dropped'), c('dropped'), c('changed')]), true) // three into one
	assert.equal(looksSquashed([c('dropped'), c('new')]), true) // nothing pairs
	assert.equal(looksSquashed([c('same'), c('changed'), c('new')]), false)
	assert.equal(looksSquashed([c('dropped')]), false) // nothing left to compare with
	assert.equal(looksSquashed([]), false)
})

/** main: base. topic: "Spell out numbers" (a.txt), "Add b" (b.txt). Reviewed there; then main moves on. */
function world() {
	const dir = mkdtempSync(join(tmpdir(), 'review-since-'))
	const git = (...a: Array<string>): string =>
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
			cwd: dir,
			encoding: 'utf8',
		}).trim()
	const nums = (edit: Record<number, string> = {}) => Array.from({ length: 30 }, (_, i) => edit[i + 1] ?? String(i + 1)).join('\n') + '\n'
	const commit = (files: Record<string, string>, msg: string): string => {
		for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text)
		git('add', '-A')
		git('commit', '-qm', msg)
		return git('rev-parse', 'HEAD')
	}
	git('init', '-q', '-b', 'main')
	commit({ 'a.txt': nums() }, 'base')
	git('checkout', '-qb', 'topic')
	commit({ 'a.txt': nums({ 5: 'five', 6: 'six', 7: 'seven', 8: 'eight' }) }, 'Spell out numbers')
	const reviewed = commit({ 'b.txt': Array.from({ length: 20 }, (_, i) => `b${i}`).join('\n') + '\n' }, 'Add b')
	git('checkout', '-q', 'main')
	commit({ 'm.txt': 'from main\n' }, 'Main moves on')
	return { dir, git, nums, commit, reviewed }
}

test('after a rebase, only what the author changed shows: base commits are on neither side', async () => {
	const w = world()
	// Rebased onto main, "Spell out numbers" edited, "Add b" kept, one commit added.
	w.git('checkout', '-q', '-B', 'topic', 'main')
	w.commit({ 'a.txt': w.nums({ 5: 'five', 6: 'SIX', 7: 'seven', 8: 'eight' }) }, 'Spell out numbers')
	w.commit({ 'b.txt': Array.from({ length: 20 }, (_, i) => `b${i}`).join('\n') + '\n' }, 'Add b')
	const head = w.commit({ 'c.txt': 'new\n' }, 'Add c')
	const base = w.git('merge-base', 'main', head)

	const r = await lineUpCommits(w.dir, { base, from: w.reviewed, head, baseLabel: 'main' })
	assert.equal(r.error, null)
	assert.equal(r.squashed, false)
	assert.deepEqual(
		r.commits.map((c) => [c.state, c.subject]),
		[
			['changed', 'Spell out numbers'],
			['same', 'Add b'],
			['new', 'Add c'],
		],
	)
	assert.ok(r.commits[0].diff.includes('-+six') && r.commits[0].diff.includes('++SIX'))
	assert.ok(!r.commits.some((c) => c.subject === 'Main moves on'))
})

test('squashed into one commit: the whole change before and after is lined up instead, base left out', async () => {
	const w = world()
	w.git('checkout', '-q', '-B', 'topic', 'main')
	w.commit(
		{
			'a.txt': w.nums({ 5: 'five', 6: 'SIX', 7: 'seven', 8: 'eight' }),
			'b.txt': Array.from({ length: 20 }, (_, i) => `b${i}`).join('\n') + '\n',
		},
		'Everything in one',
	)
	const head = w.git('rev-parse', 'HEAD')
	const base = w.git('merge-base', 'main', head)
	const objects = () => w.git('count-objects', '-v')

	const r = await lineUpCommits(w.dir, { base, from: w.reviewed, head, baseLabel: 'main' })
	assert.equal(r.error, null)
	assert.equal(r.squashed, true)
	assert.equal(r.commits.length, 1)
	assert.equal(r.commits[0].state, 'changed')
	const diff = r.commits[0].diff.join('\n')
	assert.match(diff, /-\+six\n\+\+SIX/)
	assert.doesNotMatch(diff, /from main/)

	// Looking again writes nothing new: the stand-in commits come out the same.
	const before = objects()
	await lineUpCommits(w.dir, { base, from: w.reviewed, head, baseLabel: 'main' })
	assert.equal(objects(), before)
})

test('a squash that changed nothing reads as the same change', async () => {
	const w = world()
	w.git('checkout', '-q', '-B', 'topic', 'main')
	w.commit(
		{
			'a.txt': w.nums({ 5: 'five', 6: 'six', 7: 'seven', 8: 'eight' }),
			'b.txt': Array.from({ length: 20 }, (_, i) => `b${i}`).join('\n') + '\n',
		},
		'Everything in one',
	)
	const head = w.git('rev-parse', 'HEAD')
	const r = await lineUpCommits(w.dir, { base: w.git('merge-base', 'main', head), from: w.reviewed, head, baseLabel: 'main' })
	assert.equal(r.squashed, true)
	assert.deepEqual(
		r.commits.map((c) => c.state),
		['same'],
	)
})
