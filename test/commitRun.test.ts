import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AiController } from '../src/main/ai/controller.ts'
import type { RunConfig } from '../src/main/ai/connections.ts'
import { createFakeProvider, defaultScript } from '../src/main/ai/fake.ts'
import type { ProviderRequest } from '../src/main/ai/provider.ts'
import { ReviewService } from '../src/main/service.ts'
import { ReviewStore } from '../src/main/store.ts'
import { commitRunKey, type AiRun, type ReviewerChoice } from '../src/shared/types.ts'

const SEL = { connectionId: '00000000-0000-4000-8000-000000000000', modelId: 'fixture-v1' }
const MODEL: ReviewerChoice = { kind: 'model', selection: SEL }
const tmp = (): string => mkdtempSync(join(tmpdir(), 'review-commit-run-'))

/** main: a.ts. topic: c1 adds b.ts, c2 changes a.ts. */
async function setup(stepCommits = true, c1Files: Record<string, string> = { 'b.ts': 'export const b = 2\nexport const c = 3\n' }) {
	const dir = tmp()
	const git = (...a: Array<string>): string =>
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
			cwd: dir,
			encoding: 'utf8',
		}).trim()
	const commit = (files: Record<string, string>, msg: string): string => {
		for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text)
		git('add', '-A')
		git('commit', '-qm', msg)
		return git('rev-parse', 'HEAD')
	}
	git('init', '-q', '-b', 'main')
	commit({ 'a.ts': 'const a = 1\n' }, 'base')
	git('checkout', '-qb', 'topic')
	const c1 = commit(c1Files, 'Add b\n\nb is needed by the cart.')
	const c2 = commit({ 'a.ts': 'const a = 10\n' }, 'Bump a')
	const store = ReviewStore.in(tmp())
	await store.load()
	if (stepCommits) await store.update((d) => void (d.stepCommits = true))
	const svc = new ReviewService(store, null)
	const asked: Array<ProviderRequest> = []
	const provider = createFakeProvider({
		script: (req) => {
			asked.push(req)
			return defaultScript(req)
		},
	})
	const config = async (): Promise<RunConfig> => ({
		provider,
		connectionId: SEL.connectionId,
		connectionLabel: 'Fixture',
		endpoint: 'fixture://local',
		limits: { contextLines: 5, maxBatchChars: 100_000, maxRunChars: 1_000_000, verify: false, relatedCode: false, lookups: false },
	})
	const ai = new AiController(store, config, () => {})
	svc.attachAi(ai)
	const s = await svc.open(dir)
	const review = (
		await svc.loadComparison(s.repo.id, {
			kind: 'target',
			target: { kind: 'branch', headRef: 'refs/heads/topic', baseRef: 'refs/heads/main' },
		})
	).comparison
	return { svc, ai, store, asked, review, repoId: s.repo.id, c1, c2, commit }
}

async function finished(ai: AiController, run: AiRun): Promise<AiRun> {
	await ai.whenDone(run.id)
	const stored = () => ai.runsFor(run.repoId, run.reviewId).find((r) => r.id === run.id)!
	for (let i = 0; i < 100 && stored().status === 'running'; i++) await new Promise((r) => setTimeout(r, 10))
	return stored()
}

test('commit review: refused while stepping through commits is off', async () => {
	const w = await setup(false)
	await assert.rejects(w.svc.startCommitReview(w.review.id, w.c1, MODEL, false), /Settings › Reviewing/)
})

test('commit review: only that commit’s diff, with its message and the earlier ones; kept apart from the review’s runs', async () => {
	const w = await setup()
	const run = await finished(w.ai, await w.svc.startCommitReview(w.review.id, w.c2, MODEL, false))
	assert.equal(run.status, 'completed')
	const target = 'branch:refs/heads/topic|refs/heads/main'
	assert.equal(run.reviewId, commitRunKey(target, w.c2))
	assert.deepEqual(run.commitOf, { reviewId: w.review.id, target, sha: w.c2 })
	assert.deepEqual([run.baseSha, run.headSha], [w.c1, w.c2], 'anchored in that commit')
	const sent = w.asked.filter((r) => !r.schema || r.batch.excerpts.length)
	assert.deepEqual([...new Set(sent.flatMap((r) => r.batch.excerpts.map((e) => e.file.key)))], ['a.ts'], 'only c2’s file')
	const input = sent.map((r) => r.input).join('\n')
	assert.match(input, /commit 2 of 2/)
	assert.match(input, /Bump a/)
	assert.match(input, /The commits before it, oldest first:\n- Add b/)

	assert.equal(w.ai.runsFor(w.repoId, w.review.id).length, 0, 'the review’s own runs are untouched')
	const byCommit = w.svc.commitRuns(w.review.id)
	assert.deepEqual(Object.keys(byCommit), [w.c2])

	// A comment made from one of its findings, moved to the head, is accepted with its finding link.
	const f = run.findings[0]
	assert.ok(f, 'the fixture marks a changed line')
	const stored = w.store.read().repos[w.repoId].reviews[w.review.id]
	const comment = {
		id: 'c1',
		anchor: { ...f.anchor, baseSha: w.review.baseSha, headSha: w.review.headSha },
		body: f.title,
		createdAt: '2026-11-09T10:00:00.000Z',
		updatedAt: '2026-11-09T10:00:00.000Z',
		findingId: f.id,
	}
	await w.svc.saveReview({
		...stored,
		comments: [comment],
		drafts: [],
		findingDecisions: { [f.id]: { status: 'accepted', decidedAt: '2026-11-09T10:00:00.000Z' } },
	})
	assert.equal(w.store.read().repos[w.repoId].reviews[w.review.id].comments[0].findingId, f.id)
})

