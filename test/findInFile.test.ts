import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildRows, computeGaps, searchLines } from '../src/renderer/src/diffModel.ts'
import { countLabel, findMatches, firstFrom, MAX_MATCHES } from '../src/renderer/src/findInFile.ts'
import type { Hunk } from '../src/shared/types.ts'

// One hunk in the middle of a nine-line file: lines 1–4 and 8–9 are unchanged and collapsed.
const hunks: Array<Hunk> = [
	{
		oldStart: 5,
		oldCount: 2,
		newStart: 5,
		newCount: 3,
		section: '',
		lines: [
			{ kind: 'ctx', oldNo: 5, newNo: 5, text: 'const total = 0' },
			{ kind: 'del', oldNo: 6, newNo: null, text: 'return Total' },
			{ kind: 'add', oldNo: null, newNo: 6, text: 'total += 1' },
			{ kind: 'add', oldNo: null, newNo: 7, text: 'return total' },
		],
	},
]
const file = ['import x', 'let total', 'b', 'c', 'const total = 0', 'total += 1', 'return total', 'h', '// total']
const gaps = computeGaps(hunks, file.length)

test('find in file looks through collapsed lines, in reading order, keyed like their rows', () => {
	const lines = searchLines(hunks, gaps, file)
	assert.deepEqual(
		lines.map((l) => l.text),
		['import x', 'let total', 'b', 'c', 'const total = 0', 'return Total', 'total += 1', 'return total', 'h', '// total'],
	)
	assert.deepEqual(
		lines.map((l) => l.gapLine),
		[1, 2, 3, 4, null, null, null, null, 8, 9],
	)
	// Every key is the key its row gets once shown, so a match can be painted on it.
	const { rows } = buildRows(hunks, gaps, new Set(file.map((_, i) => i + 1)), file)
	const rowKeys = new Set(rows.flatMap((r) => (r.t === 'line' ? [r.key] : [])))
	assert.ok(lines.every((l) => rowKeys.has(l.key)))
	assert.equal(rowKeys.size, lines.length)
	// Before the file's lines arrive only the hunks are searched.
	assert.deepEqual(
		searchLines(hunks, computeGaps(hunks, null), null).map((l) => l.text),
		['const total = 0', 'return Total', 'total += 1', 'return total'],
	)
})

test('matches ignore case unless asked, and take the query as plain text', () => {
	const lines = searchLines(hunks, gaps, file)
	const { matches } = findMatches(lines, 'total', false)
	assert.equal(matches.length, 6)
	assert.deepEqual(matches[0], { key: lines[1].key, start: 4, end: 9, gapLine: 2 })
	assert.equal(findMatches(lines, 'total', true).matches.length, 5, 'the deleted "Total" is skipped')
	assert.deepEqual(
		findMatches(lines, '+=', false).matches.map((x) => [x.start, x.end]),
		[[6, 8]],
		'regex characters are literal',
	)
	assert.deepEqual(findMatches(lines, '', false).matches, [])
	const many = findMatches([{ key: 'l', text: 'a'.repeat(MAX_MATCHES + 10), gapLine: null }], 'a', false)
	assert.equal(many.matches.length, MAX_MATCHES)
	assert.ok(many.capped)
})

test('a new search starts at the line in view and wraps', () => {
	const lines = searchLines(hunks, gaps, file)
	const order = new Map(lines.map((l, i) => [l.key, i]))
	const { matches } = findMatches(lines, 'total', false)
	assert.equal(firstFrom(matches, order, 0), 0)
	assert.equal(matches[firstFrom(matches, order, 5)].key, lines[5].key, 'from the deleted line, its own match is next')
	assert.equal(firstFrom(matches, order, lines.length), 0, 'past the last line it wraps to the first match')
	assert.equal(firstFrom([], order, 0), -1)
	assert.equal(countLabel(2, 6, false), '3 of 6')
	assert.equal(countLabel(-1, 6, false), '– of 6')
	assert.equal(countLabel(0, MAX_MATCHES, true), `1 of ${MAX_MATCHES}+`)
	assert.equal(countLabel(-1, 0, false), 'No results')
})
