import {
	REVIEW_RULES,
	type AiRun,
	type CarriedRun,
	type ChangedFile,
	type Comparison,
	type FileCoverage,
	type Finding,
	type FindingLevel,
	IDENT,
	type PatchResult,
	type RecheckedFile,
	type Review,
	type ReviewLimits,
	type ReviewRule,
} from '../../shared/types.ts'
import { fileRefs } from '../../shared/refs.ts'
import { NOT_NAMES } from '../symbols.ts'
import { findingTexts } from './citations.ts'
import type { ContextFact, FileSource } from './context.ts'
import { earlierState } from './history.ts'
import { wantedNames } from './related.ts'

/**
 * Incremental runs: after new commits, a run reviews only the files whose diff changed since the newest finished run of
 * the same pull request or branch, and carries that run's coverage and findings for the rest. A file's diff is the same
 * when both of its blob ids are, so a carried finding keeps its lines; only its commits change.
 */

/** The run limits that decide how deep a file is reviewed, beyond who reviews it. */
export type ReviewDepth = Pick<ReviewLimits, 'relatedCode' | 'lookups' | 'verify'>

const DEPTH_LABEL: Record<keyof ReviewDepth, string> = {
	lookups: 'lookups',
	relatedCode: 'related code',
	verify: 'double-checking of blocking findings',
}

/** Who reviews and how, as far as it decides what a run can find. Two runs with the same one can share results. */
export interface ReviewerPrint {
	promptVersion: string
	levels: Array<FindingLevel>
	workers: Array<{ connectionId: string | null; model: string; persona: string | null; rules: Array<ReviewRule> }>
	depth?: ReviewDepth | null // absent: not known, and not compared
}

export function runPrint(run: AiRun): ReviewerPrint {
	const l = run.limitsUsed
	return {
		// A setting a run doesn't record was on: each was on by default when it was added.
		depth: l ? { relatedCode: l.relatedCode !== false, lookups: l.lookups !== false, verify: l.verify !== false } : null,
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
	// Carried coverage would claim a deeper review than the earlier run gave; turning one off still carries.
	const deeper =
		was.depth && next.depth ? (Object.keys(DEPTH_LABEL) as Array<keyof ReviewDepth>).filter((k) => next.depth![k] && !was.depth![k]) : []
	if (deeper.length) {
		const names = deeper.map((k) => DEPTH_LABEL[k])
		const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]
		return `The run on ${at} had ${list} turned off, and ${names.length === 1 ? 'it is' : 'they are'} on now.`
	}
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
	const state = earlierState(review, runs)
	return mine.map((f) => {
		const kept = !f.mergedInto || ids.has(f.mergedInto)
		return {
			...f,
			anchor: { ...f.anchor, repoId: c.repoId, baseSha: c.baseSha, headSha: c.headSha },
			repeatOf: null,
			mergedInto: kept ? (f.mergedInto ?? null) : null,
			mergedReason: kept ? (f.mergedReason ?? null) : null,
			...(f.alsoAt ? { alsoAt: f.alsoAt.filter((x) => ids.has(x.findingId)) } : {}),
			carried: { from: f.carried?.from ?? origin, ...state(f) },
		}
	})
}

/**
 * Carried files to review again because their added lines use a name whose definition changed since the earlier run:
 * edited or removed in `since`, each file's diff between the earlier run's head and this one. A name the change only
 * adds can't break code written before it, and an edited body is left to related code, or every caller would go.
 */
export function usersOfChangedNames(
	since: Array<FileSource>,
	carried: Array<{ fileKey: string; patch: PatchResult }>,
): Array<RecheckedFile> {
	const changed = new Map<string, Set<string>>() // name → files that changed its definition
	for (const [name, d] of wantedNames(since).defined)
		if ((d.kind === 'signature' || d.kind === 'removed') && name.length >= 3 && !NOT_NAMES.has(name)) changed.set(name, d.fileKeys)
	if (!changed.size) return []
	const out: Array<RecheckedFile> = []
	for (const { fileKey, patch } of carried) {
		if (patch.kind !== 'text') continue
		const names = new Set<string>()
		for (const h of patch.hunks)
			for (const l of h.lines) if (l.kind === 'add') for (const n of l.text.match(IDENT) ?? []) if (changed.has(n)) names.add(n)
		if (!names.size) continue
		const sorted = [...names].sort()
		const changedIn = [...new Set(sorted.flatMap((n) => [...changed.get(n)!]))].filter((k) => k !== fileKey).sort()
		if (changedIn.length) out.push({ fileKey, names: sorted, changedIn })
	}
	return out
}

/**
 * Carried files to review again because a finding the earlier run raised on them cites a file whose diff changed since:
 * the change may have fixed what it describes, or moved the lines it points at, and only a new review can tell.
 * `changed` holds the keys of the files whose diff changed.
 */
export function citersOfChangedFiles(findings: Array<Finding>, carried: Array<string>, changed: Array<ChangedFile>): Array<RecheckedFile> {
	const out: Array<RecheckedFile> = []
	for (const fileKey of carried) {
		const cited = new Set<string>()
		for (const f of findings) {
			if (f.anchor.fileKey !== fileKey) continue
			for (const t of findingTexts(f))
				for (const r of fileRefs(t ?? ''))
					for (const c of changed)
						if (c.key !== fileKey && [c.newPath, c.oldPath].some((p) => p && (p === r.path || p.endsWith(`/${r.path}`)))) cited.add(c.key)
		}
		if (cited.size) out.push({ fileKey, names: [], changedIn: [], cited: [...cited].sort() })
	}
	return out
}

/** Both reasons to review a carried file again, one entry per file. */
export function mergeRechecks(...lists: Array<Array<RecheckedFile>>): Array<RecheckedFile> {
	const byFile = new Map<string, RecheckedFile>()
	for (const r of lists.flat()) {
		const was = byFile.get(r.fileKey)
		if (!was) byFile.set(r.fileKey, r)
		else
			byFile.set(r.fileKey, {
				fileKey: r.fileKey,
				names: [...new Set([...was.names, ...r.names])].sort(),
				changedIn: [...new Set([...was.changedIn, ...r.changedIn])].sort(),
				...(was.cited || r.cited ? { cited: [...new Set([...(was.cited ?? []), ...(r.cited ?? [])])].sort() } : {}),
			})
	}
	return [...byFile.values()]
}

/** Tells the reviewer why an unchanged file is in the request, so it checks the uses against the new definitions. */
export function recheckFacts(rechecked: Array<RecheckedFile>, from: CarriedRun | null): Array<ContextFact> {
	const at = from ? ` since the run on ${from.headSha.slice(0, 7)}` : ''
	return rechecked.map((r) => {
		const why: Array<string> = []
		if (r.names.length)
			why.push(
				`its added lines use ${r.names.map((n) => `\`${n}\``).join(', ')}, whose definition changed${at} in ${r.changedIn.join(', ')}. Check those uses against the definitions as they are now`,
			)
		if (r.cited?.length)
			why.push(
				`a finding raised on it before cites ${r.cited.join(', ')}, whose diff changed${at}. Check whether what it describes still holds against those files as they are now, and raise it again only if it does`,
			)
		return {
			kind: 'structure' as const,
			title: `Why ${r.fileKey} is reviewed again`,
			text: `Its diff has not changed${at}, but ${why.join('; and ')}.`,
			fileKeys: [r.fileKey],
		}
	})
}
