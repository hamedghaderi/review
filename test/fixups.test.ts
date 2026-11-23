import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixupsWouldLand, fixupWarning, isFixupSubject } from '../src/shared/fixups.ts'

test('fixup, squash and amend commits are recognised by their subject; a word that merely starts so is not', () => {
	assert.equal(isFixupSubject('fixup! parser: parse sections'), true)
	assert.equal(isFixupSubject('squash! tests'), true)
	assert.equal(isFixupSubject('amend! parser: parse sections'), true)
	assert.equal(isFixupSubject('fixup!parser'), false)
	assert.equal(isFixupSubject('Fix fixup! handling'), false)
	assert.equal(isFixupSubject('fixups for the parser'), false)
})

test('the warning names the first two and counts the rest', () => {
	assert.equal(fixupWarning([{ subject: 'fixup! a' }]), '1 fixup commit hasn’t been squashed (fixup! a).')
	assert.equal(
		fixupWarning([{ subject: 'fixup! a' }, { subject: 'squash! b' }, { subject: 'fixup! c' }]),
		'3 fixup commits haven’t been squashed (fixup! a, squash! b and 1 more).',
	)
})

test('only a repository that allows nothing but squash merges keeps fixups off the base branch; unknown warns', () => {
	assert.equal(fixupsWouldLand({ merge: false, squash: true, rebase: false }), false)
	assert.equal(fixupsWouldLand({ merge: true, squash: true, rebase: false }), true)
	assert.equal(fixupsWouldLand({ merge: false, squash: true, rebase: true }), true)
	assert.equal(fixupsWouldLand({ merge: null, squash: true, rebase: null }), true)
	assert.equal(fixupsWouldLand(null), true)
})
