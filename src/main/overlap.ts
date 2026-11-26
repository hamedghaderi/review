import type { OverlapPr, PrGraphNode } from '../shared/types.ts'
import { generatedPath } from './symbols.ts'

/** Other open PRs read for file lists, the most recently updated first; 4 queries at most. */
export const OVERLAP_MAX_PRS = 100

/**
 * The other PRs that change any of `own` (issue #304), most shared files first. Lockfiles and generated or vendored
 * files don't count: every PR touching the lockfile isn't overlap.
 */
export function overlaps(
	own: ReadonlyArray<string>,
	others: ReadonlyArray<PrGraphNode & { paths: ReadonlyArray<string> }>,
): Array<OverlapPr> {
	const mine = new Set(own.filter((p) => !generatedPath(p)))
	return others
		.map((n) => ({
			number: n.number,
			title: n.title,
			url: n.url,
			draft: n.draft,
			author: n.author,
			files: [...new Set(n.paths.filter((p) => mine.has(p)))],
		}))
		.filter((o) => o.files.length)
		.sort((a, b) => b.files.length - a.files.length)
}
