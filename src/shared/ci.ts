/** How a check run's conclusion or a commit status reads: anything not failed or passed has not finished. */
export const CI_FAILED: ReadonlySet<string> = new Set([
	'failure',
	'error',
	'timed_out',
	'cancelled',
	'action_required',
	'startup_failure',
	'stale',
])
export const CI_PASSED: ReadonlySet<string> = new Set(['success', 'neutral', 'skipped'])

/** The checks GitHub reports for one commit, as the publish dialog weighs an approval. */
export interface HeadChecks {
	sha: string
	failed: Array<{ name: string; at: string | null }> // `at`: when a check run finished, newest first; commit statuses have none
	pending: Array<string>
	passed: number
	omitted: number // check runs beyond the first 100, not counted
	readAt: string
}

export function tallyChecks(c: {
	sha: string
	runs: Array<{ name: string; result: string; completedAt?: string | null }>
	runsOmitted: number
	statuses: Array<{ name: string; result: string }>
}): HeadChecks {
	const all = [
		...c.runs.map((r) => ({ name: r.name, result: r.result, at: r.completedAt ?? null })),
		...c.statuses.map((s) => ({ name: s.name, result: s.result, at: null })),
	]
	return {
		sha: c.sha,
		failed: all
			.filter((x) => CI_FAILED.has(x.result))
			.map(({ name, at }) => ({ name, at }))
			.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')),
		pending: all.filter((x) => !CI_FAILED.has(x.result) && !CI_PASSED.has(x.result)).map((x) => x.name),
		passed: all.filter((x) => CI_PASSED.has(x.result)).length,
		omitted: c.runsOmitted,
		readAt: new Date().toISOString(),
	}
}
