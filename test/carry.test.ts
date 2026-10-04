import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ReviewService } from '../src/main/service.ts'
import { ReviewStore } from '../src/main/store.ts'
import type { Anchor, Review, ReviewComment } from '../src/shared/types.ts'

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'review-carry-'))
}

function lines(n: number, edit: Record<number, string> = {}, top: Array<string> = []): string {
	return [...top, ...Array.from({ length: n }, (_, i) => edit[i + 1] ?? `l${i + 1}`)].join('\n') + '\n'
}

/** main: f.txt (10 lines), g.txt. topic v1 edits f.txt line 5 and g.txt line 1. */
function world() {
	const dir = tmp()
	const run = (...a: Array<string>): string =>
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
			cwd: dir,
			encoding: 'utf8',
		}).trim()
	const commit = (files: Record<string, string | null>, msg: string): string => {
		for (const [f, text] of Object.entries(files)) {
			if (text === null) rmSync(join(dir, f))
			else writeFileSync(join(dir, f), text)
		}
		run('add', '-A')
		run('commit', '-qm', msg)
		return run('rev-parse', 'HEAD')
	}
	run('init', '-q', '-b', 'main')
	commit({ 'f.txt': lines(10), 'g.txt': 'g1\ng2\n' }, 'base')
	run('checkout', '-qb', 'topic')
	commit({ 'f.txt': lines(10, { 5: 'L5' }), 'g.txt': 'G1\ng2\n' }, 'v1')
	run('checkout', '-q', 'main')
	return { dir, run, commit }
}

const target = { kind: 'branch' as const, headRef: 'refs/heads/topic', baseRef: 'refs/heads/main' }

function comment(review: Review, id: string, a: Partial<Anchor>): ReviewComment {
	const t = new Date().toISOString()
	return {
		id,
		anchor: {
			repoId: review.repoId,
			baseSha: review.baseSha,
			headSha: review.headSha,
			fileKey: 'f.txt',
			oldPath: 'f.txt',
			newPath: 'f.txt',
			side: 'new',
			startLine: 1,
			endLine: 1,
			excerpt: '',
			...a,
		},
		body: `comment ${id}`,
		createdAt: t,
		updatedAt: t,
		findingId: null,
	}
}

