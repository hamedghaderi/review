import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AiController } from '../src/main/ai/controller.ts'
import { createFakeProvider, defaultScript } from '../src/main/ai/fake.ts'
import type { RunConfig } from '../src/main/ai/connections.ts'
import { ReviewService } from '../src/main/service.ts'
import { ReviewStore } from '../src/main/store.ts'
import { findingRoots, findingState } from '../src/shared/findings.ts'
import type { AiRun, ReviewerChoice } from '../src/shared/types.ts'

const SEL = { connectionId: '00000000-0000-4000-8000-000000000000', modelId: 'fixture-v1' }
const MODEL: ReviewerChoice = { kind: 'model', selection: SEL }

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'review-incremental-'))
}

/** main: a.ts, b.ts, c.ts. topic v1 changes all three. */
function world() {
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
	const file = (name: string, n: number) =>
		Array.from({ length: 12 }, (_, i) => (i === 5 ? `${name} = ${n}` : `// ${name} ${i}`)).join('\n') + '\n'
	run('init', '-q', '-b', 'main')
	commit({ 'a.ts': file('a', 0), 'b.ts': file('b', 0), 'c.ts': file('c', 0) }, 'base')
	run('checkout', '-qb', 'topic')
	commit({ 'a.ts': file('a', 1), 'b.ts': file('b', 1), 'c.ts': file('c', 1) }, 'v1')
	run('checkout', '-q', 'main')
	return { dir, run, commit, file }
}

const target = { kind: 'branch' as const, headRef: 'refs/heads/topic', baseRef: 'refs/heads/main' }

