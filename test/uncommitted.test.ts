import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ReviewService } from '../src/main/service.ts'
import { ReviewStore } from '../src/main/store.ts'
import type { Review, ReviewComment, ReviewTarget } from '../src/shared/types.ts'

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'review-uncommitted-'))
}

/** main: a.txt, b.txt, .gitignore (*.log). topic checked out, one commit ahead. Then: a.txt edited, b.txt staged, new.txt and x.log untracked. */
async function world() {
	const dir = tmp()
	const git = (...a: Array<string>): string =>
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
			cwd: dir,
			encoding: 'utf8',
		}).trim()
	const write = (files: Record<string, string>) => {
		for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text)
	}
	git('init', '-q', '-b', 'main')
	write({ 'a.txt': 'a1\na2\na3\n', 'b.txt': 'b\n', '.gitignore': '*.log\n' })
	git('add', '-A')
	git('commit', '-qm', 'base')
	git('checkout', '-qb', 'topic')
	write({ 'c.txt': 'c\n' })
	git('add', '-A')
	git('commit', '-qm', 'topic')
	write({ 'a.txt': 'a1\nA2\na3\n', 'b.txt': 'B\n', 'new.txt': 'new\n', 'x.log': 'noise\n' })
	git('add', 'b.txt')
	const store = ReviewStore.in(tmp())
	await store.load()
	const svc = new ReviewService(store, null)
	const s = await svc.open(dir)
	return { dir, git, write, svc, repoId: s.repo.id }
}

const uncommitted = (staged: boolean, untracked = true): ReviewTarget => ({ kind: 'uncommitted', staged, untracked, branch: null })
const keys = (c: { files: Array<{ key: string }> }) => c.files.map((f) => f.key).sort()

test('uncommitted changes: the working tree or what is staged, against HEAD, without touching the real index', async () => {
	const w = await world()
	const index = readFileSync(join(w.dir, '.git', 'index'))
	const staged = w.git('diff', '--cached', '--name-only')

	const all = await w.svc.loadComparison(w.repoId, { kind: 'target', target: uncommitted(false) })
	const c = all.comparison
	assert.deepEqual(keys(c), ['a.txt', 'b.txt', 'new.txt'], 'staged, unstaged and untracked; ignored files left out')
	assert.deepEqual(c.untracked, ['new.txt'])
	assert.equal(c.baseSha, w.git('rev-parse', 'HEAD'))
	assert.equal(w.git('cat-file', '-t', c.headSha), 'tree', 'the head is a tree, not a commit')
	assert.deepEqual(c.target, { kind: 'uncommitted', staged: false, untracked: true, branch: 'refs/heads/topic' })
	assert.ok(readFileSync(join(w.dir, '.git', 'index')).equals(index), 'the repository index is unchanged')
	assert.equal(w.git('diff', '--cached', '--name-only'), staged)

	const lines = await w.svc.loadFileAt(c.id, 'a.txt', 'new')
	assert.deepEqual(lines.kind === 'text' ? lines.lines : null, ['a1', 'A2', 'a3'], 'files are read from the snapshot')

	const tracked = await w.svc.loadComparison(w.repoId, { kind: 'target', target: uncommitted(false, false) })
	assert.deepEqual(keys(tracked.comparison), ['a.txt', 'b.txt'])
	const only = await w.svc.loadComparison(w.repoId, { kind: 'target', target: uncommitted(true) })
	assert.deepEqual(keys(only.comparison), ['b.txt'])

	// Reopening a stored snapshot works from the tree it kept.
	const again = await w.svc.loadComparison(w.repoId, { kind: 'snapshot', reviewId: c.id })
	assert.deepEqual(keys(again.comparison), ['a.txt', 'b.txt', 'new.txt'])
})

