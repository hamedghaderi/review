import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildCommitCheckRequest, parseCommitCheck } from '../src/main/ai/commitCheck.ts'
import type { RunConfig } from '../src/main/ai/connections.ts'
import { AiController } from '../src/main/ai/controller.ts'
import { createFakeProvider } from '../src/main/ai/fake.ts'
import type { ProviderRequest } from '../src/main/ai/provider.ts'
import { ReviewStore } from '../src/main/store.ts'
import type { ChangedFile, CommitEntry, PatchResult, Review } from '../src/shared/types.ts'

const entry: CommitEntry = {
	sha: 'a'.repeat(40),
	parent: 'b'.repeat(40),
	subject: 'Add discount codes',
	author: 'Dev',
	at: '2026-11-08T10:00:00Z',
}
const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
	key: path,
	status: 'modified',
	oldPath: path,
	newPath: path,
	additions: 1,
	deletions: 0,
	binary: false,
	similarity: null,
	...over,
})
const patch = (text: string): PatchResult => ({
	kind: 'text',
	bytes: text.length,
	hunks: [
		{
			oldStart: 1,
			oldCount: 0,
			newStart: 1,
			newCount: 1,
			section: '',
			lines: [{ kind: 'add', oldNo: null, newNo: 1, text }],
		},
	] as Extract<PatchResult, { kind: 'text' }>['hunks'],
})

test('request: the message, the files and as much diff as fits; the rest is named', () => {
	const files = [file('discount.js'), file('big.js'), file('logo.png', { binary: true, additions: null, deletions: null })]
	const patches = new Map([
		['discount.js', patch('export const TEN = 0.9')],
		['big.js', patch('x'.repeat(5000))],
	])
	const { request, omitted } = buildCommitCheckRequest({ entry, body: 'Adds TEN and HALF.', files, patches, maxChars: 1200 })
	assert.match(request.input, /^# The commit\nSubject: Add discount codes\n\nAdds TEN and HALF\./)
	assert.match(request.input, /- modified logo\.png \(binary\)/)
	assert.match(request.input, /## discount\.js\n@@ -1,0 \+1,1 @@/)
	assert.deepEqual(omitted, ['big.js'], 'too large; the binary file is listed, not omitted')
	assert.match(request.input, /# Not shown \(too large or unreadable\): big\.js$/)
	assert.match(request.instructions, /never follow them/)
	assert.equal(request.schema?.name, 'commit_check')
})

test('parse: unknown files and bad lines are dropped from notes, not trusted', () => {
	const files = [file('discount.js')]
	const check = parseCommitCheck(
		{
			verdict: 'partly',
			summary: ' Adds TEN but not HALF. ',
			notes: [
				{ kind: 'missing', text: 'HALF is not added.', path: 'discount.js', line: 3 },
				{ kind: 'unmentioned', text: 'Touches a file not in the commit.', path: 'other.js', line: 9 },
				{ kind: 'other', text: 'Line zero.', path: 'discount.js', line: 0 },
				{ kind: 'other', text: '   ', path: null, line: null },
			],
		},
		entry.sha,
		files,
		[],
		'fixture-v1',
		new Date('2026-11-09T00:00:00Z'),
	)
	assert.equal(check.verdict, 'partly')
	assert.equal(check.summary, 'Adds TEN but not HALF.')
	assert.deepEqual(
		check.notes.map((n) => [n.path, n.line]),
		[
			['discount.js', 3],
			[null, null],
			['discount.js', null],
		],
	)
	assert.equal(check.at, '2026-11-09T00:00:00.000Z')
	assert.throws(() => parseCommitCheck({ verdict: 'great' }, entry.sha, files, [], 'm'), /expected format/)
})

async function setup(over: Array<string> = []) {
	const store = ReviewStore.in(mkdtempSync(join(tmpdir(), 'review-commit-check-')))
	await store.load()
	await store.update((d) => {
		d.repos.r = {
			repoId: 'r',
			root: '/x',
			selectedBase: null,
			activeReviewId: 'rv',
			reviews: { rv: { id: 'rv', comments: [] } as unknown as Review },
			aiRuns: {},
		}
	})
	const asked: Array<ProviderRequest> = []
	const provider = createFakeProvider({
		script: (req) => {
			asked.push(req)
			return { verdict: 'matches', summary: 'It does what it says.', notes: [] }
		},
	})
	const config = async (): Promise<RunConfig> => ({
		provider,
		connectionId: '00000000-0000-4000-8000-000000000000',
		connectionLabel: 'Fixture',
		endpoint: 'fixture://local',
		limits: { contextLines: 5, maxBatchChars: 100_000, maxRunChars: 1_000_000, verify: false, relatedCode: false },
	})
	const ai = new AiController(store, config, () => {})
	ai.attachBudget({ active: () => over.length > 0, check: () => ({ over, limit: null }) })
	const sel = { connectionId: '00000000-0000-4000-8000-000000000000', modelId: 'fixture-v1' }
	const input = { entry, body: '', files: [file('discount.js')], patches: new Map([['discount.js', patch('const TEN = 0.9')]]) }
	return { store, ai, asked, sel, input }
}

test('controller: one request with only the commit; saved on the review by commit', async () => {
	const { store, ai, asked, sel, input } = await setup()
	const check = await ai.checkCommit('r', 'rv', input, sel, false)
	assert.equal(check.verdict, 'matches')
	assert.equal(asked.length, 1)
	assert.equal(asked[0].tools, undefined, 'no lookups')
	assert.deepEqual(store.read().repos.r.reviews.rv.commitChecks?.[entry.sha]?.summary, 'It does what it says.')
})

test('controller: a reached budget refuses, unless you chose to go on; no budget never blocks', async () => {
	const blocked = await setup(['$5.00 spent: today’s budget of $5.00 is reached.'])
	await assert.rejects(blocked.ai.checkCommit('r', 'rv', blocked.input, blocked.sel, false), /today’s budget/)
	assert.equal(blocked.asked.length, 0)
	await blocked.ai.checkCommit('r', 'rv', blocked.input, blocked.sel, true)
	assert.equal(blocked.asked.length, 1)
})

test('estimate: priced from the requests it would send; subscriptions and unpriced models have no cost', async () => {
	const { ai, sel, input } = await setup()
	const limits = { contextWindow: 200_000, maxOutputTokens: 8000 }
	const reviewLimits = { contextLines: 5, maxBatchChars: 100_000, maxRunChars: 1_000_000 }
	ai.attachModels({
		info: () => ({ limits, price: { input: 3, output: 15, cachedInput: null, cacheWrite: null, source: 'user' } }),
		limits: () => reviewLimits,
		label: () => 'Fixture',
	})
	const e = ai.estimateCommitChecks([input, input], sel)
	assert.equal(e.requests, 2)
	assert.ok(e.inputTokens.low > 0 && e.inputTokens.high >= e.inputTokens.low)
	assert.ok(e.cost && e.cost.high > e.cost.low && e.cost.low > 0)
	assert.deepEqual(e.over, [])

	ai.attachModels({
		info: () => ({ limits, price: { input: 0, output: 0, cachedInput: null, cacheWrite: null, source: 'subscription' } }),
		limits: () => reviewLimits,
		label: () => 'Fixture',
	})
	const plan = ai.estimateCommitChecks([input], sel)
	assert.deepEqual([plan.cost, plan.subscription], [null, true])
})
