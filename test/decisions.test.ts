import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FileSource } from '../src/main/ai/context.ts'
import { decisionFacts } from '../src/main/ai/decisions.ts'
import { createFakeProvider, emptyEvaluation } from '../src/main/ai/fake.ts'
import { startRun } from '../src/main/ai/runner.ts'
import { reviewUpdate } from '../src/main/validate.ts'
import { setDismissNote, setFindingDecision } from '../src/renderer/src/reviewOps.ts'
import { blockingSummary, findingRoots } from '../src/shared/findings.ts'
import type { AiRun, ChangedFile, Comparison, Finding, PastDecision, Review } from '../src/shared/types.ts'

const BASE = 'a'.repeat(40)
const HEAD = 'b'.repeat(40)

function review(): Review {
	return {
		id: `${BASE}..${HEAD}`,
		repoId: '/repo',
		baseRef: 'main',
		baseTipSha: BASE,
		baseSha: BASE,
		headSha: HEAD,
		headRef: 'topic',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		comments: [],
		drafts: [],
		viewed: [],
		findingDecisions: {},
	}
}

test('a dismissal keeps its reason and note; restoring drops them; the note can be added later; bad reasons are refused', () => {
	let r = setFindingDecision(review(), 'f1', 'dismissed', { reason: 'handled-elsewhere' })
	assert.equal(r.findingDecisions.f1.reason, 'handled-elsewhere')
	assert.equal(r.findingDecisions.f1.note, null)
	r = setDismissNote(r, 'f1', '  Escaped by the template engine  ')
	assert.equal(r.findingDecisions.f1.note, 'Escaped by the template engine')
	assert.equal(setDismissNote(r, 'f2', 'no decision, no note'), r)

	const known = new Map([['f1', 'f1']])
	const saved = reviewUpdate(r, review(), known)
	assert.deepEqual(
		{ reason: saved.findingDecisions.f1.reason, note: saved.findingDecisions.f1.note },
		{ reason: 'handled-elsewhere', note: 'Escaped by the template engine' },
	)
	const restored = setFindingDecision(r, 'f1', 'open')
	assert.equal(restored.findingDecisions.f1.reason, undefined)
	assert.throws(
		() =>
			reviewUpdate(
				{ ...r, findingDecisions: { f1: { status: 'dismissed', decidedAt: new Date().toISOString(), reason: 'meh' } } },
				review(),
				known,
			),
		/dismiss reason/,
	)
})

function changed(path: string): ChangedFile {
	return { key: path, status: 'modified', oldPath: path, newPath: path, additions: 1, deletions: 1, binary: false, similarity: null }
}

const SOURCES: Array<FileSource> = ['src/view.ts', 'src/other.ts'].map(
	(p) =>
		({
			file: changed(p),
			patch: {
				kind: 'text',
				hunks: [
					{
						oldStart: 1,
						oldLines: 1,
						newStart: 1,
						newLines: 1,
						section: '',
						lines: [
							{ kind: 'del', oldNo: 1, newNo: null, text: 'render(name)' },
							{ kind: 'add', oldNo: null, newNo: 1, text: 'render(user.name)' },
						],
					},
				],
			},
			fullText: null,
		}) as FileSource,
)

const DECISIONS: Array<PastDecision> = [
	{
		path: 'src/view.ts',
		line: 12,
		title: 'Name printed without escaping',
		category: 'security',
		reason: 'handled-elsewhere',
		note: 'The template engine escapes every value.',
		decidedAt: '2026-10-01T10:00:00.000Z',
	},
	{
		path: 'src/gone.ts',
		line: 3,
		title: 'Not in this change',
		category: 'bug',
		reason: 'wrong',
		note: null,
		decidedAt: '2026-10-01T09:00:00.000Z',
	},
]

test('earlier dismissals reach the next run with the file they are about, in the reviewer’s words', async () => {
	const facts = decisionFacts(DECISIONS, SOURCES)
	assert.deepEqual(facts, [
		{
			kind: 'decisions',
			title: 'Findings the reviewer dismissed earlier on src/view.ts',
			text: '- "Name printed without escaping" near line 12 (in the version reviewed then), security: dismissed as handled elsewhere. Reviewer\'s note: "The template engine escapes every value."',
			fileKeys: ['src/view.ts'],
		},
	])

	const inputs: Array<string> = []
	const comparison: Comparison = {
		id: `${BASE}..${HEAD}`,
		repoId: '/repo',
		baseRef: 'main',
		baseTipSha: BASE,
		baseSha: BASE,
		headSha: HEAD,
		headRef: 'topic',
		target: null,
		pr: null,
		files: SOURCES.map((s) => s.file),
	}
	const run = await startRun(
		{
			reviewId: comparison.id,
			comparison,
			scope: { kind: 'all' },
			loadSources: async () => SOURCES,
			previousFindings: [],
			decisions: DECISIONS,
		},
		{
			provider: createFakeProvider({
				script: (req) => {
					inputs.push(req.input)
					return { findings: [], evaluation: emptyEvaluation(), unexplained_files: [], limitations: [] }
				},
			}),
			limits: { contextLines: 3, maxBatchChars: 100_000, maxRunChars: 1_000_000 },
			concurrency: 1,
			maxAttempts: 1,
			backoffMs: () => 0,
		},
		() => {},
	).done
	assert.equal(run.status, 'completed')
	assert.match(inputs[0], /## Findings the reviewer dismissed earlier on src\/view\.ts\n- "Name printed without escaping"/)
	assert.doesNotMatch(inputs[0], /Not in this change/, 'a file outside the change is not mentioned')
	assert.ok(
		run.coverage.facts!.some((f) => f.kind === 'decisions' && /1 finding you dismissed on earlier runs, on 1 changed file/.test(f.text)),
	)
})

test('the publish summary counts each blocking finding once: added, undecided (with the double-check), dismissed', () => {
	const mk = (id: string, over: Partial<Finding> = {}): Finding =>
		({
			id,
			runId: 'r',
			excerptId: 'E1',
			anchor: {
				repoId: '/repo',
				baseSha: BASE,
				headSha: HEAD,
				fileKey: 'a.ts',
				oldPath: 'a.ts',
				newPath: 'a.ts',
				side: 'new',
				startLine: 1,
				endLine: 1,
				excerpt: '',
			},
			severity: 'blocking',
			title: id,
			evidence: 'x',
			repeatOf: null,
			...over,
		}) as Finding
	const verified = (verdict: 'holds' | 'wrong') => ({ verification: { verdict, reason: '', level: null, checked: [], model: 'm' } })
	const first = { id: 'r1', findings: [mk('a'), mk('b'), mk('c')] } as AiRun
	const second = {
		id: 'r2',
		findings: [
			mk('a2', { repeatOf: 'a', ...verified('holds') }), // the same as a, newer: its double-check counts
			mk('d', verified('wrong')),
			mk('e', { severity: 'should_fix' }),
			mk('f', { mergedInto: 'd' }),
			mk('g', { heldBack: 'over the limit' }),
		],
	} as AiRun
	const runs = [first, second]
	const roots = findingRoots(runs)
	let r = setFindingDecision(review(), 'b', 'dismissed', { reason: 'wrong' })
	r = { ...r, comments: [{ id: 'k', findingId: 'c' } as Review['comments'][number]] }
	assert.deepEqual(blockingSummary(r, runs, roots), { added: 1, open: 2, openHolds: 1, openWrong: 1, dismissed: 1 })
})
