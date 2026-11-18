import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { clearedLast, SWEEP_MS, type OpenTally } from '../src/renderer/src/cleared.ts'

const at = (open: number, extra: Partial<OpenTally> = {}): OpenTally => ({ runId: 'r1', running: false, open, ...extra })

test('the sweep marks the last open finding added or dismissed, and nothing else', () => {
	assert.equal(clearedLast(at(1), at(0)), true)
	assert.equal(clearedLast(at(3), at(0)), true, 'several at once still counts, e.g. dismissing a folded group')

	assert.equal(clearedLast(null, at(0)), false, 'opening a run with nothing open')
	assert.equal(clearedLast(at(2), at(1)), false, 'findings still open')
	assert.equal(clearedLast(at(0), at(0)), false, 'already clear')
	assert.equal(clearedLast(at(0), at(1)), false, 'a finding put back')
	assert.equal(clearedLast(at(2), at(0, { runId: 'r2' })), false, 'switching to a run with nothing open')
	assert.equal(clearedLast(at(1, { running: true }), at(0, { running: true })), false, 'the run may still add findings')
	assert.equal(clearedLast(at(1, { running: true }), at(0)), false, 'a run finishing is not your doing')
})

test('the stylesheet sweep lasts as long as the panel keeps it', () => {
	const css = readFileSync('src/renderer/src/styles.css', 'utf8')
	const m = /\.cleared-sweep > span \{[^}]*animation: cleared-sweep (\d+)ms/.exec(css)
	assert.ok(m, 'the sweep animation is there')
	assert.equal(Number(m[1]), SWEEP_MS)
})
