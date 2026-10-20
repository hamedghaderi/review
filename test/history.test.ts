import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AiController } from '../src/main/ai/controller.ts'
import { createFakeProvider, defaultScript } from '../src/main/ai/fake.ts'
import { VERIFY_SCHEMA_NAME, type ReviewOutput } from '../src/main/ai/schema.ts'
import type { ProviderRequest } from '../src/main/ai/provider.ts'
import type { RunConfig } from '../src/main/ai/connections.ts'
import { Mapper } from '../src/main/linemap.ts'
import { ReviewService } from '../src/main/service.ts'
import { ReviewStore } from '../src/main/store.ts'
import { findingRoots, findingState, findingTimeline, historyCounts, sinceState } from '../src/shared/findings.ts'
import type { AiRun, ReviewerChoice } from '../src/shared/types.ts'

const SEL = { connectionId: '00000000-0000-4000-8000-000000000000', modelId: 'fixture-v1' }
const MODEL: ReviewerChoice = { kind: 'model', selection: SEL }

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'review-history-'))
}

const file = (name: string, n: number) =>
	Array.from({ length: 12 }, (_, i) => (i === 5 ? `${name} = ${n}` : `// ${name} ${i}`)).join('\n') + '\n'

/** main: a–e.ts. topic v1 changes all five. */
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
	const names = ['a', 'b', 'c', 'd', 'e']
	run('init', '-q', '-b', 'main')
	commit(Object.fromEntries(names.map((n) => [`${n}.ts`, file(n, 0)])), 'base')
	run('checkout', '-qb', 'topic')
	commit(Object.fromEntries(names.map((n) => [`${n}.ts`, file(n, 1)])), 'v1')
	run('checkout', '-q', 'main')
	const push = (files: Record<string, string | null>, msg: string) => {
		run('checkout', '-q', 'topic')
		commit(files, msg)
		run('checkout', '-q', 'main')
	}
	return { dir, run, push }
}

const target = { kind: 'branch' as const, headRef: 'refs/heads/topic', baseRef: 'refs/heads/main' }

async function setup() {
	const w = world()
	const store = ReviewStore.in(tmp())
	await store.load()
	const svc = new ReviewService(store, null)
	const silent = new Set<string>() // files the fake reviewer raises nothing on
	const checks: Array<ProviderRequest> = [] // double-check requests
	const provider = createFakeProvider({
		script: (req) => {
			const out = defaultScript(req)
			if (req.schema?.name === VERIFY_SCHEMA_NAME) {
				checks.push(req)
				return { verdict: 'wrong', reason: 'Line 6 of e.ts no longer does it.', level: null, checked: ['e.ts:1-12'] }
			}
			if (req.schema) return out
			const review = out as ReviewOutput
			return { ...review, findings: review.findings.filter((f) => !silent.has(f.file_path)) }
		},
	})
	const config = async (): Promise<RunConfig> => ({
		provider,
		connectionId: SEL.connectionId,
		connectionLabel: 'Fixture',
		endpoint: 'fixture://local',
		limits: { contextLines: 5, maxBatchChars: 100_000, maxRunChars: 1_000_000, verify: false, relatedCode: false },
	})
	const ai = new AiController(store, config, () => {})
	svc.attachAi(ai)
	const s = await svc.open(w.dir)
	return { w, svc, ai, silent, checks, repoId: s.repo.id }
}

async function finished(ai: AiController, run: AiRun): Promise<AiRun> {
	await ai.whenDone(run.id)
	const stored = () => ai.runsFor(run.repoId, run.reviewId).find((r) => r.id === run.id)!
	for (let i = 0; i < 100 && stored().status === 'running'; i++) await new Promise((r) => setTimeout(r, 10))
	return stored()
}

const on = (run: AiRun, key: string) => run.findings.find((f) => f.anchor.fileKey === key)

