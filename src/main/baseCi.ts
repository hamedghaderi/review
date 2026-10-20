import { hasFinished, type BaseControl } from '../shared/ci.ts'
import type { CiAnnotation } from '../shared/types.ts'
import { AppFail, git } from './git.ts'
import type { CommitChecks } from './github.ts'
import { Mapper } from './linemap.ts'

/**
 * The base commit's CI as a control for head CI: a check or a CI message seen on the base too was there without the
 * change, so it is not evidence against it. The merge base is the control; when it has no finished CI of its own (a
 * commit pushed together with others), the nearest first-parent commit before it that has.
 */

export const MAX_BACK = 5 // first-parent commits tried before the merge base
const MAX_ANNOTATED_RUNS = 10

export interface BaseChecks {
	control: BaseControl
	checks: CommitChecks
}

/**
 * The merge base's CI, else that of the nearest of the `MAX_BACK` first-parent commits before it with finished
 * results. Null when none has: failures are then left unmarked. A commit GitHub doesn't know is skipped.
 */
export async function readBaseChecks(
	root: string,
	mergeBase: string,
	read: (sha: string) => Promise<CommitChecks>,
	signal?: AbortSignal,
): Promise<BaseChecks | null> {
	const r = await git(root, ['rev-list', '--first-parent', `--max-count=${MAX_BACK + 1}`, mergeBase, '--'], 64 * 1024, { signal })
	if (r.code !== 0) throw new AppFail('git-failed', `git rev-list failed: ${r.stderr.toString().trim()}`)
	const shas = r.stdout.toString('utf8').split('\n').filter(Boolean)
	for (const [back, sha] of shas.entries()) {
		let checks: CommitChecks
		try {
			checks = await read(sha)
		} catch (e) {
			if (signal?.aborted) throw e
			if (e instanceof Error && /not found|no commit found/i.test(e.message)) continue
			throw e
		}
		if (hasFinished(checks)) return { control: { sha, back }, checks }
	}
	return null
}

/**
 * Marks each head annotation that the same check also reported at the base control, with the same level and text, on
 * lines that have not changed since. Only the checks that annotated the head are read at the base.
 */
export async function markPreExisting(
	root: string,
	headSha: string,
	annotations: Array<CiAnnotation>,
	base: BaseChecks,
	fetch: (runId: number) => Promise<Array<Omit<CiAnnotation, 'check'>>>,
): Promise<{ annotations: Array<CiAnnotation>; notes: Array<string> }> {
	const notes: Array<string> = []
	const names = new Set(annotations.map((a) => a.check))
	const runs = base.checks.runs.filter((r) => r.annotations > 0 && names.has(r.name))
	const atBase: Array<CiAnnotation> = []
	for (const r of runs.slice(0, MAX_ANNOTATED_RUNS)) {
		try {
			atBase.push(...(await fetch(r.id)).map((a) => ({ ...a, check: r.name })))
		} catch (e) {
			notes.push(
				`CI annotations of "${r.name}" at ${base.control.sha.slice(0, 7)} could not be read: ${e instanceof Error ? e.message : String(e)}`,
			)
		}
	}
	if (!atBase.length) return { annotations, notes }
	const m = new Mapper(root, base.control.sha, headSha)
	const same = (a: Omit<CiAnnotation, 'path' | 'startLine' | 'endLine'>, b: typeof a): boolean =>
		a.check === b.check && a.level === b.level && a.title === b.title && a.message === b.message
	const out: Array<CiAnnotation> = []
	for (const a of annotations) {
		let found = false
		for (const b of atBase) {
			if (!same(a, b)) continue
			const move = await m.move(b.path)
			if (move.path !== a.path) continue
			const range = await m.range(move, b.startLine, b.endLine)
			if (range && range.start === a.startLine && range.end === a.endLine) {
				found = true
				break
			}
		}
		out.push(found ? { ...a, atBase: base.control.sha } : a)
	}
	return { annotations: out, notes }
}
