import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { AiRun, BeatTone, RunBeat, RunBeatBody, RunStage } from '../src/shared/types.ts'
import {
	journeyRows,
	journeyTally,
	lookupSummary,
	lookupText,
	suspicionStory,
	trailLayout,
	withLive,
} from '../src/renderer/src/journeyView.ts'

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

const teamRun = (late = false): AiRun =>
	({
		startedAt: new Date(0).toISOString(),
		team: {
			id: 't',
			name: 'T',
			members: [
				{ id: 'm1', role: 'Opus' },
				{ id: 'm2', role: 'Codex', ...(late ? { late: true } : {}) },
			],
		},
	}) as unknown as AiRun
const at = (m: string | null, stageName: RunStage) => beat(m, { kind: 'stage', stage: stageName, text: stageName })
const shape = (items: ReturnType<typeof trailLayout>['items']) =>
	items.map((x) =>
		x.kind === 'row'
			? `${x.lane}|${x.lines.map((l) => `${l.lane}${l.top ? '^' : ''}${l.bottom ? 'v' : ''}`).join(' ')}`
			: `${x.kind}:${x.lanes.join(',')}${x.kind === 'merge' && x.through.length ? `/${x.through.join(',')}` : ''}`,
	)

test('trail: one model stays on the spine, which starts at the first step and stops at the newest', () => {
	seq = 0
	const rows = journeyRows([at(null, 'sources'), at(null, 'packed'), read(null, 'a.ts'), request(null)])
	const { items, lanes } = trailLayout({ startedAt: '', team: null } as unknown as AiRun, rows)
	assert.equal(lanes, 0)
	assert.deepEqual(shape(items), ['0|0v', '0|0^v', '0|0^v', '0|0^'])
})

test('trail: a team splits into a strand per reviewer once packed, and joins again at the next stage', () => {
	seq = 0
	const rows = journeyRows([
		at(null, 'sources'),
		at(null, 'packed'),
		read('m1', 'a.ts'),
		request('m2'),
		request('m1'),
		at(null, 'double-check'),
		beat('m2', { kind: 'verdict', of: 'finding', title: 't', tone: 'cleared', reason: 'r', findingId: 'f', path: null, line: null }),
		at(null, 'finished'),
	])
	const { items, lanes } = trailLayout(teamRun(), rows)
	assert.equal(lanes, 2)
	assert.deepEqual(shape(items), [
		'0|0v',
		'0|0^v',
		'fork:1,2',
		'1|1^v 2^v',
		'2|1^v 2^v',
		'1|1^v 2^v',
		'merge:1,2',
		'0|0^v',
		'0|0^v', // a check after the join sits on the spine, with its checker's name on the row
		'0|0^',
	])
})

test('trail: a reviewer the run does not wait for keeps its strand past the join, until the late finish', () => {
	seq = 0
	const rows = journeyRows([at(null, 'packed'), request('m1'), at(null, 'finished'), request('m2'), at(null, 'late-finished')])
	assert.deepEqual(shape(trailLayout(teamRun(true), rows).items), [
		'0|0v',
		'fork:1,2',
		'1|1^v 2^v',
		'merge:1/2',
		'0|0^v 2^v',
		'2|0^v 2^v',
		'merge:2',
		'0|0^',
	])
})

test('tally: a raised finding counts as its double-check verdict once there is one', () => {
	seq = 0
	const f = (id: string, tone: BeatTone) =>
		beat('m1', { kind: 'finding', findingId: id, title: id, severity: 'blocking', path: 'a', line: 1, tone })
	const v = (id: string, tone: BeatTone) =>
		beat('m2', { kind: 'verdict', of: 'finding', title: id, tone, reason: '', findingId: id, path: null, line: null })
	const near = beat('m2', {
		kind: 'verdict',
		of: 'near-miss',
		title: 'n',
		tone: 'confirmed',
		reason: '',
		findingId: null,
		path: null,
		line: null,
	})
	assert.deepEqual(journeyTally([f('a', 'pending'), f('b', 'pending'), f('c', 'concern'), v('a', 'cleared'), near]), {
		cleared: 1,
		confirmed: 1,
		concern: 1,
		unsettled: 0,
		pending: 1,
	})
})

