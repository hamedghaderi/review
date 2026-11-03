import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { RunConfig } from '../src/main/ai/connections.ts'
import { AiController } from '../src/main/ai/controller.ts'
import { createFakeProvider } from '../src/main/ai/fake.ts'
import type { ProviderRequest } from '../src/main/ai/provider.ts'
import {
	buildStyleRequest,
	exampleCount,
	fromFinding,
	newExamplesSince,
	parseStyle,
	STYLE_INSTRUCTIONS,
	styleBasis,
	styleExamples,
	styleInput,
	STYLE_REFRESH_EVERY,
	withoutAdded,
} from '../src/main/ai/style.ts'
import { GitHubService, type TokenStore } from '../src/main/github.ts'
import { ReviewService } from '../src/main/service.ts'
import { migrate, ReviewStore, STORE_VERSION } from '../src/main/store.ts'
import { reviewStyleEdit, stylePrList } from '../src/main/validate.ts'
import { parsePrRef } from '../src/shared/prQuery.ts'
import { CATEGORY_LABEL, findingCommentBody, LEVEL_META, RESIDUE_LABEL, TEST_PATTERN_LABEL } from '../src/shared/findings.ts'
import type { AiRun, Anchor, Finding, FindingCategory, Review, ReviewComment, Severity, TestPattern } from '../src/shared/types.ts'

const anchor = { fileKey: 'k', side: 'new', startLine: 1, endLine: 1, excerpt: '' } as unknown as Anchor

function finding(id: string, over: Partial<Finding> = {}): Finding {
	return {
		id,
		runId: 'run1',
		excerptId: 'E1',
		anchor,
		severity: 'should_fix',
		title: id,
		evidence: '',
		repeatOf: null,
		body: `The list page can show a stale count after ${id} runs, because the cache is not cleared.`,
		...over,
	} as Finding
}

