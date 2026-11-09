import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ReviewService } from '../src/main/service.ts'
import { ReviewStore, migrate } from '../src/main/store.ts'
import { anchorToCommit, anchorToHead, invertShifts, lastReviewed, shiftRange, type CommitFileMap } from '../src/shared/commitStep.ts'
import type { Anchor, ChangedFile, Comparison } from '../src/shared/types.ts'

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'review-step-'))
}

const lines = (n: number, tag = ''): string => Array.from({ length: n }, (_, i) => `line ${i + 1}${tag}`).join('\n') + '\n'

/**
 * main: base (a.txt, gone.txt, same.txt). topic: c1 adds b.txt and edits a.txt; c2 inserts two lines at the top of
 * b.txt and rewrites its line 5; a merge of main; c3 deletes gone.txt; c4 changes same.txt and c5 changes it back.
 */
async function world(stepCommits: boolean) {
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
	commit({ 'a.txt': lines(10), 'gone.txt': 'g\n', 'same.txt': 's\n' }, 'base')
	run('checkout', '-qb', 'topic')
	const c1 = commit({ 'a.txt': lines(10).replace('line 3\n', 'line 3 edited\n'), 'b.txt': lines(10) }, 'c1: add b\n\nWhy b exists.')
	const c2 = commit({ 'b.txt': 'top 1\ntop 2\n' + lines(10).replace('line 5\n', 'line 5 changed\n') }, 'c2: tweak b')
	run('checkout', '-q', 'main')
	commit({ 'm.txt': 'm\n' }, 'm1')
	run('checkout', '-q', 'topic')
	run('merge', '-q', '--no-edit', 'main')
	const c3 = commit({ 'gone.txt': null }, 'c3: drop gone')
	const c4 = commit({ 'same.txt': 's changed\n' }, 'c4')
	const c5 = commit({ 'same.txt': 's\n' }, 'c5: revert c4')
	const store = ReviewStore.in(tmp())
	await store.load()
	if (stepCommits) await store.update((d) => void (d.stepCommits = true))
	const svc = new ReviewService(store, null)
	const s = await svc.open(dir)
	const loaded = await svc.loadComparison(s.repo.id, {
		kind: 'target',
		target: { kind: 'branch', headRef: 'refs/heads/topic', baseRef: 'refs/heads/main' },
	})
	return { svc, store, review: loaded.comparison, c1, c2, c3, c4, c5 }
}

test('commit stepping: refused while the setting is off, and the setting is off unless stored as on', async () => {
	const w = await world(false)
	await assert.rejects(w.svc.commitList(w.review.id), /Settings › Reviewing/)
	await assert.rejects(w.svc.openCommit(w.review.id, w.c1), /Settings › Reviewing/)
	assert.equal(migrate({ version: 2, repos: {}, lastRepoId: null }).stepCommits, undefined)
	assert.equal(migrate({ version: 2, repos: {}, lastRepoId: null, stepCommits: 'yes' }).stepCommits, undefined)
	assert.equal(migrate({ version: 2, repos: {}, lastRepoId: null, stepCommits: true }).stepCommits, true)
	assert.equal(migrate({ version: 2, repos: {}, lastRepoId: null }).offerWalk, undefined, 'the walkthrough offer is off too')
	assert.equal(migrate({ version: 2, repos: {}, lastRepoId: null, offerWalk: 1 }).offerWalk, undefined)
	assert.equal(migrate({ version: 2, repos: {}, lastRepoId: null, offerWalk: true }).offerWalk, true)
})

test('commit stepping: the review’s own commits, oldest first, without the merge', async () => {
	const w = await world(true)
	const list = await w.svc.commitList(w.review.id)
	assert.deepEqual(
		list.commits.map((c) => c.subject),
		['c1: add b', 'c2: tweak b', 'c3: drop gone', 'c4', 'c5: revert c4'],
	)
	assert.equal(list.total, 5)
	assert.equal(list.commits[1].parent, w.c1)

	const one = await w.svc.openCommit(w.review.id, w.c1)
	assert.equal(one.comparison.id, `${list.commits[0].parent}..${w.c1}`)
	assert.deepEqual(one.comparison.files.map((f) => f.key).sort(), ['a.txt', 'b.txt'])
	assert.equal(one.body, 'Why b exists.')
	// Its files read like any comparison's.
	const patch = await w.svc.loadPatch(one.comparison.id, 'b.txt', false)
	assert.equal(patch.kind, 'text')

	await assert.rejects(w.svc.openCommit(w.review.id, w.review.baseSha), /not one of this review’s commits/)
})

