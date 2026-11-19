import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tabEdit } from '../src/shared/indent.ts'

/** Applies the edit and marks the selection after it: `[` and `]`, or `|` for a cursor. */
function press(marked: string, outdent = false): string | null {
	const start = marked.indexOf('[') === -1 ? marked.indexOf('|') : marked.indexOf('[')
	const text = marked.replace(/[[\]|]/g, '')
	const end = marked.indexOf(']') === -1 ? start : marked.indexOf(']') - 1
	const e = tabEdit(text, start, end, outdent)
	if (!e) return null
	const out = text.slice(0, e.from) + e.insert + text.slice(e.to)
	if (e.selStart === e.selEnd) return out.slice(0, e.selStart) + '|' + out.slice(e.selStart)
	return out.slice(0, e.selStart) + '[' + out.slice(e.selStart, e.selEnd) + ']' + out.slice(e.selEnd)
}

test('Tab types a tab at the cursor, including on an empty line inside a code block', () => {
	assert.equal(press('```python\n@property\ndef fields(self):\n|\n```'), '```python\n@property\ndef fields(self):\n\t|\n```')
	assert.equal(press('a|b'), 'a\t|b')
	assert.equal(press('\t|x'), '\t\t|x', 'twice indents twice')
})

test('Tab in an empty box changes nothing, so focus moves on', () => {
	assert.equal(tabEdit('', 0, 0, false), null)
})

test('Tab with a selection indents every line it touches and keeps the selection, never replacing the text', () => {
	assert.equal(press('[abc]'), '[\tabc]', 'a selection from the start of a line takes in the new tab')
	assert.equal(press('a[b\nc]d'), '\ta[b\n\tc]d')
	assert.equal(press('one\nt[wo\n\nthr]ee\nfour'), 'one\n\tt[wo\n\n\tthr]ee\nfour', 'blank lines stay blank')
	assert.equal(press('[one\ntwo\n]three'), '[\tone\n\ttwo\n]three', 'a selection ending at the start of a line leaves that line alone')
})

test('Shift+Tab takes one tab or up to four spaces off each line', () => {
	assert.equal(press('\t\tx|', true), '\tx|')
	assert.equal(press('      x|', true), '  x|')
	assert.equal(press('  x|', true), 'x|')
	assert.equal(press('[\tone\n    two\nthree]', true), '[one\ntwo\nthree]')
	assert.equal(press('\t|x', true), '|x', 'a cursor inside the removed indent goes to the start of the line')
})

test('Shift+Tab with nothing to outdent changes nothing, so focus moves back', () => {
	assert.equal(press('abc|', true), null)
	assert.equal(press('[one\ntwo]', true), null)
	assert.equal(tabEdit('', 0, 0, true), null)
})
