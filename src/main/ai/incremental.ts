import {
	REVIEW_RULES,
	type AiRun,
	type CarriedRun,
	type ChangedFile,
	type Comparison,
	type FileCoverage,
	type Finding,
	type FindingLevel,
	type Review,
	type ReviewRule,
} from '../../shared/types.ts'
import { findingDecision, findingLink, findingRoots } from '../../shared/findings.ts'

/**
 * Incremental runs: after new commits, a run reviews only the files whose diff changed since the newest finished run of
 * the same pull request or branch, and carries that run's coverage and findings for the rest. A file's diff is the same
 * when both of its blob ids are, so a carried finding keeps its lines; only its commits change.
 */

/** Who reviews and how, as far as it decides what a run can find. Two runs with the same one can share results. */
export interface ReviewerPrint {
	promptVersion: string
	levels: Array<FindingLevel>
	workers: Array<{ connectionId: string | null; model: string; persona: string | null; rules: Array<ReviewRule> }>
}

export function runPrint(run: AiRun): ReviewerPrint {
	return {
		promptVersion: run.promptVersion,
		levels: run.levels ?? ['blocking', 'should_fix', 'pre_existing'],
		workers: run.team
			? run.team.members.map((m) => ({ connectionId: m.connectionId, model: m.model, persona: m.persona ?? null, rules: m.rules }))
			: [{ connectionId: run.connectionId ?? null, model: run.model, persona: run.persona ?? null, rules: [...REVIEW_RULES] }],
	}
}

/** Why `next` cannot build on `earlier`'s results; null when it can. */
export function trustGap(earlier: AiRun, next: ReviewerPrint): string | null {
	const was = runPrint(earlier)
	const at = earlier.headSha.slice(0, 7)
	if (was.promptVersion !== next.promptVersion) return `The run on ${at} used an older version of the reviewer prompt.`
	const key = (xs: Array<unknown>): string => JSON.stringify(xs.map((x) => JSON.stringify(x)).sort())
	if (key(was.levels) !== key(next.levels)) return `The finding levels changed since the run on ${at}.`
	const workers = (p: ReviewerPrint) => key(p.workers.map((w) => ({ ...w, rules: [...w.rules].sort() })))
	if (workers(was) !== workers(next)) return `The run on ${at} used a different model, team or set of rules.`
	return null
}

/** Whether every rule of `run` was answered in every request that carried the file (as a retry counts it). */
export function checkedEverywhere(run: AiRun, fileKey: string): boolean {
	if (!run.evaluation) return false
	// Team runs from before members got their own requests shared one set, so supplied excerpts name no member.
	const shared = !!run.team && !run.coverage.supplied.some((s) => s.memberId)
	for (const e of run.evaluation) {
		const owner = e.checkedBy ?? null
		for (const s of run.coverage.supplied) {
			if (s.fileKey !== fileKey || (!shared && (s.memberId ?? null) !== owner)) continue
			if (!e.answered?.includes(s.batch)) return false
		}
	}
	return true
}

type Blobs = ReadonlyMap<string, { oldBlob: string | null; newBlob: string | null }>

/**
 * Splits the comparison's files into those to review and those whose results carry over from `earlier`, which reviewed
 * commits whose changes were `before`. A file carries when its diff is the same and that run reviewed it fully (or
 * carried it itself); a file it could not review for a reason that still holds (binary, a submodule) stays as it was.
 */
export function planIncremental(
	earlier: AiRun,
	origin: CarriedRun,
	before: { files: Array<ChangedFile>; blobs: Blobs },
	now: { files: Array<ChangedFile>; blobs: Blobs },
): { review: Array<string>; carry: Array<FileCoverage> } {
	const review: Array<string> = []
	const carry: Array<FileCoverage> = []
	for (const f of now.files) {
		const was = before.files.find((x) => x.key === f.key)
		const a = before.blobs.get(f.key)
		const b = now.blobs.get(f.key)
		const same =
			!!was && !!a && !!b && was.oldPath === f.oldPath && was.newPath === f.newPath && a.oldBlob === b.oldBlob && a.newBlob === b.newBlob
		const cov = earlier.coverage.files.find((x) => x.fileKey === f.key)
		if (same && cov && (cov.state === 'carried' || (cov.state === 'reviewed' && checkedEverywhere(earlier, f.key)))) {
			const from = cov.from ?? origin
			carry.push({
				fileKey: f.key,
				state: 'carried',
				reason: `Unchanged since the run on ${from.headSha.slice(0, 7)}`,
				risk: cov.risk ?? null,
				from,
			})
		} else if (same && cov?.state === 'not-reviewable') carry.push({ ...cov })
		else review.push(f.key)
	}
	return { review, carry }
}

/**
 * `earlier`'s findings on the carried files, moved to the comparison `c`. Each keeps its id and remembers what was
 * decided on it in the earlier review (its own decision, else the one on the finding it repeats) and the comment made
 * from it, so it shows as dismissed or added here too. Groupings with findings that are not carried are undone.
 */
export function carryFindings(
	earlier: AiRun,
	origin: CarriedRun,
	review: Review,
	runs: Array<AiRun>,
	files: Array<FileCoverage>,
	c: Comparison,
): Array<Finding> {
	const keys = new Set(files.filter((f) => f.state === 'carried').map((f) => f.fileKey))
	const mine = earlier.findings.filter((f) => keys.has(f.anchor.fileKey))
	const ids = new Set(mine.map((f) => f.id))
	const roots = findingRoots(runs)
	const byId = new Map(runs.flatMap((r) => r.findings.map((f) => [f.id, f] as const)))
	return mine.map((f) => {
		const link = findingLink(review, roots, f.id, f.carried?.comment ?? null)
		const linked = link?.comment ? (link.comment.carried?.originId ?? link.comment.id) : null
		const kept = !f.mergedInto || ids.has(f.mergedInto)
		return {
			...f,
			anchor: { ...f.anchor, repoId: c.repoId, baseSha: c.baseSha, headSha: c.headSha },
			repeatOf: null,
			mergedInto: kept ? (f.mergedInto ?? null) : null,
			mergedReason: kept ? (f.mergedReason ?? null) : null,
			...(f.alsoAt ? { alsoAt: f.alsoAt.filter((x) => ids.has(x.findingId)) } : {}),
			carried: { from: f.carried?.from ?? origin, decision: findingDecision(review, f, byId), comment: linked },
		}
	})
}
