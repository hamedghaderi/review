import assert from 'node:assert/strict'
import { test } from 'node:test'
import { linkInArgs, parsePrLink } from '../src/shared/link.ts'

test('pull request links: the GitHub path after review-code://open, with or without a tab', () => {
	assert.deepEqual(parsePrLink('review-code://open/hamedghaderi/review/pull/58'), { repo: 'hamedghaderi/review', number: 58 })
	assert.deepEqual(parsePrLink('review-code://open/a-b/c.d_e/pull/7/files'), { repo: 'a-b/c.d_e', number: 7 })
	assert.deepEqual(parsePrLink('review-code://open/o/r/pull/7/'), { repo: 'o/r', number: 7 })
})

test('pull request links: anything else under the scheme is ignored', () => {
	for (const bad of [
		'https://github.com/o/r/pull/1',
		'review-code://other/o/r/pull/1',
		'review-code://open/o/r/issues/1',
		'review-code://open/o/r/pull/0',
		'review-code://open/o/r/pull/12345678901',
		'review-code://open/-o/r/pull/1',
		'review-code://open/o/../pull/1',
		'review-code://open/o/r/pull/1?ai=start',
		'review-code://open/o/r/pull/1#run',
		'review-code://user:pw@open/o/r/pull/1',
		'review-code://open/o/r/pull/1/../../../etc',
		`review-code://open/${'o'.repeat(40)}/r/pull/1`,
		'review-code://open/o/r/pull/1' + '/x'.repeat(300),
		'not a url',
	])
		assert.equal(parsePrLink(bad), null, bad)
})

test('pull request links: found among command-line arguments', () => {
	assert.equal(linkInArgs(['/app/Review', '--flag', 'review-code://open/o/r/pull/1']), 'review-code://open/o/r/pull/1')
	assert.equal(linkInArgs(['/app/Review', '.']), null)
})