test('after new commits, a run tells which findings are new, still present, probably fixed or not seen', async () => {
	const { w, svc, ai, silent, repoId } = await setup()
	const v1 = await svc.loadComparison(repoId, { kind: 'target', target })
	const first = await finished(ai, await svc.startAi(v1.comparison.id, { kind: 'all' }, MODEL))
	assert.equal(first.status, 'completed', first.errors.join('; '))
	assert.equal(first.history ?? null, null, 'nothing earlier to compare with')

	// Add the finding on a.ts as a comment and dismiss the one on b.ts.
	const r1 = (await svc.loadComparison(repoId, { kind: 'snapshot', reviewId: v1.comparison.id })).review
	const t = new Date().toISOString()
	const onA = on(first, 'a.ts')!
	await svc.saveReview({
		...r1,
		findingDecisions: { [on(first, 'b.ts')!.id]: { status: 'dismissed', decidedAt: t, reason: 'intended' } },
		comments: [{ id: 'k1', anchor: onA.anchor, body: 'from the finding', createdAt: t, updatedAt: t, findingId: onA.id }],
	})

	// v2: a.ts's cited line changes and is raised again; c.ts goes back to how it was on main; d.ts is unchanged but
	// not raised; e.ts's cited line changes and is not raised; f.ts is new.
	w.push({ 'a.ts': file('a', 2), 'c.ts': file('c', 0), 'e.ts': file('e', 2), 'f.ts': file('f', 1) }, 'v2')
	const v2 = await svc.loadComparison(repoId, { kind: 'target', target, from: v1.comparison.id })
	silent.add('d.ts').add('e.ts')
	const next = await finished(ai, await svc.startAi(v2.comparison.id, { kind: 'all' }, MODEL))
	assert.equal(next.status, 'completed', next.errors.join('; '))
	assert.deepEqual(next.history?.from, { runId: first.id, reviewId: v1.comparison.id, headSha: first.headSha })
	assert.equal(next.history?.baseMoved, false)
	assert.equal(next.history?.rewritten, false)

	const a = on(next, 'a.ts')!
	assert.notEqual(a.id, onA.id, 'reviewed again, so a new finding')
	assert.equal(a.previous?.findingId, onA.id, 'matched although its line changed')
	assert.equal(a.previous?.comment, 'k1')
	assert.deepEqual(a.previous?.seen, [next.history!.from])
	assert.equal(on(next, 'b.ts')!.previous?.decision?.status, 'dismissed')
	assert.equal(on(next, 'f.ts')!.previous ?? null, null)

	const gone = new Map(next.history!.gone.map((g) => [g.finding.anchor.fileKey, g]))
	assert.deepEqual([...gone.keys()].sort(), ['c.ts', 'd.ts', 'e.ts'])
	assert.equal(gone.get('c.ts')?.state, 'fixed')
	assert.equal(gone.get('c.ts')?.why, 'The file is no longer part of the change.')
	assert.equal(gone.get('e.ts')?.state, 'fixed')
	assert.equal(gone.get('e.ts')?.why, 'Its lines changed.')
	assert.equal(gone.get('d.ts')?.state, 'not-seen', 'unchanged lines are never counted as fixed')

	// What was decided in v1 shows in v2 without anything written into it.
	const r2 = (await svc.loadComparison(repoId, { kind: 'snapshot', reviewId: v2.comparison.id })).review
	assert.deepEqual(r2.findingDecisions, {})
	const runs = ai.runsFor(repoId, v2.comparison.id)
	const roots = findingRoots(runs)
	const byId = new Map(runs.flatMap((r) => r.findings.map((f) => [f.id, f] as const)))
	assert.equal(findingState(r2, roots, a, byId), 'accepted', 'linked to the comment carried from v1')
	assert.equal(findingState(r2, roots, on(next, 'b.ts')!, byId), 'dismissed')
	assert.deepEqual(historyCounts(r2, next, runs, roots), { fresh: 1, present: 1, dismissed: 1, fixed: 2, notSeen: 1 })
	assert.equal(sinceState(next, a), 'present')
	assert.equal(sinceState(next, on(next, 'f.ts')!), 'new')
	assert.equal(sinceState(first, onA), null, 'not compared, so neither')
	assert.deepEqual(findingTimeline(a, next.headSha), [first.headSha, next.headSha])

	// v3 changes only f.ts; an incremental run carries the rest, and carried findings are still present.
	silent.clear()
	w.push({ 'f.ts': file('f', 2) }, 'v3')
	const v3 = await svc.loadComparison(repoId, { kind: 'target', target, from: v2.comparison.id })
	const third = await finished(ai, await svc.startAi(v3.comparison.id, { kind: 'changed' }, MODEL))
	assert.equal(third.carriedFrom?.runId, next.id)
	assert.equal(third.history?.from.runId, next.id)
	const a3 = on(third, 'a.ts')!
	assert.equal(a3.id, a.id, 'carried, so the same finding')
	assert.equal(a3.previous?.findingId, a.id)
	assert.deepEqual(
		a3.previous?.seen.map((s) => s.runId),
		[first.id, next.id],
		'the snapshots it was raised in',
	)
	assert.equal(on(third, 'f.ts')!.previous?.findingId, on(next, 'f.ts')!.id, 'raised again on the changed line')
	assert.deepEqual(third.history?.gone, [])
	assert.deepEqual(findingTimeline(a3, third.headSha), [first.headSha, next.headSha, third.headSha])
})