test('uncommitted changes: an edit shows as an update, and comments carry to the next snapshot and to the branch after committing', async () => {
	const w = await world()
	const first = await w.svc.loadComparison(w.repoId, { kind: 'target', target: uncommitted(false) })
	const r1 = first.review
	assert.deepEqual((await w.svc.probeTarget(w.repoId, r1.id)).changed, false, 'nothing changed yet')
	await w.svc.saveReview({ ...r1, comments: [comment(r1, 'k', 'a.txt', 2, 'A2')] })

	w.write({ 'b.txt': 'B again\n' })
	const probe = await w.svc.probeTarget(w.repoId, r1.id)
	assert.equal(probe.changed, true)
	assert.match(probe.summary ?? '', /Files changed since this snapshot/)
	const second = await w.svc.loadComparison(w.repoId, { kind: 'target', target: uncommitted(false), from: r1.id })
	assert.notEqual(second.comparison.id, r1.id)
	assert.equal(second.review.comments.length, 1, 'the comment carried to the new snapshot')
	assert.equal(second.review.comments[0].anchor.startLine, 2)

	// Commit it all: the branch review of topic picks the comment up, at the same line.
	w.git('add', '-A')
	w.git('commit', '-qm', 'wip')
	assert.equal((await w.svc.probeTarget(w.repoId, second.comparison.id)).changed, true, 'HEAD moved')
	const branch = await w.svc.loadComparison(w.repoId, {
		kind: 'target',
		target: { kind: 'branch', headRef: 'refs/heads/topic', baseRef: 'refs/heads/main' },
	})
	const carried = branch.review.comments.find((x) => x.carried?.originId === 'k')
	assert.ok(carried, branch.notice ?? 'no notice')
	assert.equal(carried.carried?.outdated, null)
	assert.deepEqual([carried.anchor.fileKey, carried.anchor.startLine], ['a.txt', 2])
	assert.match(branch.notice ?? '', /your uncommitted changes/)
})

function comment(r: Review, id: string, file: string, line: number, excerpt: string): ReviewComment {
	const t = new Date().toISOString()
	return {
		id,
		anchor: {
			repoId: r.repoId,
			baseSha: r.baseSha,
			headSha: r.headSha,
			fileKey: file,
			oldPath: file,
			newPath: file,
			side: 'new',
			startLine: line,
			endLine: line,
			excerpt,
		},
		body: 'a comment',
		createdAt: t,
		updatedAt: t,
		findingId: null,
	}
}

test('uncommitted changes: an AI run reviews the snapshot, related code and all', async () => {
	const { AiController } = await import('../src/main/ai/controller.ts')
	const { createFakeProvider } = await import('../src/main/ai/fake.ts')
	const w = await world()
	const store = (w.svc as unknown as { store: ReviewStore }).store
	const provider = createFakeProvider()
	const ai = new AiController(store, async () => ({
		provider,
		connectionId: '00000000-0000-4000-8000-000000000000',
		connectionLabel: 'Fixture',
		endpoint: 'fixture://local',
		limits: { contextLines: 5, maxBatchChars: 100_000, maxRunChars: 1_000_000, verify: false },
	}))
	w.svc.attachAi(ai)
	const { comparison } = await w.svc.loadComparison(w.repoId, { kind: 'target', target: uncommitted(false) })
	const started = await w.svc.startAi(
		comparison.id,
		{ kind: 'all' },
		{ connectionId: '00000000-0000-4000-8000-000000000000', modelId: 'fixture-v1' },
	)
	await ai.whenDone(started.id)
	const stored = () => ai.runsFor(w.repoId, comparison.id).find((r) => r.id === started.id)!
	for (let i = 0; i < 100 && stored().status === 'running'; i++) await new Promise((r) => setTimeout(r, 10))
	const run = stored()
	assert.equal(run.status, 'completed', run.errors.join('; '))
	assert.equal(run.headSha, comparison.headSha)
	assert.ok(
		run.findings.some((f) => f.anchor.fileKey === 'new.txt'),
		'the untracked file was reviewed too',
	)
})
