import assert from 'node:assert/strict'
import { test } from 'node:test'
import { feedbackUrl, ISSUES_NEW_URL, MAX_BODY } from '../src/shared/feedback.ts'

test('feedback: a prefilled new-issue link with the kind in the title and the system line under the body', () => {
	const url = new URL(
		feedbackUrl({ kind: 'bug', title: '  Diff  is\nblank ', body: 'Steps & more\n', system: 'Review 0.8.0 · macOS 15.1 (arm64)' }),
	)
	assert.equal(`${url.origin}${url.pathname}`, ISSUES_NEW_URL)
	assert.equal(url.searchParams.get('title'), 'Bug: Diff is blank')
	assert.equal(url.searchParams.get('body'), 'Steps & more\n\n---\nReview 0.8.0 · macOS 15.1 (arm64)')
	assert.deepEqual([...url.searchParams.keys()], ['title', 'body'])
})

test('feedback: no system line when left out, and a long body is cut', () => {
	const url = new URL(feedbackUrl({ kind: 'idea', title: 'x', body: 'a'.repeat(MAX_BODY + 50), system: null }))
	assert.equal(url.searchParams.get('title'), 'Idea: x')
	assert.equal(url.searchParams.get('body'), `${'a'.repeat(MAX_BODY)}…`)
})
