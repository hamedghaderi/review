import { cherryPickedFrom, type BackportCommit } from '../shared/backports.ts'
import { parseRangeDiff } from '../shared/rangeDiff.ts'
import { commitMessages, commitSubjects, countCommits, equivalentCommits, mergeBase, patchIds, rangeDiff, resolveCommit } from './git.ts'

export const MAX_OWN_COMMITS = 300
export const MAX_MAIN_COMMITS = 5000
const MAX_PAIRED = 1000 // the default branch's commits with a twin on this side, to name each one's original
const MAX_DIFFS = 50
const MAX_DIFF_BYTES = 1024 * 1024

/**
 * Matches a pull request's own commits (`base..head`) with their originals on the default branch (`mainTip`, searched
 * since the head split off from it), issue #275:
 * - same: the default branch has a commit with the same patch (git's patch id, so a cherry-pick still counts). Its
 *   original is the one the commit names or shares a subject with when that matches, else any with the same patch.
 * - differs: the commit names an original (`cherry picked from`), or else exactly one commit there has its subject, and
 *   the patches differ. The diff of the diff says how.
 * - none: neither, so new code.
 * Throws when git can't; `error` says why nothing could be matched.
 */
export async function findOriginals(
	root: string,
	o: { base: string; head: string; mainTip: string; mainLabel: string },
): Promise<{ commits: Array<BackportCommit>; error: string | null }> {
	const total = await countCommits(root, o.base, o.head)
	if (total > MAX_OWN_COMMITS) return { commits: [], error: `There are too many commits to match (${total}).` }
	const own = await commitMessages(root, o.base, o.head, MAX_OWN_COMMITS)
	const none = (): Array<BackportCommit> =>
		own.map((c) => ({ sha: c.sha, subject: c.subject, state: 'none', original: null, via: null, pr: null, diff: [] }))
	const split = await mergeBase(root, o.head, o.mainTip, o.head.slice(0, 7), o.mainLabel)
	const behind = await countCommits(root, split, o.mainTip)
	if (behind > MAX_MAIN_COMMITS)
		// Only worth saying when the commits say they're backports; otherwise this is an ordinary pull request.
		return own.some((c) => cherryPickedFrom(c.body))
			? {
					commits: [],
					error: `${o.mainLabel} has ${behind} commits since this branch split off from it, too many to search for the originals.`,
				}
			: { commits: none(), error: null }

	const main = await commitSubjects(root, split, o.mainTip, MAX_MAIN_COMMITS)
	const onMain = new Set(main.map((c) => c.sha))
	const bySubject = new Map<string, Array<string>>()
	for (const c of main) bySubject.set(c.subject, [...(bySubject.get(c.subject) ?? []), c.sha])
	const twins = await equivalentCommits(root, o.mainTip, o.head)

	// The original each commit points at: its cherry-pick line when that commit is here, else the one same subject.
	const named = new Map<string, { sha: string; via: 'cherry-pick' | 'subject' }>()
	for (const c of own) {
		const picked = cherryPickedFrom(c.body)
		const sha = picked ? await resolveCommit(root, picked) : null
		if (sha && sha !== c.sha) named.set(c.sha, { sha, via: 'cherry-pick' })
		else {
			const same = bySubject.get(c.subject)
			if (same?.length === 1 && same[0] !== c.sha) named.set(c.sha, { sha: same[0], via: 'subject' })
		}
	}
	const paired = [...twins.left].filter((s) => onMain.has(s))
	const ids = await patchIds(root, [
		...own.map((c) => c.sha),
		...[...named.values()].map((n) => n.sha),
		...(paired.length <= MAX_PAIRED ? paired : []),
	])
	const byId = new Map<string, string>()
	// Newest first, so the oldest commit with a patch ends up as its original.
	for (const s of main) if (twins.left.has(s.sha) && ids.has(s.sha)) byId.set(ids.get(s.sha)!, s.sha)

	let diffs = 0
	const out: Array<BackportCommit> = []
	for (const c of own) {
		const row: BackportCommit = { sha: c.sha, subject: c.subject, state: 'none', original: null, via: null, pr: null, diff: [] }
		const id = ids.get(c.sha)
		const n = named.get(c.sha)
		const matches = !!n && !!id && ids.get(n.sha) === id
		if (onMain.has(c.sha)) Object.assign(row, { state: 'same', original: c.sha, via: 'patch' })
		else if (matches) Object.assign(row, { state: 'same', original: n.sha, via: n.via })
		else if (twins.right.has(c.sha)) Object.assign(row, { state: 'same', original: (id && byId.get(id)) || null, via: 'patch' })
		else if (n) {
			Object.assign(row, { state: 'differs', original: n.sha, via: n.via })
			if (diffs++ < MAX_DIFFS) row.diff = await diffOfDiff(root, n.sha, c.sha)
		}
		out.push(row)
	}
	return { commits: out, error: null }
}

/** How `now`'s patch differs from `was`'s: the two commits lined up by `git range-diff`. Empty when it can't say. */
async function diffOfDiff(root: string, was: string, now: string): Promise<Array<string>> {
	const [wasParent, nowParent] = await Promise.all([resolveCommit(root, `${was}^`), resolveCommit(root, `${now}^`)])
	if (!wasParent || !nowParent) return []
	// A high creation factor pairs the two however much they differ: they're one commit each, named as the same change.
	const text = await rangeDiff(root, [wasParent, was], [nowParent, now], MAX_DIFF_BYTES, 1000).catch(() => null)
	return parseRangeDiff(text ?? '').find((x) => x.state === 'changed')?.diff ?? []
}