function comment(id: string, body: string, over: Partial<ReviewComment> = {}): ReviewComment {
	return { id, anchor, body, createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-01T10:00:00Z', findingId: null, ...over }
}

function repo(comments: Array<ReviewComment>, findings: Array<Finding>) {
	const review = { id: 'rv', comments } as unknown as Review
	const run = { id: 'run1', findings } as unknown as AiRun
	return { reviews: { rv: review }, aiRuns: { rv: [run] } }
}

test('examples: an edited finding is a pair, an unchanged one is the AI’s words and is left out', () => {
	const kept = finding('f1')
	const edited = finding('f2')
	const posted = `${findingCommentBody(edited).split('\n\n')[0]}\n\nnit: clear the cache here too?`
	const x = styleExamples(
		[
			repo(
				[
					comment('c1', findingCommentBody(kept), { findingId: 'f1' }),
					comment('c2', posted, { findingId: 'f2' }),
					comment('c3', 'Could we name this `retryAfterMs`? It holds milliseconds.'),
				],
				[kept, edited],
			),
		],
		[],
	)
	assert.deepEqual(x.edits, [{ ai: edited.body, yours: 'nit: clear the cache here too?' }], 'the level label is not part of your words')
	assert.deepEqual(x.own, ['Could we name this `retryAfterMs`? It holds milliseconds.'])
	assert.deepEqual(styleBasis(x), { edits: 1, comments: 1, github: 0, prs: 0 })
})

test('examples: a finding whose only change was dropping the parts the app adds is not an edit', () => {
	const f = finding('f1', { disproof: 'Run the list test twice.', background: 'The cache lives in memory.' })
	const x = styleExamples([repo([comment('c1', `${findingCommentBody(f).split('\n\n')[0]}\n\n${f.body}`, { findingId: 'f1' })], [f])], [])
	assert.equal(exampleCount(x), 0)
})

test('examples: carried copies, comments whose finding is gone and duplicates count once or not at all', () => {
	const carried = comment('c2', 'Same words', { carried: { originId: 'c1' } as ReviewComment['carried'] })
	const x = styleExamples([repo([comment('c1', 'Same words'), carried, comment('c3', 'Orphan', { findingId: 'gone' })], [])], [])
	assert.deepEqual(x.own, ['Same words'])
})

test('examples: GitHub comments skip automatic review summaries, posted findings and what the app already has', () => {
	const f = finding('f1')
	const x = styleExamples(
		[repo([comment('c1', 'Looks good, one question below.')], [f])],
		[
			{ body: '🤖 This review was written and submitted automatically by AI.', createdAt: '2026-11-02' },
			{ body: findingCommentBody(f), createdAt: '2026-11-02' },
			{ body: 'Looks good, one question below.', createdAt: '2026-11-02' },
			{ body: 'Why not reuse `parseDate` here?', createdAt: '2026-11-02' },
			{ body: '   ', createdAt: null },
		],
	)
	assert.deepEqual(x.github, ['Why not reuse `parseDate` here?'])
	assert.ok(fromFinding(findingCommentBody(f)))
	assert.ok(!fromFinding('nit: <kbd>x</kbd>'))
})

test('examples: newest first, and each kind is capped', () => {
	const many = Array.from({ length: 100 }, (_, i) => ({
		body: `GitHub comment ${i}`,
		createdAt: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T00:00:${String(i % 60).padStart(2, '0')}Z`,
	}))
	const x = styleExamples([], many)
	assert.equal(x.github.length, 80)
	assert.match(x.github[0], /GitHub comment/)
	const dates = x.github.map((b) => many.find((m) => m.body === b)!.createdAt)
	assert.deepEqual(dates, [...dates].sort().reverse())
})

test('withoutAdded strips the label, follow-up link, other places, disproof and background', () => {
	const f = finding('f1', {
		raisedBefore: { url: 'https://example.com/t' } as Finding['raisedBefore'],
		alsoAt: [{ findingId: 'x', path: 'a.ts', line: 3, title: 't' }],
		disproof: 'Run it.',
		background: 'Context.',
	})
	assert.equal(withoutAdded(findingCommentBody(f)), f.body)
})

test('input: edits come first, and the request stays under its size by dropping the oldest of the rest', () => {
	const big = 'x'.repeat(1200)
	const input = styleInput({ edits: [{ ai: 'AI text', yours: 'my text' }], own: Array(30).fill(big), github: Array(80).fill(big) })
	assert.ok(input.indexOf('The AI wrote') < input.indexOf('themselves'))
	assert.ok(input.length < 62_000)
	assert.match(input, /Write the note/)
	const req = buildStyleRequest({ edits: [], own: ['a'], github: [] })
	assert.equal(req.instructions, STYLE_INSTRUCTIONS)
	assert.equal(req.schema?.name, 'review_style')
})

test('parseStyle: trims, rejects empty or malformed notes, and caps the length', () => {
	assert.equal(parseStyle({ style: '  - Short and direct.\n' }), '- Short and direct.')
	assert.throws(() => parseStyle({ style: '   ' }), /empty/)
	assert.throws(() => parseStyle({ note: 'x' }), /expected format/)
	assert.equal(parseStyle({ style: 'y'.repeat(5000) }).length, 2000)
})

test('store: the note survives a restart, and a broken one is dropped', () => {
	const style = {
		text: '- Be brief.',
		on: false,
		builtAt: '2026-11-03T09:00:00Z',
		edited: true,
		basis: { edits: 2, comments: 3, github: 10, prs: 0 },
		auto: null,
		proposed: { text: '- Be briefer.', builtAt: '2026-11-03T10:00:00Z', basis: { edits: 2, comments: 3, github: 12, prs: 4 }, auto: 10 },
		autoFailed: { at: '2026-11-03T11:00:00Z', message: 'No style note: model down' },
	}
	const base = { version: STORE_VERSION, lastRepoId: null, repos: {} }
	assert.deepEqual(migrate({ ...base, reviewStyle: style }).reviewStyle, style)
	assert.equal(migrate({ ...base, reviewStyle: { text: 1 } }).reviewStyle, undefined)
	assert.equal(migrate(base).reviewStyle, undefined, 'nothing is there until you build it')
})

test('validate: an edit needs text within the size and a yes/no for on', () => {
	assert.deepEqual(reviewStyleEdit({ text: '- Brief.', on: true }), { text: '- Brief.', on: true })
	assert.throws(() => reviewStyleEdit({ text: '', on: true }))
	assert.throws(() => reviewStyleEdit({ text: 'z'.repeat(2001), on: true }))
	assert.throws(() => reviewStyleEdit({ text: 'ok', on: 'yes' }))
})

test('newExamplesSince counts only your edits and comments changed after the given time', () => {
	const f = finding('f1')
	const r = repo(
		[
			comment('c1', 'old one', { updatedAt: '2026-10-01T00:00:00Z' }),
			comment('c2', 'new one', { updatedAt: '2026-11-02T00:00:00Z' }),
			comment('c3', findingCommentBody(f), { findingId: 'f1', updatedAt: '2026-11-02T00:00:00Z' }),
		],
		[f],
	)
	assert.equal(newExamplesSince([r], '2026-10-15T00:00:00Z'), 1, 'a finding posted unchanged is not yours')
})

const SEL = { connectionId: '00000000-0000-4000-8000-000000000000', modelId: 'fixture-v1' }

async function styleService() {
	const store = ReviewStore.in(mkdtempSync(join(tmpdir(), 'review-style-')))
	await store.load()
	const svc = new ReviewService(store, null)
	const requests: Array<ProviderRequest> = []
	let fail = false
	const provider = createFakeProvider({
		script: (req) => {
			requests.push(req)
			if (fail) throw new Error('model down')
			return { style: `- Note ${requests.length}.` }
		},
	})
	const config = async (): Promise<RunConfig> => ({
		provider,
		connectionId: SEL.connectionId,
		connectionLabel: 'Fixture',
		endpoint: 'fixture://local',
		limits: { contextLines: 5, maxBatchChars: 100_000, maxRunChars: 1_000_000, verify: false, relatedCode: false },
	})
	svc.attachAi(new AiController(store, config, () => {}))
	let n = 0
	// Comments you write now, a moment after whatever was built or tried before.
	const write = async (count: number) => {
		await new Promise((r) => setTimeout(r, 5))
		const at = new Date().toISOString()
		await store.update((d) => {
			const r = (d.repos.r ??= { repoId: 'r', root: '/x', selectedBase: null, activeReviewId: null, reviews: {}, aiRuns: {} })
			const rv = (r.reviews.rv ??= { id: 'rv', comments: [] } as unknown as Review)
			for (let i = 0; i < count; i++) rv.comments.push(comment(`c${++n}`, `My comment number ${n}.`, { updatedAt: at }))
		})
		await new Promise((r) => setTimeout(r, 5))
	}
	return { store, svc, requests, write, failNext: (v: boolean) => (fail = v) }
}

test('refresh: updates the note on its own after enough new comments, and never while it is off or not built', async () => {
	const { store, svc, requests, write } = await styleService()
	await write(12)
	await svc.refreshReviewStyle(SEL)
	assert.equal(requests.length, 0, 'nothing happens until you build it once')

	await svc.buildReviewStyle(SEL)
	assert.equal(store.read().reviewStyle?.auto, null)
	await write(STYLE_REFRESH_EVERY - 1)
	await svc.refreshReviewStyle(SEL)
	assert.equal(requests.length, 1, 'not enough new comments yet')

	await write(1)
	await svc.refreshReviewStyle(SEL)
	assert.equal(requests.length, 2)
	assert.equal(store.read().reviewStyle?.text, '- Note 2.')
	assert.equal(store.read().reviewStyle?.auto, STYLE_REFRESH_EVERY)

	await svc.setReviewStyle({ text: '- Note 2.', on: false })
	await write(STYLE_REFRESH_EVERY)
	await svc.refreshReviewStyle(SEL)
	assert.equal(requests.length, 2, 'off means no requests')
	await svc.refreshReviewStyle(null)
	assert.equal(requests.length, 2)
})

test('refresh: a note you edited is kept, and the update waits beside it', async () => {
	const { store, svc, write } = await styleService()
	await write(6)
	await svc.buildReviewStyle(SEL)
	await svc.setReviewStyle({ text: '- Mine.', on: true })
	await write(STYLE_REFRESH_EVERY)
	await svc.refreshReviewStyle(SEL)
	const s = store.read().reviewStyle!
	assert.equal(s.text, '- Mine.')
	assert.equal(s.proposed?.text, '- Note 2.')
	assert.equal(s.proposed?.auto, STYLE_REFRESH_EVERY)
	const taken = await svc.settleReviewStyle(true)
	assert.equal(taken.text, '- Note 2.')
	assert.equal(taken.edited, false)
	assert.equal(taken.proposed, null)
})

test('refresh: a failed update is shown and waits for more comments instead of retrying after every run', async () => {
	const { store, svc, requests, write, failNext } = await styleService()
	await write(6)
	await svc.buildReviewStyle(SEL)
	await write(STYLE_REFRESH_EVERY)
	failNext(true)
	await svc.refreshReviewStyle(SEL)
	assert.match(store.read().reviewStyle?.autoFailed?.message ?? '', /model down/)
	assert.equal(store.read().reviewStyle?.text, '- Note 1.')
	const tried = requests.length
	await svc.refreshReviewStyle(SEL)
	assert.equal(requests.length, tried, 'no retry on the next run')
	failNext(false)
	await write(STYLE_REFRESH_EVERY)
	await svc.refreshReviewStyle(SEL)
	assert.equal(store.read().reviewStyle?.autoFailed, null)
})

test('parsePrRef: a GitHub pull request link or owner/name#123, nothing else', () => {
	assert.deepEqual(parsePrRef(' https://github.com/octo/app/pull/7/files '), { repo: 'octo/app', number: 7 })
	assert.deepEqual(parsePrRef('octo/app#12'), { repo: 'octo/app', number: 12 })
	for (const no of ['flaky tests', '#12', 'octo/app', 'https://github.com/octo/app/issues/7', 'octo/..#3', 'octo/app#0'])
		assert.equal(parsePrRef(no), null, no)
})

test('validate: picked pull requests are at most 10, well formed and not repeated', () => {
	const pr = (n: number) => ({ repo: 'octo/app', number: n, title: `PR ${n}` })
	assert.deepEqual(stylePrList([pr(1), pr(2)]), [pr(1), pr(2)])
	assert.deepEqual(stylePrList([]), [])
	assert.throws(() => stylePrList(Array.from({ length: 11 }, (_, i) => pr(i + 1))))
	assert.throws(() => stylePrList([pr(1), { ...pr(1), repo: 'Octo/App' }]), /picked twice/)
	assert.throws(() => stylePrList([{ ...pr(1), repo: 'not a repo' }]))
	assert.throws(() => stylePrList([{ ...pr(1), number: 1.5 }]))
})

test('store: picked pull requests survive a restart; broken entries are dropped', () => {
	const base = { version: STORE_VERSION, lastRepoId: null, repos: {} }
	const ok = { repo: 'octo/app', number: 7, title: 'Fix cache' }
	assert.deepEqual(migrate({ ...base, stylePrs: [ok, { repo: 'x' }, null] }).stylePrs, [ok])
	assert.equal(migrate(base).stylePrs, undefined)
})

function signedIn(): TokenStore {
	return {
		async save() {},
		async read() {
			return { state: 'saved', secret: 'ghp_test' }
		},
		peek: () => 'saved',
		async remove() {},
		storageInfo: () => ({ secure: true, backend: 'test', message: null }),
	} as TokenStore
}

/** A fake GitHub answering the style queries; records each GraphQL request. */
function styleGitHub() {
	const calls: Array<{ query: string; variables: Record<string, unknown> }> = []
	const pr = (repo: string, number: number, comments: Array<string>) => ({
		number,
		title: `PR ${number}`,
		url: `https://github.com/${repo}/pull/${number}`,
		updatedAt: '2026-11-01T00:00:00Z',
		repository: { nameWithOwner: repo },
		reviews: {
			nodes: [
				{
					body: 'Summary',
					submittedAt: '2026-11-01T00:00:00Z',
					comments: { nodes: comments.map((body) => ({ body, createdAt: '2026-11-01T00:00:00Z' })) },
				},
			],
		},
	})
	const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } })
	const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
		const body = JSON.parse(String(init.body))
		calls.push(body)
		const q = String(body.query)
		if (q.includes('viewer { login }')) return json({ data: { viewer: { login: 'me' } } })
		if (q.includes('search(')) return json({ data: { search: { nodes: [pr('octo/app', 1, ['a', 'b']), {}] } } })
		// Picked ones: r0, r1… The second is out of reach and comes back as an error on its own path.
		return json({
			data: { r0: { pullRequest: pr('octo/app', 7, ['picked comment']) }, r1: null },
			errors: [{ type: 'NOT_FOUND', message: 'Could not resolve', path: ['r1'] }],
		})
	}
	return { svc: new GitHubService(signedIn(), { fetch, base: 'https://api.test' }), calls }
}

