import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { RunBeat, RunBeatBody } from '../src/shared/types.ts'
import { journeyRows, lookupSummary, lookupText, withLive } from '../src/renderer/src/journeyView.ts'

let seq = 0
const beat = (memberId: string | null, body: RunBeatBody): RunBeat => ({ ...body, seq: seq++, at: 0, memberId }) as RunBeat
const read = (m: string | null, path: string, start: number | null = null, end: number | null = null) =>
	beat(m, { kind: 'read', path, version: 'head', start, end })
const search = (m: string | null, text: string) => beat(m, { kind: 'search', text })
const request = (m: string | null) => beat(m, { kind: 'request', index: 0, total: 1, findings: 0, error: null })
const stage = () => beat(null, { kind: 'stage', stage: 'double-check', text: 'Double-checking' })

test("run rows: each reviewer's lookups fold into one row until it answers, even while another reads in between", () => {
	seq = 0
	const beats = [
		read('a', 'x.ts'),
		read('b', 'y.ts'),
		search('a', 'save('),
		request('a'),
		read('a', 'z.ts'),
		search('b', 'load('),
		stage(),
		read('b', 'w.ts'),
	]
	const rows = journeyRows(beats)
	assert.deepEqual(
		rows.map((r) => (r.kind === 'beat' ? r.beat.kind : `${r.memberId}:${r.beats.map((b) => b.seq).join(',')}`)),
		['a:0,2', 'b:1,5', 'request', 'a:4', 'stage', 'b:7'],
	)
})

test('run rows: lookups read as a summary, or as the one lookup itself', () => {
	seq = 0
	assert.equal(lookupSummary([read('a', 'src/app.ts', 10, 40)]), 'Read src/app.ts:10-40')
	assert.equal(
		lookupSummary([read('a', 'a.ts'), read('a', 'a.ts', 1, 2), read('a', 'b.ts'), search('a', 'x')]),
		'Read 2 files, searched once',
	)
	assert.equal(lookupSummary([search('a', 'x'), search('a', 'y')]), 'Searched 2 times')
	assert.equal(
		lookupText(beat(null, { kind: 'read', path: 'a.ts', version: 'base', start: 3, end: 3 }) as never),
		'Read a.ts:3 (before the change)',
	)
	assert.equal(lookupText(beat(null, { kind: 'list', path: '' }) as never), 'Listed the repository root')
})

test("run rows: live beats add to the run's own, once each and in order, and never repeat what it already has", () => {
	seq = 0
	const stored = [stage(), read('a', 'x.ts')]
	const later = [search('a', 'q'), request('a')]
	assert.deepEqual(
		withLive(stored, [stored[1], later[1], later[0], later[1]]).map((b) => b.seq),
		[0, 1, 2, 3],
	)
})
