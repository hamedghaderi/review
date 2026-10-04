import { git } from '../git.ts'
import type { CommitChecks } from '../github.ts'
import type { ContextFact, FileSource } from './context.ts'
import { dependencyFacts } from './deps.ts'
import { annotationFacts } from './evidence.ts'
import type { CiAnnotation } from '../../shared/types.ts'

export interface FactsResult {
	facts: Array<ContextFact>
	notes: Array<string>
	summary: Array<{ kind: ContextFact['kind']; text: string }>
	annotations: Array<CiAnnotation> // CI messages on the changed files, for checking findings after the review
}

const MAX_ANNOTATED_RUNS = 10

/** Maintainer-written notes about the codebase (where input is sanitized, which layer checks permissions…). */
export const PROJECT_CONTEXT_PATH = '.review/context.md'
const PROJECT_CONTEXT_MAX = 6000

const FAILED = new Set(['failure', 'error', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'])
const PASSED = new Set(['success', 'neutral', 'skipped'])

/**
 * Facts the app computes or reads for the reviewer, so findings can rest on evidence instead of asking the reader to
 * go and check: the project context file, dependency range checks for manifest and lock file changes, and the CI
 * results for the head commit. Any part may be missing; a failure becomes a note, never a failed run.
 */
export async function loadFacts(o: {
	root: string
	baseSha: string
	headSha: string
	sources: Array<FileSource>
	checks: (() => Promise<CommitChecks>) | null // null: no GitHub repository for this review
	annotations?: ((runId: number) => Promise<Array<Omit<CiAnnotation, 'check'>>>) | null
	signal?: AbortSignal
}): Promise<FactsResult> {
	const out: FactsResult = { facts: [], notes: [], summary: [], annotations: [] }
	try {
		const p = await projectContext(o.root, o.baseSha, o.signal)
		if (p) {
			out.facts.push(p.fact)
			out.summary.push({ kind: 'project', text: p.summary })
			if (p.note) out.notes.push(p.note)
		}
	} catch (e) {
		if (o.signal?.aborted) throw e
		out.notes.push(`The project context (${PROJECT_CONTEXT_PATH}) could not be read: ${e instanceof Error ? e.message : String(e)}`)
	}
	try {
		const d = await dependencyFacts(o.root, o.baseSha, o.headSha, o.sources, o.signal)
		if (d) {
			out.notes.push(...d.notes)
			if (d.text) {
				out.facts.push({ kind: 'dependencies', title: 'Dependency facts', text: d.text, fileKeys: d.fileKeys })
				out.summary.push({
					kind: 'dependencies',
					text: `${d.packages} changed package${d.packages === 1 ? '' : 's'} checked against their dependents; ${d.outOfRange} dependent${d.outOfRange === 1 ? '' : 's'} outside their declared range.`,
				})
			}
		}
	} catch (e) {
		if (o.signal?.aborted) throw e
		out.notes.push(`Dependency facts could not be computed: ${e instanceof Error ? e.message : String(e)}`)
	}
	if (o.checks) {
		try {
			const c = await o.checks()
			const f = ciFact(c)
			out.facts.push(f.fact)
			out.summary.push({ kind: 'ci', text: f.summary })
			if (o.annotations) await readAnnotations(c, o.annotations, o.sources, out, o.signal)
		} catch (e) {
			if (o.signal?.aborted) throw e
			// A branch that was never pushed: GitHub has no record of the commit, which is "no evidence", not a failure.
			if (e instanceof Error && /not found|no commit found/i.test(e.message)) {
				const text = `GitHub has no record of the head commit ${o.headSha.slice(0, 7)} (it may not be pushed), so there is no CI evidence either way.`
				out.facts.push({ kind: 'ci', title: 'CI results', text, fileKeys: null })
				out.summary.push({ kind: 'ci', text: 'No CI results: GitHub does not have the head commit.' })
				return out
			}
			out.notes.push(
				`CI results could not be read from GitHub, so the reviewer was not told whether checks passed: ${e instanceof Error ? e.message : String(e)}`,
			)
		}
	}
	return out
}

/** The line messages CI tools attached to the changed files, from the check runs that report any. */
async function readAnnotations(
	c: CommitChecks,
	fetch: (runId: number) => Promise<Array<Omit<CiAnnotation, 'check'>>>,
	sources: Array<FileSource>,
	out: FactsResult,
	signal?: AbortSignal,
): Promise<void> {
	const changed = new Set(sources.flatMap((s) => (s.file.newPath ? [s.file.newPath] : [])))
	const runs = c.runs.filter((r) => r.annotations > 0)
	for (const r of runs.slice(0, MAX_ANNOTATED_RUNS)) {
		try {
			for (const a of await fetch(r.id)) if (changed.has(a.path)) out.annotations.push({ ...a, check: r.name })
		} catch (e) {
			if (signal?.aborted) throw e
			out.notes.push(`CI annotations of "${r.name}" could not be read: ${e instanceof Error ? e.message : String(e)}`)
		}
	}
	if (runs.length > MAX_ANNOTATED_RUNS)
		out.notes.push(`Only the CI annotations of the first ${MAX_ANNOTATED_RUNS} of ${runs.length} annotated checks were read.`)
	out.facts.push(...annotationFacts(out.annotations, sources))
	if (out.annotations.length) {
		const failures = out.annotations.filter((a) => a.level === 'failure').length
		out.summary.push({
			kind: 'ci',
			text: `${out.annotations.length} CI annotation${out.annotations.length === 1 ? '' : 's'} on changed files (${failures} failure${failures === 1 ? '' : 's'}).`,
		})
	}
}

/**
 * The project context file as of the base commit. Reading it from the base means the change under review cannot
 * rewrite what the reviewer is told about the codebase; edits to it take effect once merged.
 */
async function projectContext(
	root: string,
	baseSha: string,
	signal?: AbortSignal,
): Promise<{ fact: ContextFact; summary: string; note: string | null } | null> {
	const r = await git(root, ['cat-file', 'blob', `${baseSha}:${PROJECT_CONTEXT_PATH}`], 1024 * 1024, { signal })
	if (r.code !== 0) return null // no such file at the base commit
	const full = r.stdout.toString('utf8').trim()
	if (!full) return null
	const cut = full.length > PROJECT_CONTEXT_MAX
	const text = cut ? `${full.slice(0, PROJECT_CONTEXT_MAX)}\n… (the rest of the file was not sent)` : full
	return {
		fact: {
			kind: 'project',
			title: `Project context (${PROJECT_CONTEXT_PATH} at the base commit ${baseSha.slice(0, 7)}, written by the repository's maintainers)`,
			text,
			fileKeys: null,
		},
		summary: `${PROJECT_CONTEXT_PATH} from the base commit (${full.length.toLocaleString()} characters${cut ? `, first ${PROJECT_CONTEXT_MAX.toLocaleString()} sent` : ''}).`,
		note: cut
			? `${PROJECT_CONTEXT_PATH} has ${full.length.toLocaleString()} characters; only the first ${PROJECT_CONTEXT_MAX.toLocaleString()} were sent. Keep it to the facts a reviewer cannot see in the diff.`
			: null,
	}
}

export function ciFact(c: CommitChecks): { fact: ContextFact; summary: string } {
	const all = [
		...c.runs.map((r) => ({
			name: r.app && r.app !== 'GitHub Actions' ? `${r.name} (${r.app})` : r.name,
			result: r.result,
			note: null as string | null,
		})),
		...c.statuses.map((s) => ({ name: s.name, result: s.result, note: s.description })),
	]
	const failed = all.filter((x) => FAILED.has(x.result))
	const passed = all.filter((x) => PASSED.has(x.result))
	const pending = all.filter((x) => !FAILED.has(x.result) && !PASSED.has(x.result))
	const head = `Reported by GitHub for the head commit ${c.sha.slice(0, 7)}. Check names and results only: they say what ran and how it ended, not what each check covers.`
	if (!all.length) {
		return {
			fact: {
				kind: 'ci',
				title: 'CI results',
				text: `${head}\nNo checks or statuses are reported for this commit, so there is no CI evidence either way.`,
				fileKeys: null,
			},
			summary: 'No CI checks reported for the head commit.',
		}
	}
	const line = (x: (typeof all)[number]) => `- ${x.name}: ${x.result}${x.note ? ` (${x.note.slice(0, 120)})` : ''}`
	const lines = [...failed, ...pending, ...passed].slice(0, 60).map(line)
	if (all.length > 60 || c.runsOmitted) lines.push(`… ${all.length - Math.min(all.length, 60) + c.runsOmitted} more not listed`)
	const summary = `${failed.length} failed, ${pending.length} not finished, ${passed.length} passed`
	return {
		fact: { kind: 'ci', title: 'CI results', text: `${head}\n${lines.join('\n')}\nOverall: ${summary}.`, fileKeys: null },
		summary: `CI for the head commit: ${summary}.`,
	}
}
