import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { RunConfig } from '../src/main/ai/connections.ts'
import { AiController } from '../src/main/ai/controller.ts'
import { createFakeProvider } from '../src/main/ai/fake.ts'
import type { ProviderRequest } from '../src/main/ai/provider.ts'
import { buildSummaryRequest, parseSummary, summaryInput, summaryInstructions } from '../src/main/ai/summary.ts'
import { ReviewStore } from '../src/main/store.ts'
import { findingCommentBody } from '../src/shared/findings.ts'
import type { AiRun, Anchor, Finding, Review, ReviewComment } from '../src/shared/types.ts'

const anchor = (over: Partial<Anchor> = {}): Anchor => ({
	repoId: 'r',
	baseSha: 'b',
	headSha: 'h',
	fileKey: 'src/cart.ts',
	oldPath: 'src/cart.ts',
	newPath: 'src/cart.ts',
	side: 'new',
	startLine: 12,
	endLine: 12,
	excerpt: '',
	...over,
})

const comment = (id: string, body: string, over: Partial<ReviewComment> = {}): ReviewComment => ({
	id,
	anchor: anchor(),
	body,
	createdAt: 't',
	updatedAt: 't',
	findingId: null,
	...over,
})

const blocking = {
	id: 'f1',
	severity: 'blocking',
	title: 'Total ignores discounts',
	body: 'The cart total can be higher than the checkout total, because discounts are skipped here.',
} as Finding

test('input: the verdict, each comment with its place and level, without the label line the app adds', () => {
	const input = summaryInput({
		event: 'REQUEST_CHANGES',
		comments: [
			comment('c1', findingCommentBody(blocking), { findingId: 'f1' }),
			comment('c2', 'Could this be one query?', { anchor: anchor({ startLine: 3, endLine: 5 }) }),
			comment('c3', 'Old name read here', { anchor: anchor({ side: 'old', startLine: 7, endLine: 7 }) }),
			comment('c4', 'Whole file thought', { anchor: anchor({ side: null, startLine: null, endLine: null }) }),
			comment('c5', 'Already said', { carried: { published: { url: 'u' } } as ReviewComment['carried'] }),
			comment('c6', '   '),
		],
		findings: new Map([['f1', blocking]]),
		pr: { title: 'Apply coupons at checkout', body: 'Adds coupon codes.' },
		style: null,
	})
	assert.match(input, /# The pull request\nTitle: Apply coupons at checkout\n\nAdds coupon codes\./)
	assert.match(input, /# Verdict: Request changes/)
	assert.match(input, /\(5\)/, 'an empty comment is left out')
	assert.match(input, /## 1\. src\/cart\.ts:12 · blocking\nThe cart total can be higher/)
	assert.doesNotMatch(input, /<kbd>/, 'no label line')
	assert.match(input, /## 2\. src\/cart\.ts:3-5\nCould this be one query\?/)
	assert.match(input, /## 3\. src\/cart\.ts:7 \(before the change\)/)
	assert.match(input, /## 4\. src\/cart\.ts \(the whole file\)/)
	assert.match(input, /## 5\. src\/cart\.ts:12 · posted in an earlier round/)
	assert.match(input, /# Draft the review summary$/)
})

test('input: no comments says so; no pull request leaves that part out', () => {
	const input = summaryInput({ event: 'APPROVE', comments: [], findings: new Map(), pr: null, style: null })
	assert.match(input, /^# Verdict: Approve\n\n# The developer's comments in this review \(0\)\n\(none\)/)
})

test('instructions: plain without a style note, the note fenced in with one', () => {
	const plain = summaryInstructions(null)
	assert.match(plain, /Simple English/)
	assert.doesNotMatch(plain, /\{\{VOICE\}\}|How the developer words/)
	const styled = buildSummaryRequest({ event: 'COMMENT', comments: [], findings: new Map(), pr: null, style: '- Lowercase, short.' })
	assert.match(styled.instructions, /Word it the way the note[\s\S]*<<<STYLE\n- Lowercase, short\.\nSTYLE>>>$/)
	assert.doesNotMatch(styled.instructions, /Simple English/)
	assert.equal(styled.schema?.name, 'review_summary')
})

test('parseSummary: trims, rejects empty or malformed drafts, caps the length', () => {
	assert.equal(parseSummary({ summary: '  Looks good.  ' }), 'Looks good.')
	assert.throws(() => parseSummary({ summary: ' ' }), /empty/)
	assert.throws(() => parseSummary({ text: 'x' }), /expected format/)
	assert.equal(parseSummary({ summary: 'x'.repeat(5000) }).length, 4000)
})

test('controller: drafts from the stored comments and findings, in your style when on, and saves nothing', async () => {
	const store = ReviewStore.in(mkdtempSync(join(tmpdir(), 'review-summary-')))
	await store.load()
	const review = { id: 'rv', comments: [comment('c1', findingCommentBody(blocking), { findingId: 'f1' })] } as unknown as Review
	await store.update((d) => {
		d.repos.r = {
			repoId: 'r',
			root: '/x',
			selectedBase: null,
			activeReviewId: 'rv',
			reviews: { rv: review },
			aiRuns: { rv: [{ id: 'run1', findings: [blocking] } as unknown as AiRun] },
		}
	})
	const asked: Array<ProviderRequest> = []
	const provider = createFakeProvider({
		script: (req) => {
			asked.push(req)
			return { summary: 'Needs the discount fix first.' }
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
	const access = { comparison: { repoId: 'r', pr: { title: 'Apply coupons', body: '' } } } as unknown as Parameters<
		AiController['draftSummary']
	>[0]
	const sel = { connectionId: '00000000-0000-4000-8000-000000000000', modelId: 'fixture-v1' }
	const before = structuredClone(store.read().repos.r)

	assert.equal(await ai.draftSummary(access, 'rv', 'REQUEST_CHANGES', sel), 'Needs the discount fix first.')
	assert.match(asked[0].input, /src\/cart\.ts:12 · blocking/)
	assert.doesNotMatch(asked[0].instructions, /How the developer words/)
	assert.deepEqual(store.read().repos.r, before, 'nothing saved')

	await store.update((d) => {
		d.reviewStyle = {
			text: '- Terse.',
			on: true,
			builtAt: 't',
			edited: false,
			basis: { edits: 0, comments: 5, github: 0, prs: 0 },
			auto: null,
			proposed: null,
			autoFailed: null,
		}
	})
	await ai.draftSummary(access, 'rv', 'REQUEST_CHANGES', sel)
	assert.match(asked[1].instructions, /<<<STYLE\n- Terse\.\nSTYLE>>>/)
})
