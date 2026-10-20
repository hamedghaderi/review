import type {
	AiRun,
	Anchor,
	CarriedRun,
	Comparison,
	Finding,
	FindingDecision,
	FindingHistory,
	GoneFinding,
	PreviousFinding,
	Review,
	Side,
} from '../../shared/types.ts'
import { findingDecision, findingLink, findingRoots, ruleChecked } from '../../shared/findings.ts'
import { isAncestor } from '../git.ts'
import { Mapper } from '../linemap.ts'
import { sameProblem } from './findings.ts'

/**
 * Finding history: a run on a new snapshot of a pull request or branch is compared with the newest finished run on an
 * earlier one. Each of its findings that matches one of that run's is still present and keeps what was decided on it;
 * the rest are new. That run's findings it did not raise again are probably fixed when their lines changed, else not
 * seen this time.
 */

/** What was decided on a finding in its own review, and the comment made from it, for carrying it into a later snapshot. */
export type EarlierState = (f: Finding) => { decision: Omit<FindingDecision, 'history'> | null; comment: string | null }

export function earlierState(review: Review, runs: Array<AiRun>): EarlierState {
	const roots = findingRoots(runs)
	const byId = new Map(runs.flatMap((r) => r.findings.map((f) => [f.id, f] as const)))
	return (f) => {
		const link = findingLink(review, roots, f.id, f.carried?.comment ?? f.previous?.comment ?? null)
		return {
			decision: findingDecision(review, f, byId),
			comment: link?.comment ? (link.comment.carried?.originId ?? link.comment.id) : null,
		}
	}
}

/** An earlier finding, moved to the new snapshot. */
export interface BaselineFinding {
	finding: Finding
	near: Anchor | null // about where it is now; null when its file is gone from the change
	changed: string | null // why its lines are not the same any more; null when they are
	decision: Omit<FindingDecision, 'history'> | null
	comment: string | null
}

export interface Baseline {
	from: CarriedRun
	baseMoved: boolean
	rewritten: boolean
	findings: Array<BaselineFinding>
}

/** `earlier`'s findings moved to the comparison `c`, the way comments are carried (see carryComments). */
export async function findingBaseline(root: string, earlier: AiRun, review: Review, runs: Array<AiRun>, c: Comparison): Promise<Baseline> {
	const from: CarriedRun = { runId: earlier.id, reviewId: earlier.reviewId, headSha: earlier.headSha }
	const sides: Record<Side, Mapper> = {
		new: new Mapper(root, earlier.headSha, c.headSha),
		old: new Mapper(root, earlier.baseSha, c.baseSha),
	}
	const state = earlierState(review, runs)
	const findings: Array<BaselineFinding> = []
	for (const f of earlier.findings) {
		if (f.heldBack) continue
		const a = f.anchor
		const side: Side = a.side ?? (a.newPath ? 'new' : 'old')
		const path = side === 'new' ? a.newPath : a.oldPath
		const m = sides[side]
		const move = path ? await m.move(path) : null
		const file = move?.path ? c.files.find((x) => (side === 'new' ? x.newPath : x.oldPath) === move.path) : undefined
		let near: Anchor | null = null
		let changed: string | null = null
		if (!move?.path) changed = side === 'new' ? 'The file was deleted.' : 'The file is no longer in the base.'
		else if (!file) changed = 'The file is no longer part of the change.'
		else {
			let range = { start: a.startLine, end: a.endLine }
			if (a.side && a.startLine !== null && a.endLine !== null) {
				const exact = await m.range(move, a.startLine, a.endLine)
				if (!exact) changed = 'Its lines changed.'
				range = exact ?? (await m.near(move, a.startLine, a.endLine))
			} else if (move.oldBlob !== move.newBlob) changed = 'The file changed.'
			near = {
				...a,
				repoId: c.repoId,
				baseSha: c.baseSha,
				headSha: c.headSha,
				fileKey: file.key,
				oldPath: file.oldPath,
				newPath: file.newPath,
				startLine: range.start,
				endLine: range.end,
			}
		}
		findings.push({ finding: f, near, changed, ...state(f) })
	}
	return {
		from,
		baseMoved: earlier.baseSha !== c.baseSha,
		rewritten: !(await isAncestor(root, earlier.headSha, c.headSha).catch(() => true)),
		findings,
	}
}

/**
 * Links each of the run's findings to the one it matches in `baseline` (a carried finding is the same one), and lists
 * the baseline's findings it did not raise. Findings already linked to this baseline keep their link, so a retry that
 * adds findings can trace the run again.
 */
export function traceFindings(run: AiRun, baseline: Baseline): { findings: Array<Finding>; history: FindingHistory } {
	const byId = new Map(baseline.findings.map((b) => [b.finding.id, b]))
	const link = (b: BaselineFinding): PreviousFinding => ({
		from: baseline.from,
		findingId: b.finding.id,
		decision: b.decision,
		comment: b.comment,
		seen: [...(b.finding.previous?.seen ?? []), baseline.from],
	})
	const matched = new Set<string>()
	const findings = run.findings.map((f) => {
		const b =
			(f.carried && byId.get(f.id)) ||
			(f.previous?.from.runId === baseline.from.runId && byId.get(f.previous.findingId)) ||
			baseline.findings.find((x) => x.near && sameProblem({ ...x.finding, anchor: x.near }, f))
		if (!b) return f.previous ? { ...f, previous: null } : f
		matched.add(b.finding.id)
		return { ...f, previous: link(b) }
	})
	const reviewed = new Set(run.coverage.files.filter((f) => f.state === 'reviewed' || f.state === 'partial').map((f) => f.fileKey))
	const gone: Array<GoneFinding> = []
	for (const b of baseline.findings) {
		if (matched.has(b.finding.id) || b.finding.mergedInto || b.decision?.status === 'dismissed') continue
		const path = b.near ? (b.near.newPath ?? b.near.oldPath ?? b.near.fileKey) : null
		const [state, why]: [GoneFinding['state'], string] = !b.near
			? ['fixed', b.changed!]
			: !reviewed.has(b.near.fileKey)
				? ['not-seen', `This run did not review ${path}.`]
				: !ruleChecked(run, { ...b.finding, anchor: b.near })
					? ['not-seen', `This run did not check this rule on ${path}.`]
					: b.changed
						? ['fixed', b.changed]
						: ['not-seen', 'Its lines did not change, but this run did not raise it again.']
		gone.push({ finding: b.finding, state, why, decision: b.decision, comment: b.comment })
	}
	return { findings, history: { from: baseline.from, baseMoved: baseline.baseMoved, rewritten: baseline.rewritten, gone } }
}
