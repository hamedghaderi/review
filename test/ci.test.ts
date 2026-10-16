import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tallyChecks } from '../src/shared/ci.ts'

test('CI tally: failed (newest first, with when), not finished and passed, from check runs and commit statuses', () => {
	const t = tallyChecks({
		sha: 'a'.repeat(40),
		runs: [
			{ name: 'lint', result: 'success', completedAt: '2026-01-01T10:00:00Z' },
			{ name: 'unit', result: 'failure', completedAt: '2026-01-01T10:05:00Z' },
			{ name: 'e2e', result: 'timed_out', completedAt: '2026-01-01T10:09:00Z' },
			{ name: 'feature', result: 'in_progress', completedAt: null },
			{ name: 'docs', result: 'skipped', completedAt: null },
		],
		runsOmitted: 2,
		statuses: [
			{ name: 'deploy-preview', result: 'pending' },
			{ name: 'legacy-ci', result: 'error' },
		],
	})
	assert.deepEqual(
		t.failed.map((f) => [f.name, f.at]),
		[
			['e2e', '2026-01-01T10:09:00Z'],
			['unit', '2026-01-01T10:05:00Z'],
			['legacy-ci', null],
		],
	)
	assert.deepEqual(t.pending, ['feature', 'deploy-preview'])
	assert.equal(t.passed, 2, 'skipped counts as passed, as in the review facts')
	assert.equal(t.omitted, 2)
})
