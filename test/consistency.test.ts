import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { RunConfig } from '../src/main/ai/connections.ts'
import { consistencyFindings, MAX_CONSISTENCY_FINDINGS, summarize, variantRequest } from '../src/main/ai/consistency.ts'
import { AiController } from '../src/main/ai/controller.ts'
import { createFakeProvider } from '../src/main/ai/fake.ts'
import type { ProviderRequest } from '../src/main/ai/provider.ts'
import { buildVerifyRequest } from '../src/main/ai/verify.ts'
import { ReviewStore } from '../src/main/store.ts'
import type { AiRun, Anchor, ConsistencyRow, Finding, FindingVerification, GoneFinding } from '../src/shared/types.ts'

const anchor = (line: number): Anchor => ({
	repoId: 'r',
	baseSha: 'b',
	headSha: 'h',
	fileKey: 'src/a.ts',
	oldPath: 'src/a.ts',
	newPath: 'src/a.ts',
	side: 'new',
	startLine: line,
	endLine: line,
	excerpt: '',
})

const ok = (verdict: FindingVerification['verdict'], error = false) =>
	({ verdict, reason: 'r', level: null, checked: [], ...(error ? { error: true } : {}) }) as FindingVerification

const finding = (id: string, over: Partial<Finding> = {}): Finding =>
	({ id, title: `Problem ${id}`, severity: 'blocking', category: 'bug', body: 'b', evidence: 'e', anchor: anchor(10), ...over }) as Finding

const enumOf = (r: ProviderRequest) => (r.schema!.json as { properties: { verdict: { enum: Array<string> } } }).properties.verdict.enum
const order = (r: ProviderRequest) =>
	r.instructions
		.split('\n')
		.filter((l) => /^- "(wrong|holds|unsure)":/.test(l))
		.map((l) => /"(\w+)"/.exec(l)![1])
		.slice(0, 3) // the verdict's own lines; the reach check below them has an "unsure" too, left alone

test('variants of the real double-check: same request, reversed answers (text and schema), or framed as confirm', () => {
	for (const since of [null, 'abc1234567']) {
		const base = buildVerifyRequest(finding('f'), null, [], undefined, ['code'], since)
		assert.equal(variantRequest(base, 'as-is'), base)
		assert.equal(variantRequest(base, 'repeat'), base)

		const reversed = variantRequest(base, 'reversed')!
		assert.deepEqual(order(base), ['wrong', 'holds', 'unsure'])
		assert.deepEqual(order(reversed), ['unsure', 'holds', 'wrong'])
		assert.deepEqual(enumOf(reversed), [...enumOf(base)].reverse())
		assert.deepEqual(enumOf(base), ['holds', 'wrong', 'unsure'], 'the original schema is left alone')
		assert.equal(reversed.input, base.input)

		const reframed = variantRequest(base, 'reframed')!
		assert.match(reframed.instructions, /find out whether it is right before anyone acts on it/)
		assert.match(reframed.instructions, /- Try to confirm it\./)
		assert.doesNotMatch(reframed.instructions, /Try to disprove it/)
		assert.deepEqual(order(reframed), order(base), 'the verdict definitions stay word for word')
	}
	assert.equal(variantRequest({ instructions: 'something else', input: '', batch: {} as never }, 'reversed'), null)
	assert.equal(variantRequest({ instructions: 'something else', input: '', batch: {} as never }, 'reframed'), null)
})

test('findings: double-checks that answered, newest run first, then fixed checks with their snapshot; at most 8', () => {
	const gone = (id: string, check: FindingVerification | null): GoneFinding =>
		({ finding: finding(id), state: 'fixed', why: '', decision: null, comment: null, at: anchor(20), check }) as GoneFinding
	const runs = [
		{ status: 'completed', findings: [finding('old', { verification: ok('holds') })], history: null },
		{ status: 'failed', findings: [finding('failedrun', { verification: ok('holds') })] },
		{
			status: 'completed',
			findings: [
				finding('a', { verification: ok('wrong') }),
				finding('b', { verification: ok('holds', true) }), // the check itself failed
				finding('c'), // never checked
				finding('d', { verification: ok('holds'), mergedInto: 'a' }),
			],
			history: { from: { headSha: 'prev' }, gone: [gone('g', ok('wrong')), gone('h', null)] },
		},
	] as unknown as Array<AiRun>
	const picked = consistencyFindings(runs)
	assert.deepEqual(
		picked.map((p) => [p.finding.id, p.kind, p.since]),
		[
			['a', 'blocking', null],
			['old', 'blocking', null],
			['g', 'fixed', 'prev'],
		],
	)
	assert.equal(picked[2].finding.anchor.startLine, 20, 'a gone finding is asked about where it is now')
	const many = [{ status: 'completed', findings: Array.from({ length: 12 }, (_, i) => finding(`f${i}`, { verification: ok('holds') })) }]
	assert.equal(consistencyFindings(many as unknown as Array<AiRun>).length, MAX_CONSISTENCY_FINDINGS)
})

