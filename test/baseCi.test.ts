import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildEvidence, supportFor, uncoveredCi } from '../src/main/ai/evidence.ts'
import type { FileSource } from '../src/main/ai/context.ts'
import { ciFact, loadFacts } from '../src/main/ai/facts.ts'
import { autoVerdict } from '../src/main/autoReview.ts'
import { markPreExisting, readBaseChecks, type BaseChecks } from '../src/main/baseCi.ts'
import type { CommitChecks } from '../src/main/github.ts'
import { tallyChecks, type HeadChecks } from '../src/shared/ci.ts'
import type { AiRun, CiAnnotation, Finding, Review } from '../src/shared/types.ts'

const checks = (sha: string, runs: Array<[string, string]>, statuses: Array<[string, string]> = []): CommitChecks => ({
	sha,
	runs: runs.map(([name, result], i) => ({ id: i + 1, annotations: 0, name, app: 'GitHub Actions', result })),
	runsOmitted: 0,
	statuses: statuses.map(([name, result]) => ({ name, result, description: null })),
})

const HEAD = checks(
	'h'.repeat(40),
	[
		['unit', 'failure'],
		['lint', 'failure'],
		['e2e', 'failure'],
		['build', 'success'],
	],
	[['legacy', 'error']],
)
const BASE: BaseChecks = {
	control: { sha: 'b'.repeat(40), back: 0 },
	checks: checks(
		'b'.repeat(40),
		[
			['unit', 'success'],
			['lint', 'failure'],
			['e2e', 'in_progress'],
		],
		[['legacy', 'failure']],
	),
}

test('each head failure says whether it also fails, or passes, at the base; unmatched or unfinished ones stay unmarked', () => {
	const t = tallyChecks(HEAD, BASE)
	assert.deepEqual(Object.fromEntries(t.failed.map((f) => [f.name, f.atBase])), {
		unit: 'passes',
		lint: 'fails',
		e2e: null,
		legacy: 'fails',
	})
	assert.deepEqual(t.base, BASE.control)
	assert.equal(tallyChecks(HEAD).failed[0].atBase, undefined, 'without a base nothing is marked')

	// A check run and a commit status with the same name are different checks; a different app is a different check.
	const other = tallyChecks(checks('h'.repeat(40), [['legacy', 'failure']]), BASE)
	assert.equal(other.failed[0].atBase, null)
	const app = tallyChecks({ ...HEAD, runs: [{ id: 1, annotations: 0, name: 'lint', app: 'Other', result: 'failure' }], statuses: [] }, BASE)
	assert.equal(app.failed[0].atBase, null)
})

test('the CI fact tells the reviewer which failures the base has too, and that those are not evidence', () => {
	const f = ciFact(HEAD, BASE)
	assert.match(f.fact.text, /compared with the same check on base bbbbbbb.*not evidence against the change/s)
	assert.match(f.fact.text, /- unit: failure, passes at bbbbbbb\n/)
	assert.match(f.fact.text, /- lint: failure, also fails at bbbbbbb\n/)
	assert.match(f.fact.text, /- e2e: failure\n/, 'no finished result at base: unmarked')
	assert.match(f.summary, /4 failed \(2 also at the base commit\)/)
	assert.doesNotMatch(ciFact(HEAD).fact.text, /also fails|compared with/, 'unchanged without a base')
})

function repo() {
	const dir = mkdtempSync(join(tmpdir(), 'review-baseci-'))
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
	return { dir, git, commit }
}

