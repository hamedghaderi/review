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

/**
 * The commit a head failure is compared with: the nearest one at or before the merge base, following first parents,
 * with finished CI. A check that fails there too fails without the change, so it is not evidence against it.
 */
export interface BaseControl {
	sha: string
	back: number // first-parent commits before the merge base; 0: the merge base itself
}

/** How a failed head check did on the base control: also failed, passed, or no finished result under that name. */
export type AtBase = 'fails' | 'passes' | null

/** The checks GitHub reports for one commit: check runs (with the app that made them) and commit statuses. */
export interface CheckList {
	sha: string
	runs: Array<{ name: string; app?: string | null; result: string; completedAt?: string | null }>
	runsOmitted: number
	statuses: Array<{ name: string; result: string }>
}

// Check runs match by app and name, statuses by name; a status and a check run never match each other.
const runKey = (r: { name: string; app?: string | null }): string => `run\u0000${r.app ?? ''}\u0000${r.name}`
const statusKey = (s: { name: string }): string => `status\u0000${s.name}`

/**
 * Each check's finished result on `base`, by key. A name that ran more than once failed if any of its runs failed;
 * one that has not finished has no result.
 */
function finished(base: CheckList): Map<string, 'fails' | 'passes'> {
	const out = new Map<string, 'fails' | 'passes'>()
	const add = (key: string, result: string): void => {
		if (CI_FAILED.has(result)) out.set(key, 'fails')
		else if (CI_PASSED.has(result) && !out.has(key)) out.set(key, 'passes')
	}
	for (const r of base.runs) add(runKey(r), r.result)
	for (const s of base.statuses) add(statusKey(s), s.result)
	return out
}

/** Whether any check on the commit has finished: one without, like a commit pushed with others, gives no control. */
export function hasFinished(c: CheckList): boolean {
	return finished(c).size > 0
}

/** How each check of `head` did on `base`, as AtBase, in a lookup by check. */
export function compareChecks(base: CheckList | null): {
	run(r: { name: string; app?: string | null }): AtBase
	status(s: { name: string }): AtBase
} {
	const results = base ? finished(base) : new Map<string, 'fails' | 'passes'>()
	return { run: (r) => results.get(runKey(r)) ?? null, status: (s) => results.get(statusKey(s)) ?? null }
}

/** "base abc1234", or "abc1234, 2 commits before the merge base". */
export function baseLabel(b: BaseControl): string {
	return b.back === 0
		? `base ${b.sha.slice(0, 7)}`
		: `${b.sha.slice(0, 7)}, ${b.back} commit${b.back === 1 ? '' : 's'} before the merge base`
}

/** The checks GitHub reports for one commit, as the publish dialog weighs an approval. */
export interface HeadChecks {
	sha: string
	// `at`: when a check run finished, newest first; commit statuses have none. `atBase`: compared with `base`.
	failed: Array<{ name: string; at: string | null; atBase?: AtBase }>
	base?: BaseControl | null // the commit failures were compared with; null when none with finished CI was found
	pending: Array<string>
	passed: number
	omitted: number // check runs beyond the first 100, not counted
	readAt: string
}

/** `base`: the control and its checks, when one was found; each failed check then says how it did there. */
export function tallyChecks(c: CheckList, base: { control: BaseControl; checks: CheckList } | null = null): HeadChecks {
	const at = compareChecks(base?.checks ?? null)
	const all = [
		...c.runs.map((r) => ({ name: r.name, result: r.result, at: r.completedAt ?? null, atBase: at.run(r) })),
		...c.statuses.map((s) => ({ name: s.name, result: s.result, at: null, atBase: at.status(s) })),
	]
	return {
		sha: c.sha,
		failed: all
			.filter((x) => CI_FAILED.has(x.result))
			.map(({ name, at, atBase }) => ({ name, at, ...(base ? { atBase } : {}) }))
			.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')),
		base: base?.control ?? null,
		pending: all.filter((x) => !CI_FAILED.has(x.result) && !CI_PASSED.has(x.result)).map((x) => x.name),
		passed: all.filter((x) => CI_PASSED.has(x.result)).length,
		omitted: c.runsOmitted,
		readAt: new Date().toISOString(),
	}
}