test('summary: each variant against as is, only where both answered; holds ↔ wrong counted apart', () => {
	const row = (a: string, repeat: string, reversed: string, reframed: string) =>
		({ verdicts: { 'as-is': a, repeat, reversed, reframed } }) as unknown as ConsistencyRow
	const s = summarize([
		row('holds', 'holds', 'wrong', 'holds'),
		row('wrong', 'wrong', 'unsure', 'failed'),
		row('failed', 'holds', 'holds', 'holds'),
	])
	assert.deepEqual(s, [
		{ variant: 'repeat', compared: 2, changed: 0, wrongHolds: 0, failed: 1 },
		{ variant: 'reversed', compared: 2, changed: 2, wrongHolds: 1, failed: 1 },
		{ variant: 'reframed', compared: 1, changed: 0, wrongHolds: 0, failed: 2 },
	])
})

test('controller: sends every variant per finding and reports the flips; refuses with nothing to check or over budget', async () => {
	const store = ReviewStore.in(mkdtempSync(join(tmpdir(), 'review-consistency-')))
	await store.load()
	const run = { id: 'run1', status: 'completed', findings: [finding('a', { verification: ok('holds') })] } as unknown as AiRun
	await store.update((d) => {
		d.repos.r = { repoId: 'r', root: '/x', selectedBase: null, activeReviewId: 'rv', reviews: {}, aiRuns: { rv: [run] } }
	})
	// A model that always picks the first answer the schema lists: exactly the order effect this measures.
	const sent: Array<ProviderRequest> = []
	const provider = createFakeProvider({
		script: (req) => {
			sent.push(req)
			return { verdict: enumOf(req)[0], reason: 'r', level: null, checked: [], reach: null }
		},
	})
	const config = async (): Promise<RunConfig> => ({
		provider,
		connectionId: 'c',
		connectionLabel: 'Fixture',
		endpoint: 'fixture://local',
		limits: { contextLines: 5, maxBatchChars: 100_000, maxRunChars: 1_000_000, verify: false, relatedCode: false },
	})
	const ai = new AiController(store, config, () => {})
	const access = {
		comparison: { repoId: 'r', files: [] },
		loadPatch: async () => ({ kind: 'binary' }),
		loadFileLines: async () => ({ kind: 'binary' }),
	} as unknown as Parameters<AiController['checkConsistency']>[0]
	const sel = { connectionId: 'c', modelId: 'm' }

	assert.deepEqual(ai.consistencyPlan('r', 'rv'), { findings: 1, requests: 4 })
	const report = await ai.checkConsistency(access, 'rv', sel)
	assert.equal(sent.length, 4)
	assert.equal(sent.filter((r) => r.tools).length, 0, 'no lookups: every variant reads the same code')
	assert.deepEqual(report.rows[0].verdicts, { 'as-is': 'holds', repeat: 'holds', reversed: 'unsure', reframed: 'holds' })
	assert.deepEqual(report.variants[1], { variant: 'reversed', compared: 1, changed: 1, wrongHolds: 0, failed: 0 })
	assert.equal(report.model, 'm')

	ai.attachBudget({ active: () => true, check: () => ({ over: ['Daily budget reached.'], limit: null }) as never })
	await assert.rejects(ai.checkConsistency(access, 'rv', sel), /Daily budget reached/)
	assert.equal(sent.length, 4, 'nothing sent over budget')

	await store.update((d) => void (d.repos.r.aiRuns.rv = []))
	await assert.rejects(ai.checkConsistency(access, 'rv', sel), /no double-checked findings/)
})
