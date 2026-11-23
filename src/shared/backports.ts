/**
 * A backport's commits matched with their originals on the default branch (issue #275), so the review can go where the
 * backport differs from code that was already reviewed there.
 */
export type BackportState = 'same' | 'differs' | 'none'

export interface BackportCommit {
	sha: string
	subject: string
	/** same: its patch is the original's; differs: it names or shares a subject with an original but changes something else; none: no original found */
	state: BackportState
	original: string | null // null for none, and for a same commit whose twin on the default branch couldn't be named
	via: 'patch' | 'cherry-pick' | 'subject' | null // how the original was found
	pr: { number: number; title: string; url: string } | null // the pull request the original came in with, when GitHub knows it
	diff: Array<string> // for differs: the diff of the diff, as in a force-push's changed commit (empty when too large)
}

export interface Backports {
	defaultBranch: string
	commits: Array<BackportCommit> // oldest first
	error: string | null // why the commits couldn't be matched
}

/** The original a `git cherry-pick -x` line names; the last one when the commit was picked more than once. */
export function cherryPickedFrom(message: string): string | null {
	const all = [...message.matchAll(/\(cherry picked from commit ([0-9a-f]{7,64})\)/g)]
	return all.length ? all[all.length - 1][1] : null
}

/** "3 same as on main, 1 differs, 1 new" */
export function backportSummary(b: Pick<Backports, 'commits' | 'defaultBranch'>): string {
	const n = (s: BackportState) => b.commits.filter((c) => c.state === s).length
	return (
		[
			[n('same'), `same as on ${b.defaultBranch}`],
			[n('differs'), n('differs') === 1 ? 'differs' : 'differ'],
			[n('none'), 'new'],
		] as Array<[number, string]>
	)
		.filter(([k]) => k > 0)
		.map(([k, w]) => `${k} ${w}`)
		.join(', ')
}

/** Whether there's anything worth showing: at least one commit has an original. */
export function isBackport(b: Backports): boolean {
	return b.commits.some((c) => c.state !== 'none')
}
