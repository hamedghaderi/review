import { foldedMessage, planFixups } from '../shared/fixups.ts'
import type { CommitEntry } from '../shared/types.ts'
import { commitDetails, replayChange, standInCommit } from './git.ts'

/**
 * A review's commits to step through with each fixup! / squash! / amend! commit folded into the commit it names, the way
 * `git rebase --autosquash` would (issue #276): that commit becomes a stand-in with the fixups replayed onto it in
 * memory, so its step shows its final form, and the fixups leave the list. The commits in between stay as they are.
 * When a fixup doesn't apply cleanly onto it (it changes lines a commit in between wrote), none of that commit's fixups
 * fold and each says why.
 */
export async function foldFixups(
	root: string,
	commits: ReadonlyArray<CommitEntry>,
): Promise<{ steps: Array<CommitEntry>; folded: number }> {
	const into = planFixups(commits)
	if (!into.size) return { steps: [...commits], folded: 0 }
	const groups = new Map<number, Array<number>>()
	for (const [fixup, target] of into) groups.set(target, [...(groups.get(target) ?? []), fixup])
	const details = await commitDetails(
		root,
		[...groups.keys(), ...into.keys()].map((i) => commits[i].sha),
	)

	const standIn = new Map<number, CommitEntry>()
	const why = new Map<number, string>() // fixup → why it isn't folded
	for (const [t, fixups] of groups) {
		const target = commits[t]
		const r = await fold(
			root,
			target,
			fixups.map((i) => commits[i]),
			details,
		).catch((e: Error) => ({
			error: `it couldn’t be replayed: ${e.message}`,
		}))
		if ('error' in r) for (const f of fixups) why.set(f, r.error)
		else
			standIn.set(t, {
				...target,
				sha: r.sha,
				subject: r.message.split('\n')[0],
				folded: { original: target.sha, fixups: fixups.map((i) => ({ sha: commits[i].sha, subject: commits[i].subject })) },
			})
	}
	const steps: Array<CommitEntry> = []
	let folded = 0
	commits.forEach((c, i) => {
		const t = into.get(i)
		if (t !== undefined && !why.has(i)) return void folded++
		if (t !== undefined) steps.push({ ...c, unfolded: { target: commits[t].sha, why: why.get(i)! } })
		else steps.push(standIn.get(i) ?? c)
	})
	return { steps, folded }
}

async function fold(
	root: string,
	target: CommitEntry,
	fixups: Array<CommitEntry>,
	details: Map<string, { name: string; email: string; date: string; message: string }>,
): Promise<{ sha: string; message: string } | { error: string }> {
	const author = details.get(target.sha)
	if (!author) return { error: 'its commit couldn’t be read' }
	let tip = target.sha
	let tree = ''
	for (const [n, f] of fixups.entries()) {
		// The fixup's own change (its parent to it), replayed onto the commit as folded so far.
		const r = await replayChange(root, { from: f.sha, onto: tip, base: f.parent })
		if (r.conflicted.length) return { error: `it changes lines a commit in between wrote, in ${r.conflicted.slice(0, 3).join(', ')}` }
		tree = r.tree
		if (n < fixups.length - 1) tip = await standInCommit(root, { tree, parent: target.parent, message: 'Folding fixups', author })
	}
	const message = foldedMessage(
		author.message,
		fixups.map((f) => ({ message: details.get(f.sha)?.message ?? f.subject })),
	)
	return { sha: await standInCommit(root, { tree, parent: target.parent, message, author }), message }
}
