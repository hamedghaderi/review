import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildBackground, TAKEOVER_MAX } from '../src/main/ai/background.ts'
import type { Activity, RawThread } from '../src/main/activity.ts'
import { createReviewTools, shownLines } from '../src/main/ai/lookup.ts'
import { changesOf, sharedCommits } from '../src/main/git.ts'
import { findTakeover, originalLineUrl, takeoverFact, takeoverRefs, type TakeoverDeps } from '../src/main/takeover.ts'
import { findingCommentBody } from '../src/shared/findings.ts'
import type { DiscussionComment, Finding, PrDetail, Takeover, TakeoverOriginal } from '../src/shared/types.ts'

test('takeover references: words name the original; every other number in this repository is only mentioned', () => {
	const body = [
		'Supersedes #12, and takes over PR https://github.com/acme/web/pull/14.',
		'Continuation of acme/web#15; replaces acme/api#3 (another repository).',
		'See #20 and https://github.com/acme/web/pull/21 for context, and #12 again.',
		'Not `replaces #30` in code, not #7 (this pull request).',
	].join('\n')
	assert.deepEqual(takeoverRefs(body, 'acme/web', 7), { words: [12, 14, 15], mentioned: [20, 21] })
	assert.deepEqual(takeoverRefs('Taking over from #9.', 'acme/web', 7).words, [9])
	assert.deepEqual(takeoverRefs('', 'acme/web', 7), { words: [], mentioned: [] })
})

const comment = (body: string, over: Partial<DiscussionComment> = {}): DiscussionComment => ({
	id: body,
	author: 'rev',
	association: 'MEMBER',
	body,
	bodyTruncated: false,
	createdAt: null,
	url: null,
	pending: false,
	...over,
})

const thread = (path: string, over: Partial<RawThread> = {}): RawThread => ({
	id: path,
	path,
	subject: 'line',
	side: 'RIGHT' as RawThread['side'],
	line: 4,
	startLine: null,
	originalLine: 4,
	originalStartLine: null,
	originalCommit: null,
	resolved: false,
	resolvedBy: null,
	outdated: false,
	diffHunk: null,
	comments: [comment(`Concern on ${path}`)],
	commentsOmitted: 0,
	url: `https://github.com/acme/web/pull/12#${path}`,
	...over,
})

const detail = (number: number): PrDetail =>
	({
		number,
		repo: 'acme/web',
		title: `PR ${number}`,
		author: 'alice',
		authorAssociation: 'CONTRIBUTOR',
		state: 'closed',
		url: `https://github.com/acme/web/pull/${number}`,
		body: 'Add refunds to the cart total.',
		baseSha: 'a'.repeat(40),
		headSha: 'b'.repeat(40),
	}) as PrDetail

function deps(o: {
	prs?: Array<number>
	issues?: Array<number>
	shared?: Record<number, number>
	threads?: Array<RawThread>
}): TakeoverDeps & {
	compared: Array<number>
} {
	const compared: Array<number> = []
	return {
		compared,
		detail: async (n) => {
			if (!o.prs?.includes(n)) throw new Error(`#${n} not found`)
			return detail(n)
		},
		isIssue: async (n) => !!o.issues?.includes(n),
		activity: async () =>
			({
				threads: o.threads ?? [],
				reviews: [],
				conversation: [],
				omitted: { threads: 0, comments: 0, reviews: 0, conversation: 0 },
				partial: null,
			}) as unknown as Activity,
		shared: async (d) => {
			compared.push(d.number)
			return o.shared?.[d.number] ?? 0
		},
	}
}

const pr = (body: string) => ({ repo: 'acme/web', number: 30, body })

test('takeover: words read the original with only its open, current threads', async () => {
	const t = await findTakeover(
		pr('Takes over #12.'),
		deps({
			prs: [12],
			shared: { 12: 2 },
			threads: [
				thread('open.ts'),
				thread('resolved.ts', { resolved: true }),
				thread('outdated.ts', { outdated: true }),
				thread('pending.ts', { comments: [comment('draft', { pending: true })] }),
				thread('unknown.ts', { resolved: null }),
			],
		}),
	)
	assert.equal(t?.status, 'read')
	const o = (t as Extract<Takeover, { status: 'read' }>).original
	assert.deepEqual([o.number, o.how, o.shared], [12, 'words', 2])
	assert.deepEqual(
		o.threads.map((x) => x.path),
		['open.ts', 'unknown.ts'],
	)
})

