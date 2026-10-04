import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { compareBranches, compareSnapshot, countStatusEntries, findRoot, readPatch, readRepo } from '../src/main/git.ts'
import { parsePatch, pickSection } from '../src/main/patch.ts'
import { ReviewStore } from '../src/main/store.ts'
import { buildRows, computeGaps, linesToReveal, normalizeSpan } from '../src/renderer/src/diffModel.ts'
import { buildTree, flatten } from '../src/renderer/src/tree.ts'
import type { Hunk } from '../src/shared/types.ts'

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'review-test-'))
}

function repo(): { dir: string; run: (...a: Array<string>) => string } {
	const dir = tmp()
	const run = (...a: Array<string>): string =>
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' })
	run('init', '-q', '-b', 'main')
	return { dir, run }
}

test('parsePatch tracks old/new numbers, no-newline markers and header-looking content', () => {
	const text = [
		'diff --git a/f b/f',
		'index 1..2 100644',
		'--- a/f',
		'+++ b/f',
		'@@ -1,3 +1,3 @@ fn',
		' a',
		'--- not a header',
		'+++ also not a header',
		' c',
		'\\ No newline at end of file',
		'',
	].join('\n')
	const [s] = parsePatch(text)
	const h = s.hunks[0]
	assert.equal(h.section, 'fn')
	assert.deepEqual(
		h.lines.map((l) => [l.kind, l.oldNo, l.newNo, l.text]),
		[
			['ctx', 1, 1, 'a'],
			['del', 2, null, '-- not a header'],
			['add', null, 2, '++ also not a header'],
			['ctx', 3, 3, 'c'],
		],
	)
	assert.equal(h.lines[3].noNewline, true)
})

test('gaps, expansion and text-selection normalisation use source line numbers', () => {
	const hunks: Array<Hunk> = [
		{
			oldStart: 5,
			oldCount: 2,
			newStart: 5,
			newCount: 3,
			section: '',
			lines: [
				{ kind: 'ctx', oldNo: 5, newNo: 5, text: 'e' },
				{ kind: 'del', oldNo: 6, newNo: null, text: 'f' },
				{ kind: 'add', oldNo: null, newNo: 6, text: 'F' },
				{ kind: 'add', oldNo: null, newNo: 7, text: 'G' },
			],
		},
	]
	const file = ['a', 'b', 'c', 'd', 'e', 'F', 'G', 'h', 'i']
	const gaps = computeGaps(hunks, file.length)
	assert.deepEqual(gaps, [
		{ from: 1, to: 4, offset: 0 },
		{ from: 8, to: 9, offset: -1 },
	])
	const { rows, blocks } = buildRows(hunks, gaps, new Set([8]), file)
	const ctx = rows.find((r) => r.t === 'line' && r.line.newNo === 8)
	assert.ok(ctx && ctx.t === 'line' && ctx.line.oldNo === 7 && ctx.line.text === 'h')
	assert.equal(blocks.length, 1)
	const at = (kind: string, n: number): number =>
		rows.findIndex((r) => r.t === 'line' && r.line.kind === kind && (r.line.newNo === n || r.line.oldNo === n))
	assert.deepEqual(normalizeSpan(rows, at('del', 6), at('del', 6)), { side: 'old', start: 6, end: 6 })
	assert.deepEqual(normalizeSpan(rows, at('ctx', 5), at('add', 7)), { side: 'new', start: 5, end: 7 })
	assert.deepEqual(normalizeSpan(rows, at('del', 6), at('add', 7)), { side: 'old', start: 6, end: 6 })
	assert.deepEqual(linesToReveal(gaps, { side: 'old', start: 8, end: 8 }, 9), [9])
})

test('file tree compacts single-child folders and keeps every file', () => {
	const f = (p: string) => ({
		key: p,
		status: 'modified' as const,
		oldPath: p,
		newPath: p,
		additions: 1,
		deletions: 0,
		binary: false,
		similarity: null,
	})
	const files = Array.from({ length: 1500 }, (_, i) => f(`src/deep/nested/m${i}.ts`)).concat(f('README.md'))
	const tree = buildTree(files)
	assert.equal(tree.dirs[0].name, 'src/deep/nested')
	assert.equal(flatten(tree).length, 1501)
})

