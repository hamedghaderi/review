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

const PREFIX = /^(fixup|squash|amend)! /

/**
 * Which earlier commit each fixup! / squash! / amend! commit folds into, by git's own rule for `rebase --autosquash`
 * (oldest first in, index of the commit each one folds into out). After the prefixes, the rest is matched with an
 * earlier commit's whole subject, else with an earlier commit's id when it is one word, else with the start of an earlier
 * commit's subject; the oldest match wins. A fixup of a fixup folds into the same commit.
 */
export function planFixups(commits: ReadonlyArray<{ sha: string; subject: string }>): Map<number, number> {
	const into = new Map<number, number>()
	const bySubject = new Map<string, number>()
	commits.forEach((c, i) => {
		if (PREFIX.test(c.subject)) {
			let rest = c.subject
			while (PREFIX.test(rest)) rest = rest.replace(PREFIX, '')
			let target = bySubject.get(rest)
			if (target === undefined && /^[0-9a-f]{4,64}$/.test(rest)) {
				const ids = commits.slice(0, i).flatMap((x, j) => (x.sha.startsWith(rest) ? [j] : []))
				if (ids.length === 1) target = ids[0]
			}
			if (target === undefined && rest) {
				const j = commits.slice(0, i).findIndex((x) => x.subject.startsWith(rest))
				if (j >= 0) target = j
			}
			if (target !== undefined) into.set(i, into.get(target) ?? target)
		}
		if (!bySubject.has(c.subject)) bySubject.set(c.subject, i)
	})
	return into
}

/**
 * The message a commit ends up with once its fixups are folded in: an amend! replaces it with its own (less its first
 * line), a squash! adds its own below (less its first line), a fixup! leaves it alone.
 */
export function foldedMessage(target: string, fixups: ReadonlyArray<{ message: string }>): string {
	let out = target.trimEnd()
	for (const f of fixups) {
		const [first, ...rest] = f.message.trimEnd().split('\n')
		const body = rest.join('\n').trim()
		if (first.startsWith('amend! ')) out = body || out
		else if (first.startsWith('squash! ') && body) out = `${out}\n\n${body}`
	}
	return out
}