test('commit stepping: a commit’s file lines up with the head, or says why it can’t', async () => {
	const w = await world(true)
	const c1 = await w.svc.openCommit(w.review.id, w.c1)
	const b = await w.svc.commitFileMap(w.review.id, c1.comparison.id, 'b.txt')
	assert.equal(b.headFileKey, 'b.txt')
	assert.equal(shiftRange(b.shifts, 2, 3)?.start, 4, 'two lines were added above it later')
	assert.equal(shiftRange(b.shifts, 5, 5), null, 'line 5 was rewritten later')
	const a = await w.svc.commitFileMap(w.review.id, c1.comparison.id, 'a.txt')
	assert.deepEqual([a.headFileKey, a.shifts], ['a.txt', []], 'unchanged after c1')

	const c3 = await w.svc.openCommit(w.review.id, w.c3)
	assert.match((await w.svc.commitFileMap(w.review.id, c3.comparison.id, 'gone.txt')).reason ?? '', /deletes the file/)

	const c4 = await w.svc.openCommit(w.review.id, w.c4)
	const same = await w.svc.commitFileMap(w.review.id, c4.comparison.id, 'same.txt')
	assert.equal(same.headFileKey, null)
	assert.match(same.reason ?? '', /ends up unchanged/)
})

const head: Comparison = {
	id: 'h',
	repoId: 'r',
	baseRef: 'main',
	baseTipSha: 'B',
	baseSha: 'B',
	headSha: 'H',
	headRef: 'topic',
	target: null,
	pr: null,
	files: [{ key: 'b.txt', status: 'added', oldPath: null, newPath: 'b.txt', additions: 12, deletions: 0, binary: false, similarity: null }],
}
const commitFile: ChangedFile = {
	key: 'b.txt',
	status: 'added',
	oldPath: null,
	newPath: 'b.txt',
	additions: 10,
	deletions: 0,
	binary: false,
	similarity: null,
}
const commit: Comparison = { ...head, id: 'P..C', baseSha: 'P', baseTipSha: 'P', headSha: 'C', files: [commitFile] }
// Two lines inserted at the top, line 5 rewritten.
const map: CommitFileMap = {
	headFileKey: 'b.txt',
	reason: null,
	shifts: [
		{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 },
		{ oldStart: 5, oldCount: 1, newStart: 7, newCount: 1 },
	],
}
const at = (side: Anchor['side'], start: number | null, end = start): Anchor => ({
	repoId: 'r',
	baseSha: 'P',
	headSha: 'C',
	fileKey: 'b.txt',
	oldPath: null,
	newPath: 'b.txt',
	side,
	startLine: start,
	endLine: end,
	excerpt: 'x',
})

test('commit stepping: comments move to the head when their lines survive, and back again', () => {
	const moved = anchorToHead(at('new', 2, 3), map, head, 'c'.repeat(40))
	assert.ok('anchor' in moved)
	assert.deepEqual([moved.anchor.baseSha, moved.anchor.headSha, moved.anchor.startLine, moved.anchor.endLine], ['B', 'H', 4, 5])
	assert.equal(moved.anchor.excerpt, 'x')

	const later = anchorToHead(at('new', 4, 6), map, head, 'c'.repeat(40))
	assert.ok('refused' in later)
	assert.match(later.refused, /Lines 4–6 are changed again by a commit after ccccccc/)
	assert.ok('refused' in anchorToHead(at('old', 3), map, head, 'c'))
	assert.ok('refused' in anchorToHead(at('new', 1), { headFileKey: null, reason: 'Nope.', shifts: [] }, head, 'c'))
	const file = anchorToHead(at(null, null), map, head, 'c')
	assert.ok('anchor' in file && file.anchor.side === null && file.anchor.headSha === 'H')

	const back = anchorToCommit({ ...at('new', 4, 5), baseSha: 'B', headSha: 'H' }, map, commit, commitFile)
	assert.deepEqual([back?.headSha, back?.startLine, back?.endLine], ['C', 2, 3])
	assert.equal(anchorToCommit({ ...at('new', 1), baseSha: 'B', headSha: 'H' }, map, commit, commitFile), null, 'added after this commit')
	assert.equal(anchorToCommit({ ...at('new', 7), baseSha: 'B', headSha: 'H' }, map, commit, commitFile), null, 'rewritten after it')
	assert.equal(anchorToCommit({ ...at('old', 3), baseSha: 'B', headSha: 'H' }, map, commit, commitFile), null)
	assert.deepEqual(invertShifts(invertShifts(map.shifts)), map.shifts)
})

test('commit stepping: where you last left the commits is the reviewed head that reaches furthest along them', () => {
	const r = lastReviewed([
		{ sha: 'b', label: 'snapshot', index: 1 },
		{ sha: 'merge', label: 'GitHub', index: 2 },
		{ sha: 'gone', label: 'before a rebase', index: -1 },
	])
	assert.deepEqual(r, { sha: 'merge', label: 'GitHub', index: 2 })
	assert.equal(lastReviewed([{ sha: 'gone', label: 'x', index: -1 }]), null, 'rebased away: start from the first commit')
	assert.equal(lastReviewed([]), null)
})
