import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ANNOUNCE_KEY, announce, attachRegion, runAnnouncement, speakable } from '../src/renderer/src/announce.ts'
import type { AiRun, Finding } from '../src/shared/types.ts'

test('speakable: code blocks and tables by their size, links and formatting as plain text', () => {
	const md = [
		'## What it does',
		'It **moves** the check into `loadRules` ([see](https://x.test/a)).',
		'',
		'```ts src/rules.ts',
		'const a = 1',
		'const b = 2',
		'```',
		'',
		'| File | Risk |',
		'| --- | --- |',
		'| a.ts | high |',
		'| b.ts | low |',
		'',
		'- first point',
		'1. second point',
		'> quoted',
		'![diagram of the flow](img.png)',
		'```',
		'one',
		'```',
	].join('\n')
	assert.equal(
		speakable(md),
		'What it does It moves the check into loadRules (see). Code block, src/rules.ts, 2 lines. Table, 2 rows and 2 columns. first point second point quoted Image: diagram of the flow Code block, 1 line.',
	)
	assert.equal(speakable('snake_case_name and a*b stay as they are'), 'snake_case_name and a*b stay as they are')
})

test('speakable: a long answer is cut at a word and says the rest is on screen', () => {
	const s = speakable(Array.from({ length: 400 }, (_, i) => `word${i}`).join(' '))
	assert.ok(s.length <= 1530, String(s.length))
	assert.match(s, /word\d+… The rest is on screen\.$/)
})

const finding = (severity: Finding['severity']) => ({ severity }) as Finding
const run = (o: Partial<AiRun>) => ({ status: 'running', findings: [], errors: [], verification: null, ...o }) as AiRun

test('run: started, double-checking once, and how it ended; nothing for updates in between', () => {
	assert.deepEqual(runAnnouncement(undefined, run({})), { text: 'AI review started.', kind: 'progress' })
	assert.equal(runAnnouncement(run({}), run({})), null, 'a request finishing is not announced')
	const checking = run({ verification: { total: 2, done: 0, failed: 0 } })
	assert.deepEqual(runAnnouncement(run({}), checking), { text: 'Double-checking 2 blocking findings.', kind: 'progress' })
	assert.equal(runAnnouncement(checking, run({ verification: { total: 2, done: 1, failed: 0 } })), null)

	const done = run({ status: 'completed', findings: [finding('blocking'), finding('nit'), finding('should_fix')] })
	assert.deepEqual(runAnnouncement(checking, done), { text: 'AI review finished: 3 findings, 1 blocking.', kind: 'result' })
	assert.equal(runAnnouncement(run({ status: 'partial' }), done), null, 'only the change from running counts')
	assert.equal(runAnnouncement(run({}), run({ status: 'partial' }))!.text, 'AI review finished: no findings. Some files were not reviewed.')
	assert.equal(runAnnouncement(run({}), run({ status: 'failed', errors: ['Rate limited.'] }))!.text, 'AI review failed: Rate limited.')
	assert.equal(runAnnouncement(run({}), run({ status: 'cancelled' }))!.text, 'AI review stopped.')
	assert.equal(
		runAnnouncement(undefined, run({ commitOf: { reviewId: 'r', target: 't', sha: 'abcdef1234' } }))!.text,
		'AI review of commit abcdef1 started.',
	)
})

test('announce: one region, messages close together said as one, and the setting decides what is said', async () => {
	const store = new Map<string, string>()
	const g = globalThis as { localStorage?: Pick<Storage, 'getItem' | 'setItem'> }
	g.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) }
	const region = { textContent: 'old' } as HTMLElement
	attachRegion(region)
	const settle = () => new Promise((r) => setTimeout(r, 200))
	try {
		announce('Thinking…', 'progress')
		assert.equal(region.textContent, '', 'emptied first, so the same words said again are read again')
		announce('Opus answered: yes.', 'result')
		await settle()
		assert.equal(region.textContent, 'Thinking… Opus answered: yes.')

		announce('Opus answered: yes.', 'result')
		announce('Opus answered: yes.', 'result')
		await settle()
		assert.equal(region.textContent, 'Opus answered: yes.', 'the same answer shown in two places is said once')

		store.set(ANNOUNCE_KEY, 'results')
		announce('Thinking…', 'progress')
		announce('Opus answered: no.', 'result')
		await settle()
		assert.equal(region.textContent, 'Opus answered: no.')

		store.set(ANNOUNCE_KEY, 'off')
		announce('Opus answered: maybe.', 'result')
		await settle()
		assert.equal(region.textContent, 'Opus answered: no.', 'nothing new is said')

		store.set(ANNOUNCE_KEY, 'something old')
		announce('Thinking…', 'progress')
		await settle()
		assert.equal(region.textContent, 'Thinking…', 'an unknown value means everything')
	} finally {
		attachRegion(null)
		delete g.localStorage
	}
})