test('without finished CI on the merge base, the nearest first-parent commit before it with results is the control', async () => {
	const r = repo()
	const shas = Array.from({ length: 8 }, (_, i) => r.commit({ 'a.txt': `${i}\n` }, `c${i}`)).reverse() // newest first
	const asked: Array<string> = []
	const results: Record<string, CommitChecks> = {
		[shas[0]]: checks(shas[0], [['unit', 'queued']]), // nothing finished yet
		[shas[2]]: checks(shas[2], [['unit', 'failure']]),
	}
	const read = async (sha: string) => {
		asked.push(sha)
		if (sha === shas[1]) throw new Error('No commit found for SHA') // GitHub doesn't know it: skipped
		return results[sha] ?? checks(sha, [])
	}
	const found = await readBaseChecks(r.dir, shas[0], read)
	assert.deepEqual(found?.control, { sha: shas[2], back: 2 })
	assert.deepEqual(asked, shas.slice(0, 3))

	asked.length = 0
	assert.equal(await readBaseChecks(r.dir, shas[0], async (sha) => (asked.push(sha), checks(sha, []))), null)
	assert.equal(asked.length, 6, 'the merge base and five before it')

	await assert.rejects(
		readBaseChecks(r.dir, shas[0], async () => {
			throw new Error('rate limited')
		}),
		/rate limited/,
		'other errors are not "no CI"',
	)
})

test('a head annotation is pre-existing when the base has the same message on the same unchanged lines', async () => {
	const r = repo()
	const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
	const base = r.commit({ 'a.ts': lines.join('\n') + '\n' }, 'base')
	const changed = [...lines]
	changed[7] = 'line 8 edited'
	const head = r.commit({ 'a.ts': ['// one', '// two', ...changed].join('\n') + '\n' }, 'head') // two lines above, line 8 edited
	const ann = (startLine: number, message: string, over: Partial<CiAnnotation> = {}): CiAnnotation => ({
		check: 'lint',
		path: 'a.ts',
		startLine,
		endLine: startLine,
		level: 'warning',
		title: null,
		message,
		...over,
	})
	const atHead = [
		ann(5, 'unused variable'), // line 3 at base: same message, unchanged
		ann(10, 'too long'), // line 8 at base, which changed
		ann(6, 'something new'), // line 4 at base, different message
		ann(7, 'unused variable', { check: 'types' }), // another check
	]
	const control: BaseChecks = {
		control: { sha: base, back: 0 },
		checks: { sha: base, runs: [{ id: 9, annotations: 3, name: 'lint', app: null, result: 'failure' }], runsOmitted: 0, statuses: [] },
	}
	const fetched: Array<number> = []
	const out = await markPreExisting(r.dir, head, atHead, control, async (id) => {
		fetched.push(id)
		return [
			{ path: 'a.ts', startLine: 3, endLine: 3, level: 'warning', title: null, message: 'unused variable' },
			{ path: 'a.ts', startLine: 8, endLine: 8, level: 'warning', title: null, message: 'too long' },
			{ path: 'a.ts', startLine: 5, endLine: 5, level: 'warning', title: null, message: 'unused variable' },
		]
	})
	assert.deepEqual(fetched, [9], 'only the checks that annotated the head are read at the base')
	assert.deepEqual(
		out.annotations.map((a) => a.atBase ?? null),
		[base, null, null, null],
	)
})

test('a pre-existing CI message is context on a finding, not support, and never an uncovered failure', () => {
	const sources = [
		{
			file: {
				key: 'a.ts',
				status: 'modified',
				oldPath: 'a.ts',
				newPath: 'a.ts',
				additions: 1,
				deletions: 0,
				binary: false,
				similarity: null,
			},
			patch: {
				kind: 'text',
				hunks: [
					{ oldStart: 1, oldLines: 0, newStart: 5, newLines: 1, section: '', lines: [{ kind: 'add', oldNo: null, newNo: 5, text: 'x' }] },
				],
			},
			fullText: null,
		},
	] as unknown as Parameters<typeof buildEvidence>[0]
	const msg = (atBase: string | null): CiAnnotation => ({
		check: 'lint',
		path: 'a.ts',
		startLine: 5,
		endLine: 5,
		level: 'failure',
		title: null,
		message: 'bad',
		atBase,
	})
	const f = { anchor: { side: 'new', newPath: 'a.ts', oldPath: 'a.ts', fileKey: 'a.ts', startLine: 5, endLine: 5 } } as Finding
	const fresh = supportFor(f, buildEvidence(sources, [msg(null)], null))
	assert.equal(fresh[0].strength, 'flags')
	const old = supportFor(f, buildEvidence(sources, [msg('c'.repeat(40))], null))
	assert.equal(old[0].strength, 'context')
	assert.match(old[0].text, /also at ccccccc before this change/)
	assert.equal(uncoveredCi([], buildEvidence(sources, [msg(null)], null)).length, 1)
	assert.equal(uncoveredCi([], buildEvidence(sources, [msg('c'.repeat(40))], null)).length, 0)
})

