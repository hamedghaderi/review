import type { AfterMergeResult } from '../shared/types.ts'
import { AppFail, git, isSha } from './git.ts'
import { Mapper } from './linemap.ts'

/** How long after a merge a finding's lines are followed. */
export const AFTER_MERGE_DAYS = 90
const MAX_COMMITS = 2000 // commits touching the followed files, per listing

/** The pull request that merged, to recognise GitHub's own revert of it. */
export interface MergedRef {
	repo: string // "owner/name"
	number: number
	title: string
	mergeCommit: string
}

/** Lines of a finding on the pull request's head commit. */
export interface FollowTarget {
	id: string
	path: string
	start: number
	end: number
}

/**
 * Follows each target's lines from the pull request's head into its merge commit, then along the base branch's
 * first-parent history up to `end`, and reports the first commit that changed them. A commit that reverts the pull
 * request is "reverted": it was undone. Lines nothing changed are "untouched". Read-only: nothing is checked out or run.
 */
export async function followAfterMerge(
	root: string,
	head: string,
	pr: MergedRef,
	end: string,
	targets: Array<FollowTarget>,
): Promise<Map<string, AfterMergeResult>> {
	const merge = pr.mergeCommit
	if (![head, merge, end].every(isSha)) throw new AppFail('invalid-input', 'Invalid commit id.')
	const out = new Map<string, AfterMergeResult>()
	const unknown = (id: string, reason: string): void => void out.set(id, { state: 'unknown', commit: null, reason })
	if (!(await ancestor(root, merge, end))) {
		for (const t of targets) unknown(t.id, 'The merge commit is no longer on the base branch (it was rewritten).')
		return out
	}

	// Onto the merge commit. A squash or merge usually leaves the lines as they were; where it didn't (a conflict), follow
	// them to what replaced them.
	const onto = new Mapper(root, head, merge)
	let open: Array<FollowTarget> = []
	for (const t of targets) {
		const m = await onto.move(t.path)
		if (!m.path) {
			unknown(t.id, 'Its file is not in the merge commit.')
			continue
		}
		const r = (await onto.range(m, t.start, t.end)) ?? (await onto.near(m, t.start, t.end))
		open.push({ ...t, path: m.path, ...r })
	}

	// Along the base branch: only commits that touch a followed file can change its lines. A rename moves the file out
	// of the listing, so the commits after it are listed again under the new path.
	let at = merge
	while (open.length) {
		const commits = await touching(root, at, end, [...new Set(open.map((t) => t.path))])
		let renamed = false
		for (const c of commits) {
			const step = new Mapper(root, at, c)
			const still: Array<FollowTarget> = []
			for (const t of open) {
				const m = await step.move(t.path)
				const r = m.path ? await step.range(m, t.start, t.end) : null
				if (!m.path || !r) {
					out.set(t.id, await changedBy(root, c, pr))
					continue
				}
				if (m.path !== t.path) renamed = true
				still.push({ ...t, path: m.path, ...r })
			}
			open = still
			at = c
			if (renamed || !open.length) break
		}
		if (!renamed) break
	}
	for (const t of open) out.set(t.id, { state: 'untouched', commit: null, reason: null })
	return out
}

async function ancestor(root: string, a: string, b: string): Promise<boolean> {
	const r = await git(root, ['merge-base', '--is-ancestor', a, b])
	if (r.code > 1) throw new AppFail('git-failed', `git merge-base failed: ${r.stderr.trim()}`)
	return r.code === 0
}

/** Commits after `from` up to `to` on the first-parent line that touch any of `paths`, oldest first. */
async function touching(root: string, from: string, to: string, paths: Array<string>): Promise<Array<string>> {
	const r = await git(
		root,
		['rev-list', '--first-parent', '--reverse', `--max-count=${MAX_COMMITS}`, `${from}..${to}`, '--', ...paths],
		1024 * 1024,
	)
	if (r.code !== 0) throw new AppFail('git-failed', `git rev-list failed: ${r.stderr.trim()}`)
	return r.stdout.toString('utf8').split('\n').filter(isSha)
}

/**
 * The commit that changed a finding's lines: "reverted" when its message reverts the pull request, as `git revert` writes
 * it ("This reverts commit <merge>") or as GitHub's Revert button does (`Revert "<title>"`, "Reverts owner/name#N").
 */
async function changedBy(root: string, sha: string, pr: MergedRef): Promise<AfterMergeResult> {
	const r = await git(root, ['show', '-s', '--format=%cI%n%s%n%b', sha], 256 * 1024)
	if (r.code !== 0) throw new AppFail('git-failed', `git show failed: ${r.stderr.trim()}`)
	const [at = '', subject = '', ...rest] = r.stdout.toString('utf8').split('\n')
	const body = rest.join('\n')
	const reverts =
		body.includes(`This reverts commit ${pr.mergeCommit}`) ||
		body.toLowerCase().includes(`reverts ${pr.repo.toLowerCase()}#${pr.number}`) ||
		subject.startsWith(`Revert "${pr.title}"`)
	return { state: reverts ? 'reverted' : 'changed', commit: { sha, subject, at }, reason: null }
}