test('git comparison pins merge base, handles renames, binaries, deletions and unrelated histories', async () => {
	const { dir, run } = repo()
	writeFileSync(join(dir, 'keep.txt'), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
	writeFileSync(join(dir, 'old name.txt'), 'rename me\nsecond\nthird\n')
	writeFileSync(join(dir, 'gone.txt'), 'bye\n')
	run('add', '.')
	run('commit', '-qm', 'base')
	run('checkout', '-qb', 'feature')
	writeFileSync(join(dir, 'keep.txt'), Array.from({ length: 50 }, (_, i) => (i === 24 ? 'CHANGED' : `line ${i + 1}`)).join('\n') + '\n')
	run('mv', 'old name.txt', 'new name.txt')
	run('rm', '-q', 'gone.txt')
	writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 255]))
	writeFileSync(join(dir, '$(touch pwned).txt'), 'x\n')
	run('add', '-A')
	run('commit', '-qm', 'feature')
	run('checkout', '-q', 'main')
	writeFileSync(join(dir, 'main-only.txt'), 'later\n')
	run('add', '.')
	run('commit', '-qm', 'main moves on')
	run('checkout', '-q', 'feature')
	writeFileSync(join(dir, 'dirty.txt'), 'uncommitted\n')

	const root = await findRoot(join(dir))
	const info = await readRepo(root)
	assert.equal(info.branch, 'feature')
	assert.equal(info.defaultBase, 'refs/heads/main')
	assert.equal(info.uncommitted, 1)

	const data = await compareBranches(info, 'HEAD', 'refs/heads/main')
	const c = data.comparison
	assert.equal(c.baseSha, run('merge-base', 'main', 'feature').trim())
	assert.notEqual(c.baseSha, c.baseTipSha)
	const by = Object.fromEntries(c.files.map((f) => [f.key, f]))
	assert.deepEqual(Object.keys(by).sort(), ['$(touch pwned).txt', 'bin.dat', 'gone.txt', 'keep.txt', 'new name.txt'])
	assert.equal(by['new name.txt'].status, 'renamed')
	assert.equal(by['new name.txt'].oldPath, 'old name.txt')
	assert.equal(by['gone.txt'].status, 'deleted')
	assert.equal(by['gone.txt'].newPath, null)
	assert.equal(by['bin.dat'].binary, true)
	assert.equal(by['keep.txt'].additions, 1)
	assert.ok(!readdirSync(dir).includes('pwned'))

	const keep = pickSection(parsePatch((await readPatch(data, by['keep.txt'], 1e6)).text), 'modified')!
	const added = keep.hunks[0].lines.find((l) => l.kind === 'add')!
	assert.deepEqual([added.newNo, added.text], [25, 'CHANGED'])
	const gone = pickSection(parsePatch((await readPatch(data, by['gone.txt'], 1e6)).text), 'deleted')!
	assert.deepEqual(
		gone.hunks[0].lines.map((l) => [l.kind, l.oldNo]),
		[['del', 1]],
	)
	const bin = pickSection(parsePatch((await readPatch(data, by['bin.dat'], 1e6)).text), 'added')!
	assert.equal(bin.binary, true)
	assert.equal((await readPatch(data, by['keep.txt'], 10)).truncated, true)

	// Moving HEAD leaves the old snapshot reproducible from its pinned SHAs.
	run('commit', '-q', '--allow-empty', '-m', 'more')
	const again = await compareSnapshot(root, c)
	assert.equal(again.comparison.id, c.id)
	const latest = await compareBranches(await readRepo(root), 'HEAD', 'refs/heads/main')
	assert.notEqual(latest.comparison.id, c.id)

	run('checkout', '-q', '--orphan', 'other')
	run('commit', '-q', '--allow-empty', '-m', 'unrelated')
	await assert.rejects(compareBranches(await readRepo(root), 'HEAD', 'refs/heads/main'), { code: 'unrelated-histories' })
})

test('repository error states', async () => {
	await assert.rejects(findRoot(tmp()), { code: 'not-a-repo' })
	const { dir } = repo()
	const info = await readRepo(await findRoot(dir))
	assert.equal(info.headSha, null)
	assert.equal(countStatusEntries('R  new\0old\0?? x\0'), 2)
})

test('store serialises writes, replaces atomically and survives reload', async () => {
	const dir = tmp()
	const a = ReviewStore.in(dir)
	await a.load()
	await Promise.all(
		Array.from({ length: 20 }, (_, i) =>
			a.update((d) => {
				d.lastRepoId = `r${i}`
				d.repos[`r${i}`] = { repoId: `r${i}`, root: '/', selectedBase: null, activeReviewId: null, reviews: {}, aiRuns: {} }
			}),
		),
	)
	const b = ReviewStore.in(dir)
	await b.load()
	assert.equal(Object.keys(b.read().repos).length, 20)
	assert.equal(b.read().lastRepoId, 'r19')
	assert.deepEqual(readdirSync(dir), ['review-store.json'])
	writeFileSync(join(dir, 'review-store.json'), '{broken')
	const c = ReviewStore.in(dir)
	await c.load()
	assert.equal(c.read().lastRepoId, null)
	assert.ok(readdirSync(dir).some((f) => f.startsWith('review-store.json.unreadable-')))
	assert.equal(
		readFileSync(
			join(
				dir,
				readdirSync(dir).find((f) => f.includes('unreadable'))!,
			),
			'utf8',
		),
		'{broken',
	)
})