async function setup() {
	const w = world()
	const store = ReviewStore.in(tmp())
	await store.load()
	const svc = new ReviewService(store, null)
	const sent: Array<Array<string>> = []
	const inputs: Array<string> = []
	const provider = createFakeProvider({
		script: (req) => {
			if (!req.schema) sent.push(req.batch.excerpts.map((e) => e.file.key))
			if (!req.schema) inputs.push(req.input)
			return defaultScript(req)
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
	return { w, store, svc, ai, sent, inputs, repoId: s.repo.id }
}

async function finished(ai: AiController, run: AiRun): Promise<AiRun> {
	await ai.whenDone(run.id)
	// A run with nothing to send can be over before it is awaited; its last update is stored right after.
	const stored = () => ai.runsFor(run.repoId, run.reviewId).find((r) => r.id === run.id)!
	for (let i = 0; i < 100 && stored().status === 'running'; i++) await new Promise((r) => setTimeout(r, 10))
	return stored()
}

test('after a new commit, a run reviews only the files whose diff changed and carries the rest with their decisions', async () => {
	const { w, svc, ai, sent, repoId } = await setup()
	const v1 = await svc.loadComparison(repoId, { kind: 'target', target })
	assert.equal(await svc.incrementalOffer(v1.comparison.id, MODEL), null, 'no earlier run')
	const first = await finished(ai, await svc.startAi(v1.comparison.id, { kind: 'all' }, MODEL))
	assert.equal(first.status, 'completed', first.errors.join('; '))
	const on = (run: AiRun, key: string) => run.findings.find((f) => f.anchor.fileKey === key)!
	const onB = on(first, 'b.ts')
	const onC = on(first, 'c.ts')

	// Dismiss the finding on b.ts and add the one on c.ts as a comment.
	const r1 = (await svc.loadComparison(repoId, { kind: 'snapshot', reviewId: v1.comparison.id })).review
	const t = new Date().toISOString()
	await svc.saveReview({
		...r1,
		findingDecisions: { [onB.id]: { status: 'dismissed', decidedAt: t, reason: 'intended' } },
		comments: [{ id: 'k1', anchor: onC.anchor, body: 'from the finding', createdAt: t, updatedAt: t, findingId: onC.id }],
	})

	// v2 changes only a.ts.
	w.run('checkout', '-q', 'topic')
	w.commit({ 'a.ts': w.file('a', 2) }, 'v2')
	w.run('checkout', '-q', 'main')
	const v2 = await svc.loadComparison(repoId, { kind: 'target', target, from: v1.comparison.id })
	assert.notEqual(v2.comparison.id, v1.comparison.id)

	const offer = await svc.incrementalOffer(v2.comparison.id, MODEL)
	assert.ok(offer && offer.refused === null, JSON.stringify(offer))
	assert.deepEqual(offer.review, ['a.ts'])
	assert.deepEqual(offer.carry.sort(), ['b.ts', 'c.ts'])
	assert.equal(offer.from.runId, first.id)

	const refused = await svc.incrementalOffer(v2.comparison.id, { ...MODEL, bugsOnly: true })
	assert.match(refused?.refused ?? '', /different model, team or set of rules/, 'a bugs-only run cannot carry a full run')
	await assert.rejects(svc.startAi(v2.comparison.id, { kind: 'changed' }, { ...MODEL, bugsOnly: true }), /Review all files instead/)

	sent.length = 0
	const next = await finished(ai, await svc.startAi(v2.comparison.id, { kind: 'changed' }, MODEL))
	assert.equal(next.status, 'completed', next.errors.join('; '))
	assert.deepEqual([...new Set(sent.flat())], ['a.ts'], 'only the changed file is sent')
	assert.deepEqual(next.scope, { kind: 'files', fileKeys: ['a.ts'] })
	assert.deepEqual(next.carriedFrom, offer.from)
	const cov = new Map(next.coverage.files.map((f) => [f.fileKey, f]))
	assert.equal(cov.get('a.ts')?.state, 'reviewed')
	assert.equal(cov.get('b.ts')?.state, 'carried')
	assert.deepEqual(cov.get('b.ts')?.from, offer.from)

	const carriedB = next.findings.find((f) => f.id === onB.id)!
	assert.ok(carriedB, 'the finding keeps its id')
	assert.equal(carriedB.runId, next.id)
	assert.equal(carriedB.anchor.headSha, v2.comparison.headSha)
	assert.equal(carriedB.anchor.startLine, onB.anchor.startLine, 'same diff, same lines')
	assert.equal(carriedB.carried?.decision?.status, 'dismissed')
	const carriedC = next.findings.find((f) => f.id === onC.id)!
	assert.equal(carriedC.carried?.comment, 'k1')
	assert.ok(
		next.findings.some((f) => f.anchor.fileKey === 'a.ts' && !f.carried),
		'a.ts was reviewed again',
	)

	// The decisions show in the new snapshot without anything written into it.
	const r2 = (await svc.loadComparison(repoId, { kind: 'snapshot', reviewId: v2.comparison.id })).review
	assert.deepEqual(r2.findingDecisions, {})
	const runs = ai.runsFor(repoId, v2.comparison.id)
	const roots = findingRoots(runs)
	const byId = new Map(runs.flatMap((r) => r.findings.map((f) => [f.id, f] as const)))
	assert.equal(findingState(r2, roots, carriedB, byId), 'dismissed')
	assert.equal(findingState(r2, roots, carriedC, byId), 'accepted', 'linked to the carried comment')

	// A decision made here wins over the carried one.
	await svc.saveReview({ ...r2, findingDecisions: { [carriedB.id]: { status: 'open', decidedAt: new Date().toISOString() } } })
	const r2b = (await svc.loadComparison(repoId, { kind: 'snapshot', reviewId: v2.comparison.id })).review
	assert.equal(findingState(r2b, roots, carriedB, byId), 'open')

	// This snapshot now has the newest finished run: nothing earlier to build on.
	assert.equal(await svc.incrementalOffer(v2.comparison.id, MODEL), null)

	// v3 changes a.ts again: b.ts carries through the incremental run, still pointing at the run that reviewed it.
	w.run('checkout', '-q', 'topic')
	w.commit({ 'a.ts': w.file('a', 3) }, 'v3')
	w.run('checkout', '-q', 'main')
	const v3 = await svc.loadComparison(repoId, { kind: 'target', target, from: v2.comparison.id })
	const third = await finished(ai, await svc.startAi(v3.comparison.id, { kind: 'changed' }, MODEL))
	assert.equal(third.carriedFrom?.runId, next.id)
	assert.deepEqual(third.coverage.files.find((f) => f.fileKey === 'b.ts')?.from, offer.from)
	const again = third.findings.find((f) => f.id === onB.id)!
	assert.deepEqual(again.carried?.from, offer.from)
	assert.equal(again.carried?.decision?.status, 'open', 'the decision made in v2 carries, not the older one')
	assert.equal(third.findings.find((f) => f.id === onC.id)?.carried?.comment, 'k1')
})

test('a run with nothing changed in its diff sends nothing and carries every file', async () => {
	const { w, svc, ai, sent, repoId } = await setup()
	const v1 = await svc.loadComparison(repoId, { kind: 'target', target })
	await finished(ai, await svc.startAi(v1.comparison.id, { kind: 'all' }, MODEL))
	// main moves on in a file the branch does not touch, and the branch is rebased onto it: every diff stays the same.
	w.commit({ 'd.ts': 'd\n' }, 'main moves')
	w.run('checkout', '-q', 'topic')
	w.run('-c', 'core.editor=true', 'rebase', '-q', 'main')
	w.run('checkout', '-q', 'main')
	const v2 = await svc.loadComparison(repoId, { kind: 'target', target, from: v1.comparison.id })
	assert.notEqual(v2.comparison.baseSha, v1.comparison.baseSha, 'the base moved')
	const offer = await svc.incrementalOffer(v2.comparison.id, MODEL)
	assert.ok(offer && offer.refused === null)
	assert.deepEqual(offer.review, [])
	sent.length = 0
	const run = await finished(ai, await svc.startAi(v2.comparison.id, { kind: 'changed' }, MODEL))
	assert.equal(run.status, 'completed', run.errors.join('; '))
	assert.equal(sent.length, 0)
	assert.deepEqual(
		run.coverage.files.map((f) => f.state),
		['carried', 'carried', 'carried'],
	)
	assert.equal(run.findings.length, 3)
})

test('a file the earlier run did not review fully, or did not review at all, is reviewed again', async () => {
	const { w, svc, ai, repoId } = await setup()
	const v1 = await svc.loadComparison(repoId, { kind: 'target', target })
	// Only two of the three files, as an "Unviewed" run would.
	await finished(ai, await svc.startAi(v1.comparison.id, { kind: 'files', fileKeys: ['a.ts', 'b.ts'] }, MODEL))
	w.run('checkout', '-q', 'topic')
	w.commit({ 'a.ts': w.file('a', 2) }, 'v2')
	w.run('checkout', '-q', 'main')
	const v2 = await svc.loadComparison(repoId, { kind: 'target', target, from: v1.comparison.id })
	const offer = await svc.incrementalOffer(v2.comparison.id, MODEL)
	assert.ok(offer && offer.refused === null)
	assert.deepEqual(offer.review.sort(), ['a.ts', 'c.ts'], 'c.ts was outside the earlier run, so it was never reviewed')
	assert.deepEqual(offer.carry, ['b.ts'])
})

test('an unchanged file whose added lines use a name whose definition changed is reviewed again; an edited body is not enough', async () => {
	const { w, svc, ai, inputs, repoId } = await setup()
	const lib = (sig: string, body: string) => `export function computeTotal(${sig}) {\n  return ${body}\n}\n`
	const caller = '// b\nimport { computeTotal } from "./a"\nexport const total = computeTotal(1, 2)\n'
	w.run('checkout', '-q', 'topic')
	w.commit({ 'a.ts': lib('a, b', 'a + b'), 'b.ts': caller }, 'v1 uses computeTotal')
	w.run('checkout', '-q', 'main')
	const v1 = await svc.loadComparison(repoId, { kind: 'target', target })
	await finished(ai, await svc.startAi(v1.comparison.id, { kind: 'all' }, MODEL))

	// Only the body changes: callers can't break, so b.ts carries.
	w.run('checkout', '-q', 'topic')
	w.commit({ 'a.ts': lib('a, b', 'b + a') }, 'v2 body')
	w.run('checkout', '-q', 'main')
	const v2 = await svc.loadComparison(repoId, { kind: 'target', target, from: v1.comparison.id })
	const body = await svc.incrementalOffer(v2.comparison.id, MODEL)
	assert.ok(body && body.refused === null)
	assert.deepEqual(body.review, ['a.ts'])
	assert.deepEqual(body.recheck, [])

	// The signature changes: b.ts calls it on an added line, so it is reviewed again and told why.
	w.run('checkout', '-q', 'topic')
	w.commit({ 'a.ts': lib('items', 'items.length') }, 'v3 signature')
	w.run('checkout', '-q', 'main')
	const v3 = await svc.loadComparison(repoId, { kind: 'target', target, from: v1.comparison.id })
	const sig = await svc.incrementalOffer(v3.comparison.id, MODEL)
	assert.ok(sig && sig.refused === null)
	assert.deepEqual(sig.review, ['a.ts', 'b.ts'])
	assert.deepEqual(sig.carry, ['c.ts'])
	assert.deepEqual(sig.recheck, [{ fileKey: 'b.ts', names: ['computeTotal'], changedIn: ['a.ts'] }])
	inputs.length = 0
	const run = await finished(ai, await svc.startAi(v3.comparison.id, { kind: 'changed' }, MODEL))
	assert.equal(run.status, 'completed', run.errors.join('; '))
	assert.equal(run.coverage.files.find((f) => f.fileKey === 'b.ts')?.state, 'reviewed')
	assert.deepEqual(run.rechecked, sig.recheck)
	assert.match(inputs.join('\n'), /added lines use `computeTotal`, whose definition changed since the run on \w{7} in a\.ts/)
})

test('a setting that makes the review deeper, off for the earlier run and on now, stops carrying; turning one off still carries', async () => {
	const { w, svc, ai, repoId } = await setup()
	// The fixture's runs have related code and double-checking off, and lookups on.
	let limits = {
		contextLines: 5,
		maxBatchChars: 100_000,
		maxRunChars: 1_000_000,
		relatedCode: false,
		lookups: true,
		verify: false,
		groupDuplicates: false,
	}
	ai.attachModels({ info: () => null, limits: () => limits, label: () => 'Fixture' })
	const v1 = await svc.loadComparison(repoId, { kind: 'target', target })
	const first = await finished(ai, await svc.startAi(v1.comparison.id, { kind: 'all' }, MODEL))
	assert.equal(first.status, 'completed', first.errors.join('; '))
	w.run('checkout', '-q', 'topic')
	w.commit({ 'a.ts': w.file('a', 2) }, 'v2')
	w.run('checkout', '-q', 'main')
	const v2 = await svc.loadComparison(repoId, { kind: 'target', target, from: v1.comparison.id })

	assert.equal((await svc.incrementalOffer(v2.comparison.id, MODEL))?.refused, null, 'the same settings carry')

	limits = { ...limits, relatedCode: true, verify: true }
	assert.match(
		(await svc.incrementalOffer(v2.comparison.id, MODEL))?.refused ?? '',
		/had related code and double-checking of blocking findings turned off, and they are on now/,
	)

	limits = { ...limits, relatedCode: false, verify: false, lookups: false }
	assert.equal((await svc.incrementalOffer(v2.comparison.id, MODEL))?.refused, null, 'a shallower review can build on a deeper one')
})
