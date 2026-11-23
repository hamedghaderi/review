/**
 * What the author changed since your review when the branch was rewritten (issue #274): the commits before and after a
 * force-push lined up by `git range-diff`, which leaves out what came from the base branch on both sides.
 */
export type RangeCommitState = 'same' | 'changed' | 'new' | 'dropped'

export interface RangeCommit {
	state: RangeCommitState
	old: string | null // the commit before the force-push; null for a new one
	new: string | null // the commit after it; null for a dropped one
	subject: string
	diff: Array<string> // for a changed commit, its diff of the diff: each line starts with the outer marker (' ', '-', '+', '@')
}

export interface SinceReview {
	from: string // the head your last review was on
	to: string // the head now
	rewritten: boolean // false: the head moved on from yours (or didn't move), and the usual views say what changed
	squashed: boolean // the commits couldn't be lined up one to one, so `commits` holds the whole change before vs after
	commits: Array<RangeCommit>
	error: string | null // why it couldn't be lined up; the head-to-head views still work
}

const HEADER = /^\s*(\d+|-):\s+([0-9a-f]{40}|-+) ([=!<>]) \s*(\d+|-):\s+([0-9a-f]{40}|-+) (.*)$/
const STATE: Record<string, RangeCommitState> = { '=': 'same', '!': 'changed', '<': 'dropped', '>': 'new' }

/** Parses `git range-diff --no-color --abbrev=40`. Lines that are neither a commit nor its indented diff are ignored. */
export function parseRangeDiff(text: string): Array<RangeCommit> {
	const out: Array<RangeCommit> = []
	for (const line of text.split('\n')) {
		const m = HEADER.exec(line)
		if (m) {
			out.push({
				state: STATE[m[3]],
				old: /^[0-9a-f]{40}$/.test(m[2]) ? m[2] : null,
				new: /^[0-9a-f]{40}$/.test(m[5]) ? m[5] : null,
				subject: m[6],
				diff: [],
			})
			continue
		}
		const last = out[out.length - 1]
		if (last?.state === 'changed' && line.startsWith('    ')) last.diff.push(line.slice(4))
	}
	return out
}

/**
 * Whether lining up commit by commit says nothing useful: several commits became one, or no commit before matches one
 * after. Then the whole change before and after is the better comparison.
 */
export function looksSquashed(commits: ReadonlyArray<RangeCommit>): boolean {
	const before = commits.filter((c) => c.old).length
	const after = commits.filter((c) => c.new).length
	if (!before || !after) return false
	const paired = commits.some((c) => c.state === 'same' || c.state === 'changed')
	return !paired || (after === 1 && before > 1)
}

/** "2 changed, 1 new, 1 dropped, 8 unchanged" */
export function rangeSummary(commits: ReadonlyArray<RangeCommit>): string {
	const n = (s: RangeCommitState) => commits.filter((c) => c.state === s).length
	return (
		[
			[n('changed'), 'changed'],
			[n('new'), 'new'],
			[n('dropped'), 'dropped'],
			[n('same'), 'unchanged'],
		] as Array<[number, string]>
	)
		.filter(([k]) => k > 0)
		.map(([k, w]) => `${k} ${w}`)
		.join(', ')
}