test('automatic review still holds back an approval on a failure the base has too, and says so', () => {
	const run = { id: 'r', status: 'completed', findings: [], errors: [] } as unknown as AiRun
	const review = { id: 'b..h', comments: [], drafts: [], findingDecisions: {} } as unknown as Review
	const who = { reviewer: 'm', viewer: null }
	const ci = (failed: HeadChecks['failed']): HeadChecks => ({
		sha: 'h',
		failed,
		base: { sha: 'b'.repeat(40), back: 1 },
		pending: [],
		passed: 1,
		omitted: 0,
		readAt: 't',
	})
	const old = autoVerdict(run, review, [run], 0, who, ci([{ name: 'lint', at: null, atBase: 'fails' }]))
	assert.equal(old.event, 'COMMENT')
	assert.match(
		old.body,
		/CI failed on this commit \(lint\), so this is not an approval\. It also fails at bbbbbbb, 1 commit before the merge base, so this change didn't cause it\./,
	)
	const mixed = autoVerdict(
		run,
		review,
		[run],
		0,
		who,
		ci([
			{ name: 'unit', at: null, atBase: 'passes' },
			{ name: 'lint', at: null, atBase: 'fails' },
		]),
	)
	assert.match(mixed.body, /\(unit and 1 more\), so this is not an approval\. 1 of them also fails at bbbbbbb/)
	const fresh = autoVerdict(run, review, [run], 0, who, ci([{ name: 'unit', at: null, atBase: 'passes' }]))
	assert.doesNotMatch(fresh.body, /also fails/)
})

test('the facts compare head CI and its annotations with the base; a base that cannot be read changes nothing but a note', async () => {
	const r = repo()
	const base = r.commit({ 'a.ts': 'one\ntwo\n' }, 'base')
	const head = r.commit({ 'a.ts': 'one\ntwo\nthree\n' }, 'head')
	const source = {
		file: {
			key: 'a.ts',
			status: 'modified',
			oldPath: 'a.ts',
			newPath: 'a.ts',
			additions: 1,
			deletions: 0,
			binary: false,
			similarity: null,
		},
		patch: { kind: 'binary' },
		fullText: null,
	} as unknown as FileSource
	const headChecks: CommitChecks = {
		sha: head,
		runs: [{ id: 1, annotations: 1, name: 'lint', app: 'GitHub Actions', result: 'failure' }],
		runsOmitted: 0,
		statuses: [],
	}
	const control: BaseChecks = {
		control: { sha: base, back: 0 },
		checks: { ...headChecks, sha: base, runs: [{ ...headChecks.runs[0], id: 2 }] },
	}
	const note = { path: 'a.ts', startLine: 2, endLine: 2, level: 'warning' as const, title: null, message: 'old' }
	const facts = (baseChecks: () => Promise<BaseChecks | null>) =>
		loadFacts({
			root: r.dir,
			baseSha: base,
			headSha: head,
			sources: [source],
			checks: async () => headChecks,
			annotations: async () => [note],
			baseChecks,
		})
	const compared = await facts(async () => control)
	assert.match(compared.facts.find((f) => f.title === 'CI results')!.text, /- lint: failure, also fails at /)
	assert.equal(compared.annotations[0].atBase, base)
	assert.ok(compared.summary.some((s) => /1 also at the base commit/.test(s.text)))

	const unread = await facts(async () => {
		throw new Error('rate limited')
	})
	assert.match(unread.facts.find((f) => f.title === 'CI results')!.text, /- lint: failure\n/)
	assert.equal(unread.annotations[0].atBase, undefined)
	assert.ok(unread.notes.some((n) => /CI of the base commit could not be read.*rate limited/.test(n)))
})