test('GitHub: with nothing picked it reads recent reviews; with picks only those, skipping unreadable ones', async () => {
	const { svc, calls } = styleGitHub()
	const recent = await svc.myReviewComments([])
	assert.deepEqual(
		recent?.map((c) => c.body),
		['Summary', 'a', 'b'],
	)
	assert.match(String(calls.at(-1)?.variables.q), /reviewed-by:@me -author:@me/)

	const picked = await svc.myReviewComments([
		{ repo: 'octo/app', number: 7 },
		{ repo: 'octo/gone', number: 3 },
	])
	assert.deepEqual(
		picked?.map((c) => c.body),
		['Summary', 'picked comment'],
	)
	const last = calls.at(-1)!
	assert.deepEqual([last.variables.o0, last.variables.n0, last.variables.p0, last.variables.n1], ['octo', 'app', 7, 'gone'])
	assert.doesNotMatch(last.query, /octo/, 'names go in as variables, never into the query text')
})

test('GitHub: listing reviewed pull requests counts your comments; a pasted link looks up that one', async () => {
	const { svc, calls } = styleGitHub()
	const list = await svc.reviewedPrs('cache')
	assert.deepEqual(list, [
		{
			repo: 'octo/app',
			number: 1,
			title: 'PR 1',
			url: 'https://github.com/octo/app/pull/1',
			updatedAt: '2026-11-01T00:00:00Z',
			comments: 3,
		},
	])
	assert.match(String(calls.at(-1)?.variables.q), /reviewed-by:@me .*cache sort:updated-desc/)
	const one = await svc.reviewedPrs('https://github.com/octo/app/pull/7')
	assert.deepEqual(
		one.map((p) => `${p.repo}#${p.number}`),
		['octo/app#7'],
	)
})

// The app tells comments it posted from findings by their label line, so a change to that line must fail here, or
// unchanged findings on GitHub would quietly count as your own words.
test('fromFinding recognises the label line at every level and topic findingCommentBody writes', () => {
	const levels = Object.keys(LEVEL_META) as Array<Severity>
	const topics: Array<Partial<Finding>> = [
		{},
		...(Object.keys(CATEGORY_LABEL) as Array<FindingCategory>).map((category) => ({ category })),
		...RESIDUE_LABEL.map((_, i) => ({ category: 'residue' as FindingCategory, signature: i })),
		...(Object.keys(TEST_PATTERN_LABEL) as Array<TestPattern>).map((testPattern) => ({
			category: 'test-value' as FindingCategory,
			testPattern,
		})),
	]
	for (const severity of levels)
		for (const t of topics) {
			const body = findingCommentBody(finding('f', { severity, ...t }))
			assert.ok(fromFinding(body), `not recognised: ${body.split('\n')[0]}`)
			assert.equal(withoutAdded(body), finding('f').body, `label not stripped: ${body.split('\n')[0]}`)
		}
})
