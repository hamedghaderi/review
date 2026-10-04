import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { FileSource } from '../src/main/ai/context.ts'
import { buildEvidence, supportFor } from '../src/main/ai/evidence.ts'
import { createFakeProvider, defaultScript } from '../src/main/ai/fake.ts'
import { loadFacts } from '../src/main/ai/facts.ts'
import type { RelatedResult } from '../src/main/ai/related.ts'
import { startRun } from '../src/main/ai/runner.ts'
import { GitHubService, type TokenStore } from '../src/main/github.ts'
import type { ChangedFile, Comparison, Finding } from '../src/shared/types.ts'

function added(path: string, lines: Array<string>): FileSource {
	const file: ChangedFile = {
		key: path,
		status: 'added',
		oldPath: null,
		newPath: path,
		additions: lines.length,
		deletions: 0,
		binary: false,
		similarity: null,
	}
	return {
		file,
		patch: {
			kind: 'text',
			hunks: [
				{
					oldStart: 0,
					oldLines: 0,
					newStart: 1,
					newLines: lines.length,
					section: '',
					lines: lines.map((text, i) => ({ kind: 'add' as const, oldNo: null, newNo: i + 1, text })),
				},
			],
		},
		fullText: null,
	} as FileSource
}

const CART = Array.from({ length: 12 }, (_, i) => (i === 0 ? 'export function total(items) {' : `  const step${i} = ${i}`))
const SOURCES = [added('src/cart.ts', CART), added('test/cart.test.ts', ["import { total } from '../src/cart'", 'total([])'])]
const RELATED: RelatedResult = {
	snippets: [],
	symbols: 0,
	notes: [],
	importers: [{ fileKey: 'src/cart.ts', path: 'src/cart.ts', importers: [], tests: ['test/cart.test.ts'], stale: [] }],
}

function tokens(): TokenStore {
	return {
		async get() {
			return null
		},
		peek: () => 'none',
		async remove() {},
		storageInfo: () => ({ backend: 'test', persistent: false, encrypted: false }),
	} as unknown as TokenStore
}

test('CI line messages reach the reviewer, back up the findings on those lines, and the rest are listed as not covered', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'review-evidence-'))
	execFileSync('git', ['init', '-q'], { cwd: dir })
	const head = 'b'.repeat(40)
	const seen: Array<string> = []
	const server = http.createServer((req, res) => {
		seen.push(req.url!)
		res.writeHead(200, { 'content-type': 'application/json' })
		if (req.url!.includes('/check-runs/7/annotations'))
			res.end(
				JSON.stringify([
					{
						path: 'src/cart.ts',
						start_line: 1,
						end_line: 1,
						annotation_level: 'failure',
						title: 'TS2554',
						message: 'Expected 2 arguments, but got 1.',
					},
					{
						path: 'src/cart.ts',
						start_line: 9,
						end_line: 9,
						annotation_level: 'warning',
						title: null,
						message: "'step8' is assigned a value but never used.",
					},
					{ path: 'README.md', start_line: 1, end_line: 1, annotation_level: 'failure', title: null, message: 'Not part of the change.' },
				]),
			)
		else if (req.url!.includes('/check-runs'))
			res.end(
				JSON.stringify({
					total_count: 2,
					check_runs: [
						{
							id: 7,
							name: 'typecheck',
							status: 'completed',
							conclusion: 'failure',
							app: { name: 'GitHub Actions' },
							output: { annotations_count: 3 },
						},
						{
							id: 8,
							name: 'build',
							status: 'completed',
							conclusion: 'success',
							app: { name: 'GitHub Actions' },
							output: { annotations_count: 0 },
						},
					],
				}),
			)
		else res.end(JSON.stringify({ statuses: [] }))
	})
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
	const gh = new GitHubService(tokens(), { base: `http://127.0.0.1:${(server.address() as { port: number }).port}` })
	try {
		const comparison: Comparison = {
			id: `${'a'.repeat(40)}..${head}`,
			repoId: 'r',
			baseRef: 'main',
			baseTipSha: 'a'.repeat(40),
			baseSha: 'a'.repeat(40),
			headSha: head,
			headRef: 'topic',
			target: null,
			pr: null,
			files: SOURCES.map((s) => s.file),
		}
		const inputs: Array<string> = []
		const run = await startRun(
			{
				reviewId: comparison.id,
				comparison,
				scope: { kind: 'all' },
				loadSources: async () => SOURCES,
				loadRelated: async () => RELATED,
				loadFacts: (sources, signal) =>
					loadFacts({
						root: dir,
						baseSha: comparison.baseSha,
						headSha: head,
						sources,
						checks: () => gh.checks('octo/app', head, signal),
						annotations: (id) => gh.annotations('octo/app', id, signal),
						signal,
					}),
				previousFindings: [],
			},
			{
				// The fixture reports a bug on the first changed line of each file.
				provider: createFakeProvider({
					script: (req) => {
						inputs.push(req.input)
						return defaultScript(req)
					},
				}),
				limits: { contextLines: 5, maxBatchChars: 100_000, maxRunChars: 1_000_000, relatedCode: true, lookups: false },
				concurrency: 1,
				maxAttempts: 1,
				backoffMs: () => 1,
			},
			() => {},
		).done
		assert.equal(run.status, 'completed', run.errors.join('; '))
		assert.ok(!seen.some((u) => u.includes('/check-runs/8/annotations')), 'checks without annotations are not asked')

		// Before the review: the messages on changed files, not the one on README.md.
		assert.match(
			inputs[0],
			/## CI annotations on src\/cart\.ts\n- typecheck \(failure\) at line 1: TS2554: Expected 2 arguments, but got 1\./,
		)
		assert.doesNotMatch(inputs[0], /Not part of the change/)
		assert.ok(run.coverage.facts!.some((f) => f.text === '2 CI annotations on changed files (1 failure).'))

		// After: the finding on line 1 is backed by the typecheck failure, and its file's test is named.
		const cart = run.findings.find((f) => f.anchor.newPath === 'src/cart.ts')!
		assert.deepEqual(cart.support, [
			{ source: 'ci', strength: 'flags', text: 'typecheck (failure) at line 1: TS2554: Expected 2 arguments, but got 1.' },
			{ source: 'tests', strength: 'context', text: 'Imported by 1 test file: test/cart.test.ts; it is changed in this change.' },
		])
		// The warning on line 9 is on an added line with no finding near it.
		assert.deepEqual(
			run.ciUncovered!.map((a) => `${a.path}:${a.startLine} ${a.level}`),
			['src/cart.ts:9 warning'],
		)
	} finally {
		await new Promise<void>((r) => server.close(() => r()))
	}
})

test('test evidence: a code file no test imports says so; without an import trace nothing is claimed', () => {
	const f = {
		anchor: {
			repoId: 'r',
			baseSha: 'a',
			headSha: 'b',
			fileKey: 'src/pay.ts',
			oldPath: null,
			newPath: 'src/pay.ts',
			side: 'new',
			startLine: 3,
			endLine: 3,
			excerpt: '',
		},
	} as unknown as Finding
	const sources = [added('src/pay.ts', ['a', 'b', 'c'])]
	assert.deepEqual(supportFor(f, buildEvidence(sources, [], [])), [
		{ source: 'tests', strength: 'context', text: 'No test file imports this file, as far as import lines show.' },
	])
	assert.deepEqual(supportFor(f, buildEvidence(sources, [], null)), [])
})
