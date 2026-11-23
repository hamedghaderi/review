import { looksSquashed, parseRangeDiff, type RangeCommit } from '../shared/rangeDiff.ts'
import { countCommits, mergeBase, rangeDiff, wholeChangeCommit } from './git.ts'

const MAX_COMMITS = 400 // before and after together
const MAX_BYTES = 8 * 1024 * 1024

/**
 * Lines up the commits on `from` (the head your review was on) with those on `head`, both counted from `base` (where
 * the head leaves the base branch now), so what came from the base branch is on neither side (issue #274). When that
 * says nothing useful because the branch was squashed, each side's whole change is lined up as one commit instead.
 * Throws when git can't; `error` says why nothing could be shown.
 */
export async function lineUpCommits(
	root: string,
	o: { base: string; from: string; head: string; baseLabel: string },
): Promise<{ squashed: boolean; commits: Array<RangeCommit>; error: string | null }> {
	const before = await countCommits(root, o.base, o.from)
	const after = await countCommits(root, o.base, o.head)
	if (before + after > MAX_COMMITS)
		return { squashed: false, commits: [], error: `There are too many commits to line up (${before} before, ${after} now).` }
	const text = await rangeDiff(root, [o.base, o.from], [o.base, o.head], MAX_BYTES)
	if (text === null) return { squashed: false, commits: [], error: 'The commits changed too much to show.' }
	const commits = parseRangeDiff(text)
	if (!looksSquashed(commits)) return { squashed: false, commits, error: null }
	// Where your review's head left the base branch, then each side's whole change as one commit.
	const oldBase = await mergeBase(root, o.from, o.base, o.from.slice(0, 7), o.baseLabel)
	const [was, now] = await Promise.all([wholeChangeCommit(root, o.from, oldBase), wholeChangeCommit(root, o.head, o.base)])
	const whole = await rangeDiff(root, [oldBase, was], [o.base, now], MAX_BYTES)
	if (whole === null) return { squashed: true, commits: [], error: 'The change differs too much to show.' }
	return { squashed: true, commits: parseRangeDiff(whole), error: null }
}