test('a rebase is noted, and lines are still matched head to head', async () => {
	const { w, svc, ai, repoId } = await setup()
	const v1 = await svc.loadComparison(repoId, { kind: 'target', target })
	const first = await finished(ai, await svc.startAi(v1.comparison.id, { kind: 'all' }, MODEL))

	// main moves on in a file the topic doesn't touch, and the topic is rebased onto it.
	w.run('checkout', '-q', 'main')
	writeFileSync(join(w.dir, 'z.ts'), 'z\n')
	w.run('add', '-A')
	w.run('commit', '-qm', 'main moves')
	w.run('checkout', '-q', 'topic')
	w.run('rebase', '-q', 'main')
	w.run('checkout', '-q', 'main')

	const v2 = await svc.loadComparison(repoId, { kind: 'target', target, from: v1.comparison.id })
	const next = await finished(ai, await svc.startAi(v2.comparison.id, { kind: 'all' }, MODEL))
	assert.equal(next.history?.baseMoved, true)
	assert.equal(next.history?.rewritten, true)
	assert.ok(
		next.findings.every((f) => f.previous && first.findings.some((x) => x.id === f.previous!.findingId)),
		'every finding is still present',
	)
	assert.deepEqual(next.history?.gone, [])
})

test('a changed range is followed to what replaced it, shifted by lines added above', async () => {
	const w = world()
	const before = w.run('rev-parse', 'topic')
	const lines = file('a', 1).split('\n')
	lines[5] = 'a = 2 // edited'
	w.push({ 'a.ts': ['// one', '// two', '// three', ...lines].join('\n') }, 'v2')
	const m = new Mapper(w.dir, before, w.run('rev-parse', 'topic'))
	const move = await m.move('a.ts')
	assert.equal(await m.range(move, 6, 6), null, 'its line changed')
	assert.deepEqual(await m.near(move, 6, 6), { start: 9, end: 9 })
	assert.deepEqual(await m.near(move, 10, 11), { start: 13, end: 14 }, 'unchanged lines below only move')
	assert.deepEqual(await m.near(move, 5, 7), { start: 8, end: 10 })
})

test('you can ask whether a gone finding is still there; the verdict is saved on it and nothing else changes', async () => {
	const { w, svc, ai, silent, checks, repoId } = await setup()
	const v1 = await svc.loadComparison(repoId, { kind: 'target', target })
	const first = await finished(ai, await svc.startAi(v1.comparison.id, { kind: 'all' }, MODEL))
	// v2: three lines above e.ts's cited line, which changes; the reviewer doesn't raise it again.
	const lines = file('e', 2).split('\n')
	w.push({ 'e.ts': ['// one', '// two', '// three', ...lines].join('\n') }, 'v2')
	const v2 = await svc.loadComparison(repoId, { kind: 'target', target, from: v1.comparison.id })
	silent.add('e.ts')
	const next = await finished(ai, await svc.startAi(v2.comparison.id, { kind: 'all' }, MODEL))
	const gone = next.history!.gone.find((g) => g.finding.anchor.fileKey === 'e.ts')!
	assert.equal(gone.state, 'fixed')
	assert.equal(gone.finding.anchor.startLine, 6, 'kept as it was')
	assert.equal(gone.at?.startLine, 9, 'and about where it would be now')

	const before = structuredClone(next.findings)
	const checked = await svc.checkFixed(v2.comparison.id, next.id, gone.finding.id, null)
	assert.equal(checks.length, 1)
	assert.match(checks[0].instructions, new RegExp(`at commit ${first.headSha.slice(0, 7)}`))
	assert.match(checks[0].input, /Location: e\.ts, new side, lines 9-9/, 'asked about where it is now')
	assert.match(checks[0].input, /e = 2/, 'with the code as it is now')
	const after = checked.history!.gone.find((g) => g.finding.id === gone.finding.id)!
	assert.equal(after.check?.verdict, 'wrong')
	assert.equal(after.check?.reason, 'Line 6 of e.ts no longer does it.')
	assert.equal(after.state, 'fixed')
	assert.deepEqual(checked.findings, before, "the run's own findings are left alone")
	const stored = ai.runsFor(repoId, v2.comparison.id).find((r) => r.id === next.id)!
	assert.equal(stored.history!.gone.find((g) => g.finding.id === gone.finding.id)?.check?.verdict, 'wrong', 'saved')

	await assert.rejects(svc.checkFixed(v2.comparison.id, next.id, 'nope', null), /no longer exists/)
	await assert.rejects(svc.checkFixed(v2.comparison.id, first.id, gone.finding.id, null), /no longer exists/, 'another run')
})
