import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRows, computeGaps, snippet } from '../src/renderer/src/diffModel.ts'
import type { Hunk } from '../src/shared/types.ts'

// Line 3 changed; the file is 8 lines, so 1 and 5–8 are collapsed unless revealed.
const hunks: Array<Hunk> = [
	{
		oldStart: 2,
		oldCount: 3,
		newStart: 2,
		newCount: 3,
		section: '',
		lines: [
			{ kind: 'ctx', oldNo: 2, newNo: 2, text: 'function f() {' },
			{ kind: 'del', oldNo: 3, newNo: null, text: '  return `a`' },
			{ kind: 'add', oldNo: null, newNo: 3, text: '  return ```b```' },
			{ kind: 'ctx', oldNo: 4, newNo: 4, text: '}' },
		],
	},
]
const file = ['// top', 'function f() {', '  return ```b```', '}', '', 'const a = 1', 'const b = 2', 'export { f }']
const gaps = computeGaps(hunks, file.length)

test('copy with location: the lines under path:line, in a fence the code cannot close (issue #245)', () => {
	const { rows } = buildRows(hunks, gaps, new Set(), file)
	assert.equal(
		snippet(rows, { side: 'new', start: 2, end: 4 }, 'src/f.ts', 'ts'),
		'src/f.ts:2-4\n````ts\nfunction f() {\n  return ```b```\n}\n````\n',
	)
	assert.equal(
		snippet(rows, { side: 'old', start: 3, end: 3 }, 'src/f.ts', null),
		'src/f.ts:3 (before the change)\n```\n  return `a`\n```\n',
		'removed code says so; no language: a bare fence',
	)
	// A range across collapsed lines: what is shown, with "…" where lines are left out.
	const { rows: some } = buildRows(hunks, gaps, new Set([8]), file)
	assert.equal(snippet(some, { side: 'new', start: 4, end: 8 }, 'f.ts', 'ts'), 'f.ts:4-8\n```ts\n}\n…\nexport { f }\n```\n')
})