test('commit review: kept for the pull request or branch, so a later snapshot reuses it after a new push', async () => {
	const w = await setup()
	await finished(w.ai, await w.svc.startCommitReview(w.review.id, w.c1, MODEL, false))
	w.commit({ 'c.ts': 'export const c = 1\n' }, 'Add c')
	const next = (
		await w.svc.loadComparison(w.repoId, {
			kind: 'target',
			target: { kind: 'branch', headRef: 'refs/heads/topic', baseRef: 'refs/heads/main' },
		})
	).comparison
	assert.notEqual(next.id, w.review.id, 'a new snapshot')
	assert.deepEqual(Object.keys(w.svc.commitRuns(next.id)), [w.c1], 'c1’s review carries over')
	// Its findings can still be linked from the new snapshot's comments.
	const f = w.svc.commitRuns(next.id)[w.c1][0].findings[0]
	const stored = w.store.read().repos[w.repoId].reviews[next.id]
	await w.svc.saveReview({
		...stored,
		findingDecisions: { [f.id]: { status: 'dismissed', decidedAt: '2026-11-09T10:00:00.000Z' } },
	})
	assert.equal(w.store.read().repos[w.repoId].reviews[next.id].findingDecisions[f.id].status, 'dismissed')
})

test('commit review: a head you reviewed earlier, even a merge, says how far along the commits you got', async () => {
	const w = await setup()
	const root = w.store.read().repos[w.repoId].root
	const git = (...a: Array<string>): string =>
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
			cwd: root,
			encoding: 'utf8',
		}).trim()
	git('checkout', '-q', 'main')
	w.commit({ 'm.ts': 'm\n' }, 'main moves')
	git('checkout', '-q', 'topic')
	git('merge', '-q', '--no-edit', 'main')
	const merged = git('rev-parse', 'HEAD') // a head that is a merge, after c1 and c2
	const c3 = w.commit({ 'd.ts': 'd\n' }, 'Add d')
	const next = (
		await w.svc.loadComparison(w.repoId, {
			kind: 'target',
			target: { kind: 'branch', headRef: 'refs/heads/topic', baseRef: 'refs/heads/main' },
		})
	).comparison
	assert.deepEqual(
		(await w.svc.commitList(next.id)).commits.map((c) => c.sha),
		[w.c1, w.c2, c3],
	)
	assert.deepEqual(await w.svc.reviewedUpTo(next.id, [merged, w.c1, '0'.repeat(40)]), [1, 0, -1])
})

const reopen = async (w: Awaited<ReturnType<typeof setup>>) =>
	(
		await w.svc.loadComparison(w.repoId, {
			kind: 'target',
			target: { kind: 'branch', headRef: 'refs/heads/topic', baseRef: 'refs/heads/main' },
		})
	).comparison

async function checked(w: Awaited<ReturnType<typeof setup>>, reviewId: string, sha: string): Promise<AiRun> {
	for (let i = 0; i < 200; i++) {
		const run = w.svc.commitRuns(reviewId)[sha]?.at(-1)
		if (run?.laterCheck === 'done') return run
		await new Promise((r) => setTimeout(r, 10))
	}
	throw new Error('the findings were never checked against the latest code')
}

test('commit review: a commit whose additions later commits all changed is skipped, not sent', async () => {
	const w = await setup()
	w.commit({ 'b.ts': 'export const b = 20\nexport const c = 30\n' }, 'Rewrite b')
	const next = await reopen(w)
	const asked = w.asked.length
	const r = await w.svc.startCommitReview(next.id, w.c1, MODEL, false)
	assert.ok('skipped' in r, 'nothing of c1 is left')
	assert.match(r.skipped, /changed again by later commits/)
	assert.equal(w.asked.length, asked, 'nothing sent')
	const kept = await w.svc.startCommitReview(next.id, w.c2, MODEL, false)
	assert.ok(!('skipped' in kept), 'c2’s change is still there')
	await finished(w.ai, kept)
})

test('commit review: findings on code later commits changed are checked against the latest code; a deleted file is gone', async () => {
	const w = await setup(true, { 'b.ts': 'export const b = 2\nexport const c = 3\n', 'x.ts': 'export const x = 1\n' })
	w.commit({ 'b.ts': 'export const b = 22\nexport const c = 3\n' }, 'Change b’s first line') // c1’s b.ts:1 changes, :2 stays
	w.commit({ 'x.ts': 'export const x = 2\n' }, 'Change x')
	const { execFileSync: run } = await import('node:child_process')
	const root = w.store.read().repos[w.repoId].root
	run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'rm', '-q', 'x.ts'], { cwd: root })
	run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Drop x'], { cwd: root })
	const next = await reopen(w)
	const started = await w.svc.startCommitReview(next.id, w.c1, MODEL, false)
	assert.ok(!('skipped' in started), 'b.ts:2 is still there')
	await finished(w.ai, started)
	const done = await checked(w, next.id, w.c1)
	const at = (path: string) => done.findings.find((f) => f.anchor.newPath === path && !f.mergedInto)
	assert.equal(at('x.ts')?.atHead?.verdict, 'wrong', 'x.ts is deleted later: gone, without asking')
	assert.match(at('x.ts')?.atHead?.reason ?? '', /deletes x\.ts/)
	assert.ok(at('b.ts')?.atHead, 'b.ts:1 changed later: asked about the latest code')
	const verify = w.asked.filter((r) => r.schema?.name === 'finding_verification' || /# The finding/.test(r.input))
	assert.equal(verify.length, 1, 'one request, for b.ts only')
	assert.match(verify[0].input, /export const b = 22/, 'with the latest code')
})