test('takeover: words naming an issue are skipped, an unreadable original is said, and a mention needs shared commits', async () => {
	// "Replaces #5" where #5 is an issue: not a takeover, so a mentioned pull request with shared commits still counts.
	const a = await findTakeover(pr('Replaces #5. Based on #12 and #13.'), deps({ prs: [12, 13], issues: [5], shared: { 13: 1 } }))
	assert.equal(a?.status === 'read' && a.original.number, 13)
	assert.equal(a?.status === 'read' && a.original.how, 'commits')

	const b = await findTakeover(pr('Supersedes #12.'), deps({ prs: [] }))
	assert.deepEqual(b, { status: 'unreadable', repo: 'acme/web', number: 12, how: 'words', reason: '#12 not found' })

	const d = deps({ prs: [12, 13, 14, 15] })
	assert.equal(await findTakeover(pr('See #12, #13, #14 and #15.'), d), null, 'mentioned with no shared commits')
	assert.deepEqual(d.compared, [12, 13, 14], 'at most three mentioned pull requests are compared')
})

test('takeover background: the original and its open threads are data, cut to size, and an unreadable one is said', () => {
	const long = Array.from({ length: 40 }, (_, i) =>
		Object.assign({}, { path: `f${i}.ts`, line: 3, url: null, resolved: false, comments: [comment('x'.repeat(500))] }),
	)
	const original = {
		...detail(12),
		body: 'Add refunds.',
		association: 'CONTRIBUTOR',
		how: 'words' as const,
		shared: 2,
		threads: [{ path: 'cart.ts', line: 8, url: null, resolved: false, comments: [comment('Refunds can go negative.')] }, ...long],
		threadsLeft: 0,
		partial: null,
	}
	const b = buildBackground({ description: 'Takes over #12.', issues: [], discussion: null, takeover: { status: 'read', original } })
	const s = b.sections.find((x) => x.tag === 'TAKEOVER')!
	assert.match(s.title, /not evidence about the code/)
	assert.match(s.text, /^acme\/web#12 \[closed, named as taken over in the description\]: PR 12 \(opened by @alice \[no write access\]\)/)
	assert.match(s.text, /Thread O1 on cart\.ts:8:\n- @rev \[write access\]: Refunds can go negative\./)
	assert.match(s.text, /more open threads not shown: over the size limit/)
	assert.ok(s.text.length < TAKEOVER_MAX + 200)
	assert.match(b.summary!, /takes over #12 \(41 open threads, \d+ cut for size\)/)
	assert.ok(b.outside.includes('pull request #12, which this one takes over'), 'its author has no write access')

	const u = buildBackground({
		description: null,
		issues: [],
		discussion: null,
		takeover: { status: 'unreadable', repo: 'acme/web', number: 12, how: 'words', reason: 'no access' },
	})
	assert.match(u.sections[0].text, /could not be read \(no access\)\. Its description and review threads are unknown/)
	assert.equal(u.summary, 'takes over #12 (could not be read)')
})

test('shared commits: the same commit and a rebased copy of one both count; a different change does not', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'review-takeover-'))
	const git = (...a: Array<string>): string =>
		execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=a@a', '-c', 'commit.gpgsign=false', ...a], {
			cwd: dir,
			encoding: 'utf8',
		}).trim()
	const commit = (file: string, text: string, message: string): string => {
		writeFileSync(join(dir, file), text)
		git('add', '-A')
		git('commit', '-qm', message)
		return git('rev-parse', 'HEAD')
	}
	git('init', '-q', '-b', 'main')
	const base = commit('a.ts', 'a\n', 'base')
	git('checkout', '-qb', 'original')
	commit('b.ts', 'b\n', 'Original one')
	commit('c.ts', 'c\n', 'Original two')
	const originalHead = git('rev-parse', 'HEAD')
	// main moves on, and the takeover rebases the original's second commit onto it and adds its own.
	git('checkout', '-q', 'main')
	const moved = commit('d.ts', 'd\n', 'Unrelated')
	git('checkout', '-qb', 'takeover')
	git('-c', 'user.name=Bob', '-c', 'user.email=b@b', 'cherry-pick', originalHead)
	commit('e.ts', 'e\n', 'Takeover work')
	const head = git('rev-parse', 'HEAD')

	assert.equal(await sharedCommits(dir, { base, head: originalHead }, { base: moved, head }), 1)
	// Built straight on the original's branch: its commits are the same commits.
	git('checkout', '-qb', 'direct', originalHead)
	const direct = commit('f.ts', 'f\n', 'More')
	assert.equal(await sharedCommits(dir, { base, head: originalHead }, { base, head: direct }), 2)
	git('checkout', '-qb', 'other', base)
	const other = commit('g.ts', 'g\n', 'Something else')
	assert.equal(await sharedCommits(dir, { base, head: originalHead }, { base, head: other }), 0)
	assert.equal(await sharedCommits(dir, { base, head: 'f'.repeat(40) }, { base, head }), null, 'not in this clone')
})

