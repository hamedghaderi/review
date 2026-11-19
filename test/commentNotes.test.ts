import assert from 'node:assert/strict'
import test from 'node:test'
import { withoutNotes } from '../src/renderer/src/commentNotes.ts'

test('withoutNotes: hides the HTML comments GitHub hides, keeps the ones it shows', () => {
	assert.equal(withoutNotes('<!-- coderabbit-ai-generated:v1 -->\n\nHello').trim(), 'Hello')
	assert.equal(withoutNotes('   <!-- three spaces is still a note -->\nShown'), 'Shown')
	assert.equal(withoutNotes('<!-- a note\nover lines -->\nAfter'), 'After')
	assert.equal(withoutNotes('<!-- note --> Hello\nWorld'), ' Hello\nWorld', 'text after the note on its line stays')
	assert.equal(withoutNotes('<!--> not closed by itself\nstill -->\nAfter'), 'After')
	assert.equal(withoutNotes('Done <!-- bot metadata -->'), 'Done ', 'a closed note inside a line is hidden too')
	assert.equal(withoutNotes('a <!-- x --> b <!-- y --> c'), 'a  b  c')
	assert.equal(withoutNotes('<!-- note --> Done <!-- more -->'), ' Done ')
	assert.equal(
		withoutNotes('```js\n<!-- code -->\n``` not a close\n<!-- still code -->\n```\n<!-- note -->\nEnd'),
		'```js\n<!-- code -->\n``` not a close\n<!-- still code -->\n```\nEnd',
		'a fence closes only on a line of its own',
	)
	assert.equal(withoutNotes('Done <!-- bot metadata\nmore -->\nNext'), 'Done \nNext', 'a note that starts after text can run over lines')
	assert.equal(withoutNotes('Done <!-- a\nb\nc --> kept\nNext'), 'Done \n kept\nNext', 'text after its --> stays')
	assert.equal(withoutNotes('Done <!-- never closed\nNext'), 'Done <!-- never closed\nNext')
	assert.equal(withoutNotes('```\r\n<!-- code -->\r\n```\r\n<!-- note -->\r\nEnd'), '```\n<!-- code -->\n```\nEnd', 'Windows line endings')
	assert.equal(
		withoutNotes('> ```html\n> <!-- quoted code -->\n> ```\n<!-- note -->\nEnd'),
		'> ```html\n> <!-- quoted code -->\n> ```\nEnd',
		'a fence in a quote',
	)
	assert.equal(withoutNotes('>     <!-- quoted indented code -->'), '>     <!-- quoted indented code -->')
	assert.equal(withoutNotes('> <!-- a quoted note -->\n> Shown'), '> \n> Shown', 'a note in a quote still hides')
	assert.equal(withoutNotes('``` a`b\n<!-- a note -->\nEnd'), '``` a`b\nEnd', 'backticks after the fence: not a fence, so the note hides')

	const kept = [
		'Use `<!--` to start a comment',
		'Use ``<!-- x -->`` inline',
		'Use `` `<!-- x -->` `` inline',
		'Escaped \\<!-- shown --> text',
		'Before <!-- never closed',
		'<!-- never closed\nWorld',
		'```html\n<!-- in a fence -->\n```',
		'~~~~\n```\n<!-- still in the outer fence -->\n~~~~',
		'Write:\n\n    <!-- indented code -->\n\nlike that',
		'\t<!-- tab-indented code -->',
	]
	for (const body of kept) assert.equal(withoutNotes(body), body, body)

	assert.equal(withoutNotes('```\n<!-- code -->\n```\n<!-- note -->\nEnd'), '```\n<!-- code -->\n```\nEnd', 'notes after a fence still go')
})

test('withoutNotes: code spans over lines, and fences that end with their quote', () => {
	assert.equal(withoutNotes('Use `<!-- x\n-->` like this'), 'Use `<!-- x\n-->` like this', 'a code span that closes on the next line')
	assert.equal(withoutNotes('Use `a\n\n<!-- note -->\nb`'), 'Use `a\n\nb`', 'a blank line ends the paragraph, so no span')
	assert.equal(withoutNotes('``two <!-- x -->\nstill`` <!-- note -->\nEnd'), '``two <!-- x -->\nstill`` \nEnd')
	assert.equal(withoutNotes('> ```\n> code\n\n<!-- note -->\nEnd'), '> ```\n> code\n\nEnd', 'leaving the quote ends its fence')
	assert.equal(
		withoutNotes('> ```\n> <!-- quoted code -->\n> ```\n> <!-- quoted note -->\n> End'),
		'> ```\n> <!-- quoted code -->\n> ```\n> \n> End',
	)
})
