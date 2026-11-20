import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changedLines, isMarkdownPath, markdownBlocks, type LineChanges } from '../src/renderer/src/markdownBlocks.ts'
import type { Hunk } from '../src/shared/types.ts'

const doc = [
	'# Title', // 1
	'',
	'First line', // 3
	'second line', // 4
	'',
	'- item a', // 6
	'- item b', // 7
	'  continued', // 8
	'',
	'- item c', // 10
	'',
	'| a | b |', // 12
	'|---|---|',
	'| 1 | 2 |', // 14
	'',
	'```mermaid', // 16
	'graph TD',
	'```', // 18
	'',
	'[a link][r]', // 20
	'',
	'[r]: https://example.com', // 22
	'',
].join('\n')

const none: LineChanges = { added: new Set(), cuts: [] }

test('markdownBlocks: each block with the lines it came from; link definitions show nothing and are left out', () => {
	const blocks = markdownBlocks(doc, none)
	assert.deepEqual(
		blocks.map((b) => [b.start, b.end]),
		[
			[1, 1],
			[3, 4],
			[6, 10],
			[12, 14],
			[16, 18],
			[20, 20],
		],
	)
	assert.deepEqual(
		blocks[2].items?.map((i) => [i.start, i.end]),
		[
			[6, 6],
			[7, 8],
			[10, 10],
		],
	)
	assert.match(blocks[5].html, /<a href="https:\/\/example.com">a link<\/a>/) // the definition still resolves
	assert.match(blocks[4].html, /class="language-mermaid"/)
	assert.ok(blocks.every((b) => !b.changed))
})

test('markdownBlocks: Windows line endings count lines the same', () => {
	assert.deepEqual(
		markdownBlocks(doc.replace(/\n/g, '\r\n'), none).map((b) => [b.start, b.end]),
		markdownBlocks(doc, none).map((b) => [b.start, b.end]),
	)
})

test('markdownBlocks: a block is changed by an added line in it, or lines cut from inside it', () => {
	const blocks = markdownBlocks(doc, { added: new Set([8, 17]), cuts: [[3, 4]] })
	assert.deepEqual(
		blocks.map((b) => b.changed),
		[false, true, true, false, true, false],
	)
	assert.deepEqual(
		blocks[2].items?.map((i) => i.changed),
		[false, true, false],
	)
	// A cut between two blocks (a removed paragraph) touches neither.
	assert.ok(markdownBlocks(doc, { added: new Set(), cuts: [[4, 6]] }).every((b) => !b.changed))
})

test('changedLines: added lines, and removed lines with nothing in their place as a cut between their neighbours', () => {
	const hunks: Array<Hunk> = [
		{
			oldStart: 1,
			oldCount: 6,
			newStart: 1,
			newCount: 5,
			section: '',
			lines: [
				{ kind: 'ctx', oldNo: 1, newNo: 1, text: 'a' },
				{ kind: 'del', oldNo: 2, newNo: null, text: 'b' }, // rewritten: b → B
				{ kind: 'add', oldNo: null, newNo: 2, text: 'B' },
				{ kind: 'ctx', oldNo: 3, newNo: 3, text: 'c' },
				{ kind: 'del', oldNo: 4, newNo: null, text: 'd' }, // removed between c and e
				{ kind: 'ctx', oldNo: 5, newNo: 4, text: 'e' },
				{ kind: 'del', oldNo: 6, newNo: null, text: 'f' }, // removed at the end of the hunk
			],
		},
	]
	const c = changedLines(hunks)
	assert.deepEqual([...c.added], [2])
	assert.deepEqual(c.cuts, [
		[3, 4],
		[4, 5],
	])
})

test('isMarkdownPath: .md and .markdown, any case', () => {
	assert.deepEqual(['README.md', 'docs/a.MARKDOWN', 'a.mdx', 'md', null].map(isMarkdownPath), [true, true, false, false, false])
})
