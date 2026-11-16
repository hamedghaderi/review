import assert from 'node:assert/strict'
import { test } from 'node:test'
import { speaker } from '../src/renderer/src/announce.ts'
import { nextPane } from '../src/renderer/src/panes.ts'
import { keyConflicts, matchesBinding, resolveKeymap } from '../src/shared/keymap.ts'

test('panes: left to right and back, wrapping at the ends; from outside any pane, the first or the last', () => {
	assert.deepEqual(
		[0, 1, 2, 3].map((at) => nextPane(4, at, 1)),
		[1, 2, 3, 0],
	)
	assert.deepEqual(
		[0, 1, 2, 3].map((at) => nextPane(4, at, -1)),
		[3, 0, 1, 2],
	)
	assert.equal(nextPane(4, -1, 1), 0)
	assert.equal(nextPane(4, -1, -1), 3)
	assert.equal(nextPane(0, -1, 1), -1, 'no panes, nowhere to go')
})

test('pane keys: F6 and Shift+F6 everywhere, Ctrl+` too on a Mac, clashing with nothing', () => {
	const mac = resolveKeymap({}, true)
	const other = resolveKeymap({}, false)
	assert.deepEqual(
		[mac.paneNext, mac.panePrev],
		[
			['F6', 'Ctrl+`'],
			['Shift+F6', 'Ctrl+Shift+`'],
		],
	)
	assert.deepEqual([other.paneNext, other.panePrev], [['F6'], ['Shift+F6']])
	assert.equal(keyConflicts(mac).size, 0)
	assert.equal(keyConflicts(other).size, 0)
	const press = { key: '~', code: 'Backquote', metaKey: false, ctrlKey: true, altKey: false, shiftKey: true }
	assert.ok(
		mac.panePrev.some((b) => matchesBinding(press, b, true)),
		'Ctrl+Shift+` arrives as "~" and still matches',
	)
})

test('speaker headings: who said it, with the verdict when there is one', () => {
	assert.equal(speaker({ role: 'you' }), 'You asked')
	assert.equal(speaker({ role: 'ai', model: 'Opus 5.5' }, 'still holds, should fix'), 'Opus 5.5 answered: still holds, should fix')
	assert.equal(speaker({ role: 'ai', model: null }), 'The AI answered')
	assert.equal(speaker({ role: 'ai', model: 'Opus 5.5', error: true }), 'The AI couldn’t answer')
})
