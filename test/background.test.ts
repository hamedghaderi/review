import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildBackground, CONVERSATION_MAX, issueRefs, ISSUES_MAX } from '../src/main/ai/background.ts'
import type { LinkedIssue } from '../src/main/github.ts'
import type { Discussion, DiscussionComment, DiscussionThread } from '../src/shared/types.ts'

test('issue references: #n, owner/name#n and issue links, in order, without repeats, the PR itself or code', () => {
	const body = [
		'Fixes #12 and closes acme/api#3.',
		'See https://github.com/acme/web/issues/40 and #12 again.',
		'Not #7 (the PR itself), not `#99`, not &#38; entities, not path/to#anchor? path/to#5 is a repo ref.',
		'```',
		'#100 in a code block',
		'```',
		'Pull links are not issues: https://github.com/acme/web/pull/41',
	].join('\n')
	assert.deepEqual(issueRefs(body, 'acme/web', 7), [
		{ repo: 'acme/web', number: 12 },
		{ repo: 'acme/api', number: 3 },
		{ repo: 'acme/web', number: 40 },
		{ repo: 'path/to', number: 5 },
	])
	assert.deepEqual(issueRefs('', 'acme/web', 1), [])
})

const issue = (over: Partial<LinkedIssue> = {}): LinkedIssue => ({
	repo: 'acme/web',
	number: 12,
	title: 'Refunds',
	url: 'u',
	state: 'OPEN',
	body: 'Subtract refunds.',
	closes: true,
	commentsTotal: 0,
	comments: [],
	...over,
})

const comment = (body: string, over: Partial<DiscussionComment> = {}): DiscussionComment => ({
	id: body,
	author: 'a',
	association: null,
	body,
	bodyTruncated: false,
	createdAt: '2026-10-01T00:00:00Z',
	url: null,
	pending: false,
	...over,
})

const thread = (path: string, resolved: boolean | null, comments: Array<DiscussionComment>): DiscussionThread => ({
	id: path,
	path,
	subject: 'line',
	side: 'new',
	resolved,
	resolvedBy: null,
	outdated: false,
	placed: null,
	unplaced: null,
	fileKey: null,
	originalLine: 4,
	diffHunk: null,
	comments,
})

const discussion = (over: Partial<Discussion> = {}): Discussion => ({
	status: 'complete',
	reason: null,
	fetchedAt: '',
	prHead: null,
	threads: [],
	reviews: [],
	conversation: [],
	omitted: { threads: 0, comments: 0, reviews: 0, conversation: 0 },
	...over,
})

test('background: open threads come before resolved ones, your unsubmitted comments are left out, and the summary counts them', () => {
	const b = buildBackground({
		description: null,
		issues: [],
		discussion: discussion({
			threads: [
				thread('a.ts', true, [comment('done already')]),
				thread('b.ts', false, [comment('why is this async?')]),
				thread('c.ts', null, [comment('my draft', { pending: true })]),
			],
			reviews: [
				{
					id: 'r',
					author: 'lead',
					state: 'CHANGES_REQUESTED',
					body: 'Needs tests',
					bodyTruncated: false,
					submittedAt: '2026-10-02T00:00:00Z',
					url: null,
				},
			],
		}),
	})
	const text = b.sections[0].text
	assert.equal(b.sections[0].tag, 'CONVERSATION')
	assert.ok(text.indexOf('b.ts:4 (open)') < text.indexOf('a.ts:4 (resolved)'))
	assert.ok(!text.includes('my draft'))
	assert.ok(text.includes('@lead (2026-10-02): [review: changes_requested] Needs tests'))
	assert.equal(b.summary, 'conversation: 2 threads (1 open), 1 comment')
})

test('background: issues and the conversation stay within their budgets and say what was cut', () => {
	const long = 'x'.repeat(5000)
	const b = buildBackground({
		description: 'd',
		issues: [1, 2, 3].map((n) =>
			issue({
				number: n,
				body: long,
				commentsTotal: 80,
				comments: Array.from({ length: 20 }, (_, i) => ({ author: 'u', body: `${i} ${long}`, createdAt: null })),
			}),
		),
		discussion: discussion({ conversation: Array.from({ length: 200 }, (_, i) => comment(`note ${i} ${'y'.repeat(300)}`)) }),
	})
	const issues = b.sections.find((s) => s.tag === 'ISSUES')!.text
	const conversation = b.sections.find((s) => s.tag === 'CONVERSATION')!.text
	assert.ok(issues.length <= ISSUES_MAX + 600, `issues ${issues.length}`)
	assert.ok(issues.includes('[cut]'))
	assert.ok(issues.includes('Comments (latest 20 of 80):'))
	assert.ok(conversation.length <= CONVERSATION_MAX + 100, `conversation ${conversation.length}`)
	assert.match(conversation, /\(\d+ more not shown: over the size limit\)/)
	assert.equal(
		b.summary,
		'description; issue #1 (closes, 80 comments); issue #2 (closes, 80 comments); issue #3 (closes, 80 comments); conversation: 0 threads, 200 comments',
	)
})

test('background: an unreadable discussion and an empty one add nothing; only the description is sent', () => {
	for (const d of [discussion({ status: 'unavailable', reason: 'offline' }), discussion(), null]) {
		const b = buildBackground({ description: '  Adds refunds  ', issues: [], discussion: d })
		assert.deepEqual(
			b.sections.map((s) => [s.tag, s.text]),
			[['DESCRIPTION', 'Adds refunds']],
		)
		assert.equal(b.summary, 'description')
	}
	assert.deepEqual(buildBackground({ description: null, issues: [], discussion: null }), { sections: [], chars: 0, summary: null })
})
