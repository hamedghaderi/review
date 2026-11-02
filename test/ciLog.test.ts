import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { failedSteps, failureExcerpt, nearFailures, withoutRepeats } from '../src/main/ciLog.ts'
import { loadFacts } from '../src/main/ai/facts.ts'
import type { BaseChecks } from '../src/main/baseCi.ts'
import type { CommitChecks } from '../src/main/github.ts'

const at = (s: string) => `2026-01-05T10:00:00.0000000Z ${s}`

// A job log as GitHub serves it: timestamps, colour codes, a header group per step, ##[error] after a failed step.
const LOG = [
	'##[group]Run actions/checkout@v4',
	'with:',
	'##[endgroup]',
	'Fetching the repository',
	'##[group]Run npm test',
	'npm test',
	'shell: /usr/bin/bash -e {0}',
	'##[endgroup]',
	'\x1b[32m ✓\x1b[0m orders › totals an empty cart',
	' ✓ orders › rejects a failed payment',
	'[app] INFO: invoice 7 failed to send, retrying',
	' ✕ invoices › rounds the tax per line',
	'',
	'  ● invoices › rounds the tax per line',
	'',
	'    expect(received).toBe(expected)',
	'',
	'    Expected: 1.21',
	'    Received: 1.2',
	'',
	'      at Object.<anonymous> (test/invoices.test.js:14:22)',
	'',
	'  ● invoices › rounds the tax per order',
	'',
	'    expect(received).toBe(expected)',
	'',
	'Tests: 2 failed, 40 passed, 42 total',
	'##[error]Process completed with exit code 1.',
	'##[group]Run exit 1',
	'exit 1',
	'##[endgroup]',
	'##[error]Process completed with exit code 1.',
]
	.map(at)
	.join('\r\n')

test('a job log is split into steps, and the failed ones keep their output without GitHub headers or colours', () => {
	const steps = failedSteps(LOG)
	assert.deepEqual(
		steps.map((s) => [s.command, s.error]),
		[
			['npm test', 'Process completed with exit code 1.'],
			['exit 1', 'Process completed with exit code 1.'],
		],
	)
	assert.equal(steps[0].output[0], ' ✓ orders › totals an empty cart', 'timestamp and colour codes removed')
	assert.ok(!steps[0].output.some((l) => l.startsWith('shell:')), 'the step header group is not output')
	assert.deepEqual(
		failedSteps(at('##[group]Run npm test') + '\n' + at('##[endgroup]') + '\n' + at('ok')),
		[],
		'no ##[error], no failed step',
	)
})

test('the excerpt keeps the failures and the totals, drops passing tests and info logs, and states the other failed steps', () => {
	const text = failureExcerpt(LOG, 2000)!
	assert.match(text, /^Step "npm test" failed: Process completed with exit code 1\./)
	assert.match(text, /Expected: 1\.21\n {4}Received: 1\.2/)
	assert.match(text, /test\/invoices\.test\.js:14:22/)
	assert.match(text, /Tests: 2 failed, 40 passed/)
	assert.doesNotMatch(text, /rejects a failed payment/, 'a passing test named "failed" is not a failure')
	assert.doesNotMatch(text, /INFO: invoice 7/, 'an info log line is not a failure')
	assert.match(text, /Step "exit 1" also failed/)
	assert.equal(failureExcerpt(at('##[group]Run npm test') + '\n' + at('##[endgroup]') + '\n' + at('all good'), 2000), null)

	const small = failureExcerpt(LOG, 400)!
	assert.ok(small.length <= 400, `within the budget (${small.length})`)
	assert.match(small, /Tests: 2 failed/, 'the end is kept first')
})

test('a block the runner prints for every failure is kept once', () => {
	const trace = ['  at Ledger.post (src/ledger.js:40:9)', '  at Invoice.close (src/invoice.js:12:3)']
	const lines = ['FAIL invoice A', '', ...trace, '', 'FAIL invoice B', '', ...trace, '', 'FAIL invoice C', '', ...trace]
	const kept = withoutRepeats(lines)
	assert.equal(kept.filter((l) => l.includes('src/ledger.js')).length, 1)
	assert.ok(kept.includes('FAIL invoice C'), 'single lines are never dropped')
	assert.equal(kept[kept.length - 1], '(2 repeated blocks left out)')
})

test('lines far from any failure collapse into one gap', () => {
	const lines = ['step 1', ...Array.from({ length: 50 }, (_, i) => `progress ${i}`), 'Error: cannot open orders.csv', 'done']
	const out = nearFailures(lines)
	assert.equal(out[0], '…')
	assert.ok(out.includes('Error: cannot open orders.csv'))
	assert.ok(out.length < 15)
})

test('the reviewer gets the log of each failed Actions job that passes at base, not of ones failing there too', async () => {
	const head = 'b'.repeat(40)
	const checks: CommitChecks = {
		sha: head,
		runs: [
			{ id: 1, annotations: 0, name: 'lint', app: 'GitHub Actions', result: 'failure' },
			{ id: 2, annotations: 0, name: 'tests', app: 'GitHub Actions', result: 'failure' },
			{ id: 3, annotations: 0, name: 'deploy preview', app: 'Other CI', result: 'failure' },
			{ id: 4, annotations: 0, name: 'build', app: 'GitHub Actions', result: 'success' },
			{ id: 5, annotations: 0, name: 'e2e', app: 'GitHub Actions', result: 'failure' },
		],
		runsOmitted: 0,
		statuses: [],
	}
	const base: BaseChecks = {
		control: { sha: 'a'.repeat(40), back: 0 },
		checks: {
			...checks,
			sha: 'a'.repeat(40),
			runs: checks.runs.map((r) => ({ ...r, id: r.id + 10, result: r.name === 'lint' ? 'failure' : 'success' })),
		},
	}
	const asked: Array<number> = []
	const r = await loadFacts({
		root: mkdtempSync(join(tmpdir(), 'review-cilog-')),
		baseSha: 'a'.repeat(40),
		headSha: head,
		sources: [],
		checks: async () => checks,
		baseChecks: async () => base,
		jobLog: async (id) => {
			asked.push(id)
			if (id === 5) throw new Error('Resource not accessible by personal access token')
			return LOG
		},
	})
	assert.deepEqual(asked, [2, 5], 'only failed Actions jobs that pass at base; never the other app or a passing job')
	const log = r.facts.find((f) => f.title === 'CI log of "tests"')!
	assert.match(log.text, /Expected: 1\.21/)
	assert.ok(r.notes.some((n) => /log of "e2e" could not be read: Resource not accessible/.test(n)))
	assert.ok(r.summary.some((s) => s.text === 'Failure output read from 1 failed CI job log.'))
})