test('comments carry forward to a newer snapshot: moved when unchanged, outdated with the old code when changed', async () => {
	const w = world()
	const store = ReviewStore.in(tmp())
	await store.load()
	const svc = new ReviewService(store, null)
	const s = await svc.open(w.dir)
	const v1 = await svc.loadComparison(s.repo.id, { kind: 'target', target })
	const r1 = v1.review
	await svc.saveReview({
		...r1,
		comments: [
			comment(r1, 'shift', { startLine: 7, endLine: 8, excerpt: 'l7\nl8' }),
			comment(r1, 'changed', { startLine: 5, endLine: 5, excerpt: 'L5' }),
			comment(r1, 'deleted-line', { side: 'old', startLine: 5, endLine: 5, excerpt: 'l5' }),
			comment(r1, 'file', { side: null, startLine: null, endLine: null }),
			comment(r1, 'renamed', { fileKey: 'g.txt', oldPath: 'g.txt', newPath: 'g.txt', startLine: 2, endLine: 2 }),
		],
	})

	// v2: two lines inserted at the top, line 5 rewritten, g.txt renamed to h.txt unchanged.
	w.run('checkout', '-q', 'topic')
	w.commit({ 'f.txt': lines(10, { 5: 'L5 again' }, ['n1', 'n2']), 'g.txt': null, 'h.txt': 'G1\ng2\n' }, 'v2')
	w.run('checkout', '-q', 'main')

	const probe = await svc.probeTarget(s.repo.id, r1.id)
	assert.equal(probe.changed, true)
	const v2 = await svc.loadComparison(s.repo.id, { kind: 'target', target, from: r1.id })
	assert.notEqual(v2.comparison.id, r1.id)
	assert.match(v2.notice ?? '', /Carried 5 comments/)
	assert.match(v2.notice ?? '', /1 is outdated/)
	const by = new Map(v2.review.comments.map((c) => [c.carried!.commentId, c]))
	assert.equal(by.size, 5)
	for (const c of v2.review.comments) {
		assert.equal(c.anchor.headSha, v2.comparison.headSha, 'anchors belong to the new snapshot')
		assert.notEqual(c.id, c.carried!.commentId, 'a new comment, not the old one')
	}

	const shift = by.get('shift')!
	assert.deepEqual([shift.anchor.side, shift.anchor.startLine, shift.anchor.endLine], ['new', 9, 10])
	assert.equal(shift.carried!.outdated, null)
	assert.equal(shift.body, 'comment shift')

	const changed = by.get('changed')!
	assert.equal(changed.anchor.side, null, 'outdated comments sit at file level')
	assert.equal(changed.anchor.fileKey, 'f.txt')
	assert.equal(changed.carried!.outdated?.reason, 'The commented lines changed.')
	assert.deepEqual(changed.carried!.outdated?.code, ['L5'], 'keeps the code it was written on')
	assert.deepEqual([changed.carried!.anchor.startLine, changed.carried!.anchor.headSha], [5, r1.headSha])

	const del = by.get('deleted-line')!
	assert.deepEqual([del.anchor.side, del.anchor.startLine], ['old', 5], 'base unchanged, so the old side keeps its line')

	assert.deepEqual([by.get('file')!.anchor.side, by.get('file')!.carried!.outdated], [null, null])

	const renamed = by.get('renamed')!
	assert.deepEqual([renamed.anchor.fileKey, renamed.anchor.newPath, renamed.anchor.startLine], ['h.txt', 'h.txt', 2], 'follows the rename')
	assert.equal(renamed.carried!.outdated, null)

	// The earlier snapshot is left as it was.
	const old = await svc.loadComparison(s.repo.id, { kind: 'snapshot', reviewId: r1.id })
	assert.equal(old.review.comments.length, 5)
	assert.ok(old.review.comments.every((c) => !c.carried && c.anchor.headSha === r1.headSha))

	// Carrying again from the same snapshot adds nothing, even after a carried comment was deleted.
	await svc.saveReview({ ...v2.review, comments: v2.review.comments.filter((c) => c.carried!.commentId !== 'file') })
	const again = await svc.loadComparison(s.repo.id, { kind: 'target', target, from: r1.id })
	assert.equal(again.review.comments.length, 4)
	assert.equal(again.notice, null)

	// The renderer can keep but not rewrite where a comment came from.
	const forged = again.review.comments.map((c) => ({ ...c, carried: { ...c.carried!, published: { url: 'https://example.com' } } }))
	await svc.saveReview({ ...again.review, comments: forged })
	const stored = store.read().repos[s.repo.id].reviews[again.review.id]
	assert.ok(stored.comments.every((c) => c.carried && c.carried.published === null))

	// v3, opened without naming a source: the latest snapshot of the same target is used, and an outdated comment
	// stays outdated with its original code and lines.
	w.run('checkout', '-q', 'topic')
	w.commit({ 'z.txt': 'z\n' }, 'v3')
	w.run('checkout', '-q', 'main')
	const v3 = await svc.loadComparison(s.repo.id, { kind: 'target', target })
	const by3 = new Map(v3.review.comments.map((c) => [c.carried!.originId, c]))
	assert.equal(by3.size, 4)
	assert.equal(by3.get('changed')!.carried!.reviewId, again.review.id)
	assert.deepEqual(by3.get('changed')!.carried!.outdated?.code, ['L5'])
	assert.equal(by3.get('changed')!.carried!.anchor.headSha, r1.headSha)
	assert.equal(by3.get('shift')!.anchor.startLine, 9)
})

test('a comment whose file drops out of the change is outdated but kept', async () => {
	const w = world()
	const store = ReviewStore.in(tmp())
	await store.load()
	const svc = new ReviewService(store, null)
	const s = await svc.open(w.dir)
	const v1 = await svc.loadComparison(s.repo.id, { kind: 'target', target })
	await svc.saveReview({
		...v1.review,
		comments: [comment(v1.review, 'g', { fileKey: 'g.txt', oldPath: 'g.txt', newPath: 'g.txt', startLine: 2, endLine: 2 })],
	})
	w.run('checkout', '-q', 'topic')
	w.commit({ 'g.txt': 'g1\ng2\n' }, 'revert g') // g.txt is back to the base version
	w.run('checkout', '-q', 'main')
	const v2 = await svc.loadComparison(s.repo.id, { kind: 'target', target, from: v1.review.id })
	assert.ok(!v2.comparison.files.some((f) => f.key === 'g.txt'))
	const [c] = v2.review.comments
	assert.equal(c.carried!.outdated?.reason, 'The file is no longer part of the changes.')
	assert.deepEqual(c.carried!.outdated?.code, ['g2'])
})