// The drawer's styles sit at the end of styles.css, so a class name it shares with the rest of the app restyles that
// too: `.run-line` once turned the Findings panel's header into a 2px strip.
test('run drawer styles: no rule of its own that reaches outside the drawer', () => {
	const css = readFileSync('src/renderer/src/styles.css', 'utf8')
	const cut = css.indexOf('/* The Run drawer under the review')
	assert.ok(cut > 0)
	const before = css.slice(0, cut)
	const mine = css.slice(cut).replace(/\/\*[\s\S]*?\*\//g, '')
	// What each rule hangs on: the first class of its selector. A modifier after it (`.console-out.error`) or a class
	// inside it (`.console-hint .mono`) only applies within the drawer's own elements.
	const owners = new Set<string>()
	for (const [, selectors] of mine.matchAll(/([^{}]+)\{/g))
		for (const sel of selectors.split(',')) {
			const first = /^\s*\.([a-z][a-z0-9-]*)/.exec(sel)
			if (first) owners.add(first[1])
			else if (!/^\s*(from|to|\d+%|@keyframes|body)/.test(sel)) assert.fail(`a rule not scoped by a class: ${sel.trim()}`)
		}
	const animations = [...mine.matchAll(/@keyframes ([a-z-]+)/g)].map((m) => m[1])
	const taken = (n: string) => new RegExp(`\\.${n}(?![a-z0-9-])`).test(before)
	assert.deepEqual([...owners].filter(taken), [])
	assert.deepEqual(
		animations.filter((n) => before.includes(`@keyframes ${n}`)),
		[],
	)
})

test('suspicions: one that became a finding has no row of its own, and its node takes the double-check once there is one', () => {
	seq = 0
	const sus = (id: string) => beat('m1', { kind: 'suspicion', id, text: `suspect ${id}`, path: null, line: null })
	const settled = (
		id: string,
		outcome: 'cleared' | 'near-miss' | 'finding' | 'unsettled',
		tone: BeatTone,
		findingId: string | null = null,
	) => beat('m1', { kind: 'settled', id, outcome, tone, reason: '', path: null, line: null, findingId })
	const beats = [
		sus('a'),
		sus('b'),
		sus('c'),
		sus('d'),
		read('m1', 'x.ts'),
		request('m1'),
		beat('m1', {
			kind: 'finding',
			findingId: 'f',
			title: 'f',
			severity: 'blocking',
			path: 'x.ts',
			line: 1,
			tone: 'pending',
			suspicionId: 'a',
		}),
		settled('a', 'finding', 'pending', 'f'),
		settled('b', 'cleared', 'cleared'),
		settled('c', 'near-miss', 'concern'),
	]
	assert.ok(!journeyRows(beats).some((r) => r.kind === 'beat' && r.beat.kind === 'settled' && r.beat.outcome === 'finding'))
	let story = suspicionStory(beats)
	assert.deepEqual(
		[...story.state],
		[
			['a', 'pending'],
			['b', 'cleared'],
			['c', 'concern'],
		],
		'"d" is still open',
	)
	assert.equal(story.text.get('b'), 'suspect b')
	const checked = [
		...beats,
		beat('m2', { kind: 'verdict', of: 'finding', title: 'f', tone: 'confirmed', reason: '', findingId: 'f', path: null, line: null }),
	]
	story = suspicionStory(checked)
	assert.equal(story.state.get('a'), 'confirmed')
	assert.deepEqual(journeyTally(checked), { cleared: 1, confirmed: 1, concern: 1, unsettled: 0, pending: 0 })
})
