import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ReviewService } from '../src/main/service.ts'
import { ReviewStore } from '../src/main/store.ts'
import { reviewTarget } from '../src/main/validate.ts'
import { commitSpec } from '../src/shared/commitSpec.ts'
import { commitsLabel, targetKey } from '../src/shared/types.ts'

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'review-commits-'))
}

/** main: base, then m1 (m.txt). topic from base: t1 (a.txt), t2 (b.txt), t3 (a.txt again). */
async function world() {
	const dir = tmp()
	const run = (...a: Array<string>): string =>
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
			cwd: dir,
			encoding: 'utf8',
		}).trim()
	const commit = (files: Record<string, string>, msg: string): string => {
		for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text)
		run('add', '-A')
		run('commit', '-qm', msg)
		return run('rev-parse', 'HEAD')
	}
	run('init', '-q', '-b', 'main')
	const base = commit({ 'a.txt': 'a\n', 'b.txt': 'b\n' }, 'base')
	run('checkout', '-qb', 'topic')
	const t1 = commit({ 'a.txt': 'a1\n' }, 't1')
	const t2 = commit({ 'b.txt': 'b2\n' }, 't2')
	const t3 = commit({ 'a.txt': 'a3\n' }, 't3')
	run('checkout', '-q', 'main')
	const m1 = commit({ 'm.txt': 'm\n' }, 'm1')
	const store = ReviewStore.in(tmp())
	await store.load()
	const svc = new ReviewService(store, null)
	const s = await svc.open(dir)
	return { svc, repoId: s.repo.id, base, t1, t2, t3, m1 }
}

const files = (c: { files: Array<{ key: string }> }) => c.files.map((f) => f.key).sort()

test('commits: one commit, a range, and from the merge base, pinned to the SHAs they resolved to', async () => {
	const w = await world()
	const open = (from: string, to: string, mergeBase = false) =>
		w.svc.loadComparison(w.repoId, { kind: 'target', target: { kind: 'commits', from, to, mergeBase } })

	const one = await open(`${w.t2}^`, w.t2)
	assert.deepEqual(files(one.comparison), ['b.txt'], 'only what t2 changed')
	assert.deepEqual(one.comparison.target, { kind: 'commits', from: w.t1, to: w.t2, mergeBase: false }, 'stored as SHAs')
	assert.equal(one.comparison.baseSha, w.t1)
	assert.equal(one.comparison.headRef, null)

	const range = await open('topic~2', 'topic')
	assert.deepEqual(files(range.comparison), ['a.txt', 'b.txt'], 't2 and t3')
	assert.equal(range.comparison.baseSha, w.t1)

	// main..topic would include undoing m1; from the merge base it is only topic's own changes.
	const plain = await open('main', 'topic')
	assert.deepEqual(files(plain.comparison), ['a.txt', 'b.txt', 'm.txt'])
	const merged = await open('main', 'topic', true)
	assert.deepEqual(files(merged.comparison), ['a.txt', 'b.txt'])
	assert.equal(merged.comparison.baseSha, w.base)
	assert.equal(merged.comparison.baseTipSha, w.m1)

	// Reopening it later is the same pinned review, and there is never an update to take.
	const again = await w.svc.loadComparison(w.repoId, { kind: 'snapshot', reviewId: range.comparison.id })
	assert.equal(again.comparison.id, range.comparison.id)
	const probe = await w.svc.probeTarget(w.repoId, range.comparison.id)
	assert.deepEqual([probe.changed, probe.error], [false, null])
})

test('commits: a first commit or a name that is not a commit says so', async () => {
	const w = await world()
	const open = (from: string, to: string) =>
		w.svc.loadComparison(w.repoId, { kind: 'target', target: { kind: 'commits', from, to, mergeBase: false } })
	await assert.rejects(open(`${w.base}^`, w.base), /has no parent commit/)
	await assert.rejects(open('nope', 'topic'), /nope is not a commit/)
	await assert.rejects(open('main', 'nope'), /nope is not a commit/)
})

test('commit specs as typed in Quick open, and what the main process accepts', () => {
	assert.deepEqual(commitSpec('a1b2c3d'), { kind: 'commits', from: 'a1b2c3d^', to: 'a1b2c3d', mergeBase: false })
	assert.deepEqual(commitSpec('main..topic'), { kind: 'commits', from: 'main', to: 'topic', mergeBase: false })
	assert.deepEqual(commitSpec('main...topic'), { kind: 'commits', from: 'main', to: 'topic', mergeBase: true })
	assert.deepEqual(commitSpec('HEAD~3..'), { kind: 'commits', from: 'HEAD~3', to: 'HEAD', mergeBase: false })
	assert.equal(commitSpec('defaced'), null, 'a hex word without a digit is a search')
	assert.equal(commitSpec('fix login'), null)
	assert.equal(commitSpec('a..b..c'), null)
	assert.equal(commitSpec('-x..main'), null)

	const ok = reviewTarget({ kind: 'commits', from: 'HEAD~2', to: 'topic', mergeBase: true })
	assert.deepEqual(ok, { kind: 'commits', from: 'HEAD~2', to: 'topic', mergeBase: true })
	for (const from of ['--output=x', 'HEAD:secret.txt', 'a b', ''])
		assert.throws(() => reviewTarget({ kind: 'commits', from, to: 'HEAD', mergeBase: false }), undefined, from)

	const t = { kind: 'commits' as const, from: 'a'.repeat(40), to: 'b'.repeat(40), mergeBase: true }
	assert.equal(commitsLabel(t), 'aaaaaaa...bbbbbbb')
	assert.notEqual(targetKey(t), targetKey({ ...t, mergeBase: false }))
})
