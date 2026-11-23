/**
 * `fixup!`, `squash!` and `amend!` commits (`git commit --fixup` and friends), meant to be folded into an earlier commit
 * by `git rebase --autosquash` before merging (issue #276).
 */
const FIXUP = /^(fixup|squash|amend)! /

export function isFixupSubject(subject: string): boolean {
	return FIXUP.test(subject)
}

/** "2 fixup commits haven't been squashed (fixup! parser: parse sections, squash! tests)." */
export function fixupWarning(commits: ReadonlyArray<{ subject: string }>): string {
	const n = commits.length
	const names = commits.slice(0, 2).map((c) => c.subject)
	const more = n > 2 ? ` and ${n - 2} more` : ''
	return `${n} fixup commit${n === 1 ? ' hasn’t' : 's haven’t'} been squashed (${names.join(', ')}${more}).`
}

/**
 * Whether fixups would land on the base branch as they are: unless the repository only allows squash merges. Unknown
 * settings (GitHub only shows them to some) count as possibly landing.
 */
export function fixupsWouldLand(m: { merge: boolean | null; squash: boolean | null; rebase: boolean | null } | null): boolean {
	return !m || !(m.squash === true && m.merge === false && m.rebase === false)
}
