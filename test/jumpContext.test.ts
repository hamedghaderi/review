import assert from 'node:assert/strict'
import { test } from 'node:test'
import { blockSpan, computeGaps, jumpContext } from '../src/renderer/src/diffModel.ts'
import type { Hunk } from '../src/shared/types.ts'

test('a jump opens the lines above and the block the line opens, read from indentation (issue #244)', () => {
	const py = [
		'class Model:', // 1
		'    @property', // 2
		'    def _links(', // 3
		'        self,', // 4
		'    ) -> Iterator[tuple[str, str]]:', // 5: closes the signature and opens the body
		'        for link in self.links:', // 6
		'', // 7
		'            yield link', // 8
		'', // 9
		'    def other(self):', // 10
		'        pass', // 11
	]
	assert.deepEqual(blockSpan(py, 3), { start: 1, end: 8 }, 'decorator above, multi-line signature, body; not the next method')
	assert.deepEqual(blockSpan(py, 10), { start: 7, end: 11 }, 'the end of the file stops it')

	const js = ['function f() {', '  return 1', '}', '', 'const a = 1', 'const b = 2', 'const c = 3', 'const d = 4', 'const e = 5']
	assert.deepEqual(blockSpan(js, 1), { start: 1, end: 4 }, 'the closing brace belongs to the block')
	assert.deepEqual(blockSpan(js, 6), { start: 3, end: 9 }, 'a line that opens nothing gets a few lines each side')

	const long = ['def big():', ...Array.from({ length: 100 }, (_, i) => `    x${i} = ${i}`)]
	assert.deepEqual(blockSpan(long, 1), { start: 1, end: 41 }, 'a long body is cut; the rest stays collapsed')
})

test('a jump on the old side maps through the gap it sits in; a removed line opens only itself', () => {
	// Line 5 changed, and a line was added after it: unchanged lines below it are one further down in the new version.
	const hunks: Array<Hunk> = [
		{
			oldStart: 5,
			oldCount: 1,
			newStart: 5,
			newCount: 2,
			section: '',
			lines: [
				{ kind: 'del', oldNo: 5, newNo: null, text: 'old' },
				{ kind: 'add', oldNo: null, newNo: 5, text: 'new' },
				{ kind: 'add', oldNo: null, newNo: 6, text: 'added' },
			],
		},
	]
	const file = ['a', 'b', 'c', 'd', 'new', 'added', 'def f():', '    return 1', '', 'z', 'y', 'x']
	const gaps = computeGaps(hunks, file.length)
	assert.deepEqual(jumpContext(gaps, file, 'old', 6), { side: 'new', start: 4, end: 10 }, 'old 6 is new 7')
	assert.deepEqual(jumpContext(gaps, file, 'new', 7), { side: 'new', start: 4, end: 10 })
	assert.deepEqual(jumpContext(gaps, file, 'old', 5), { side: 'old', start: 5, end: 5 })
})