test('what the original changed: its files say which this one also changes, patches of the others first, cut to fit; lookups read its head', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'review-takeover-changes-'))
	const git = (...a: Array<string>): string =>
		execFileSync('git', ['-c', 'user.name=Ann', '-c', 'user.email=a@a', '-c', 'commit.gpgsign=false', ...a], {
			cwd: dir,
			encoding: 'utf8',
		}).trim()
	git('init', '-q', '-b', 'main')
	writeFileSync(join(dir, 'cart.ts'), 'export const total = 1\n')
	writeFileSync(join(dir, 'gone.ts'), 'old\n')
	git('add', '-A')
	git('commit', '-qm', 'base')
	const base = git('rev-parse', 'HEAD')
	git('checkout', '-qb', 'original')
	writeFileSync(join(dir, 'cart.ts'), 'export const total = 1\nexport const refunds = 2\n')
	writeFileSync(join(dir, 'refund.ts'), 'export function refund() {}\n')
	git('rm', '-q', 'gone.ts')
	git('add', '-A')
	git('commit', '-qm', 'Refunds')
	const head = git('rev-parse', 'HEAD')

	const changes = await changesOf(dir, base, head)
	assert.deepEqual(
		changes?.map((c) => [c.path, c.added, c.removed]),
		[
			['cart.ts', 1, 0],
			['gone.ts', 0, 1],
			['refund.ts', 1, 0],
		],
	)
	assert.equal(await changesOf(dir, base, 'f'.repeat(40)), null)

	const original = { number: 5 } as TakeoverOriginal
	const fact = takeoverFact(original, changes!, new Set(['cart.ts']))!
	assert.equal(fact.kind, 'takeover')
	assert.match(fact.title, /^What #5 changed/)
	assert.match(
		fact.text,
		/^#5 changed 3 files:\n- gone\.ts \(\+0 -1\) \[not changed here\]\n- refund\.ts \(\+1 -0\) \[not changed here\]\n- cart\.ts \(\+1 -0\) \[also changed here\]/,
	)
	assert.ok(fact.text.indexOf('+export function refund') < fact.text.indexOf('+export const refunds'), 'files left alone first')
	const small = takeoverFact(original, changes!, new Set(['cart.ts']), 400)!
	assert.match(small.text, /patches not shown: over the size limit; read them with version "original"/)
	assert.equal(takeoverFact(original, [], new Set()), null)

	const budget = { maxCalls: 5, maxChars: 10_000 }
	const read = { path: 'refund.ts', version: 'original', start_line: null, end_line: null }
	const r = await createReviewTools({ root: dir, baseSha: base, headSha: base, originalSha: head }, budget).call(
		'read_file',
		read,
		new AbortController().signal,
	)
	assert.match(r.text, /^refund\.ts \(original\), lines 1-1 of 1:\n1 \| export function refund\(\) \{\}/)
	assert.deepEqual(shownLines('read_file', r.text), [{ path: 'refund.ts', version: 'original', start: 1, end: 1 }])
	const none = await createReviewTools({ root: dir, baseSha: base, headSha: base }, budget).call(
		'read_file',
		read,
		new AbortController().signal,
	)
	assert.match(none.text, /takes over no other one that could be read/)
	assert.equal(originalLineUrl({ repo: 'o/r', headSha: head }, 'src/a b.ts', 4), `https://github.com/o/r/blob/${head}/src/a%20b.ts#L4`)
})

test('a comment following up a thread on the original says where that thread is', () => {
	const f = {
		severity: 'should_fix',
		category: 'bug',
		title: 't',
		body: 'Refunds still add.',
		raisedBefore: {
			threadId: 'x',
			url: 'https://github.com/o/r/pull/5#r1',
			path: 'a.ts',
			outcome: 'unanswered',
			whyAgain: 'w',
			original: 5,
		},
	} as unknown as Finding
	assert.match(
		findingCommentBody(f),
		/Follows up on \[a thread on #5\]\(https:\/\/github\.com\/o\/r\/pull\/5#r1\), which this pull request takes over\./,
	)
})
