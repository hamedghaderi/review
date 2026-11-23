import { createHash, randomUUID } from 'node:crypto'
import {
	targetKey,
	type DismissalRef,
	type DismissReason,
	type FindingCategory,
	type NoteSuggestion,
	type Review,
	type ReviewerNote,
	type ReviewTarget,
} from '../shared/types.ts'
import type { DraftGroup, DraftInput, ExistingGroup } from './ai/noteDraft.ts'
import { notesKeyOf, type StoreData } from './store.ts'

/**
 * Spotting findings you keep dismissing the same way across pull requests (issue #278), so the app can suggest a
 * reviewer note. Counting is free and done here; grouping by problem and drafting the note is one request to the model
 * for questions (ai/noteDraft.ts), made only when a rule and reason has enough dismissals no note or suggestion holds.
 */

/** How many dismissals, across how many pull requests or branches, make a suggestion. "Not worth fixing" says less. */
export const THRESHOLDS: Record<DismissReason, { dismissals: number; prs: number }> = {
	wrong: { dismissals: 3, prs: 2 },
	intended: { dismissals: 3, prs: 2 },
	'handled-elsewhere': { dismissals: 3, prs: 2 },
	'not-worth-it': { dismissals: 5, prs: 3 },
}
/** New dismissals that bring back a suggestion you put off. */
export const LATER_MORE = 3

export interface Dismissal {
	ref: DismissalRef
	body: string | null // what the finding said, for grouping; not kept
}

/** Reviews saved before milestone 3 compared HEAD with their base branch. */
function targetOf(r: Review): ReviewTarget {
	return r.target ?? { kind: 'branch', headRef: 'HEAD', baseRef: r.baseRef }
}

function targetLabel(r: Review, t: ReviewTarget): string {
	if (r.pr) return `#${r.pr.number}`
	if (t.kind === 'pr') return `#${t.number}`
	if (t.kind === 'commits') return `${t.from.slice(0, 7)}..${t.to.slice(0, 7)}`
	return t.headRef.replace(/^refs\/(heads|remotes)\//, '')
}

/**
 * Every finding you dismissed with a reason in the repositories that share reviewer notes under `key`, once per pull
 * request or branch (the newest decision on the same place and title, however many runs or snapshots raised it).
 */
export function collectDismissals(d: StoreData, key: string): Array<Dismissal> {
	const byKey = new Map<string, Dismissal>()
	for (const repo of Object.values(d.repos)) {
		if (notesKeyOf(repo) !== key) continue
		for (const r of Object.values(repo.reviews)) {
			const findings = new Map((repo.aiRuns[r.id] ?? []).flatMap((run) => run.findings.map((f) => [f.id, f] as const)))
			const target = targetOf(r)
			const prKey = targetKey(target)
			for (const [id, decision] of Object.entries(r.findingDecisions)) {
				const f = findings.get(id)
				if (decision.status !== 'dismissed' || !decision.reason || !f?.category) continue
				const path = f.anchor.newPath ?? f.anchor.oldPath ?? f.anchor.fileKey
				const ref: DismissalRef = {
					key: `${prKey}|${path}|${f.title}`,
					repoId: repo.repoId,
					reviewId: r.id,
					findingId: f.id,
					target: targetLabel(r, target),
					prKey,
					rule: f.category,
					reason: decision.reason,
					path,
					line: f.anchor.startLine,
					title: f.title,
					note: decision.note ?? null,
					decidedAt: decision.decidedAt,
				}
				const had = byKey.get(ref.key)
				if (!had || had.ref.decidedAt < ref.decidedAt) byKey.set(ref.key, { ref, body: f.body ?? null })
			}
		}
	}
	return [...byKey.values()].sort((a, b) => a.ref.decidedAt.localeCompare(b.ref.decidedAt))
}

/** Dismissals no note or suggestion holds yet: the ones that can still make a new suggestion. */
export function freeDismissals(all: Array<Dismissal>, notes: Array<ReviewerNote>, suggestions: Array<NoteSuggestion>): Array<Dismissal> {
	const held = new Set(
		[...notes.flatMap((n) => [...(n.from ?? []), ...(n.after ?? [])]), ...suggestions.flatMap((s) => s.from)].map((r) => r.key),
	)
	return all.filter((x) => !held.has(x.ref.key))
}

const prCount = (refs: Array<DismissalRef>): number => new Set(refs.map((r) => r.prKey)).size

export interface Bucket {
	id: string // "rule|reason"
	rule: FindingCategory
	reason: DismissReason
	free: Array<Dismissal>
	hash: string // of the free dismissals, so the same set is never sent twice
}

/**
 * The rules and reasons worth a request now: enough free dismissals over enough pull requests to make a new
 * suggestion, or at least LATER_MORE with a note or suggestion of the same kind they could join; and a different set
 * from the one last sent (`checked`, by bucket id).
 */
export function bucketsToCheck(
	free: Array<Dismissal>,
	notes: Array<ReviewerNote>,
	suggestions: Array<NoteSuggestion>,
	checked: Record<string, string>,
): Array<Bucket> {
	const groups = new Map<string, Array<Dismissal>>()
	for (const x of free) {
		const id = `${x.ref.rule}|${x.ref.reason}`
		groups.set(id, [...(groups.get(id) ?? []), x])
	}
	const out: Array<Bucket> = []
	for (const [id, list] of groups) {
		const { rule, reason } = list[0].ref
		const t = THRESHOLDS[reason]
		const fresh = list.length >= t.dismissals && prCount(list.map((x) => x.ref)) >= t.prs
		const joinable = notes.some((n) => n.rule === rule) || suggestions.some((s) => s.rule === rule && s.reason === reason)
		if (!fresh && !(joinable && list.length >= LATER_MORE)) continue
		const hash = createHash('sha256')
			.update(
				list
					.map((x) => x.ref.key)
					.sort()
					.join('\n'),
			)
			.digest('hex')
		if (checked[id] === hash) continue
		out.push({ id, rule, reason, free: list, hash })
	}
	return out
}

/** Where an existing group label points. */
export type GroupTarget = { kind: 'note'; id: string } | { kind: 'suggestion'; id: string }

/** The request for a bucket: its free dismissals as D1…, and the notes and suggestions of the same kind as G1…. */
export function draftInputFor(
	bucket: Bucket,
	notes: Array<ReviewerNote>,
	suggestions: Array<NoteSuggestion>,
): { input: DraftInput; groups: Map<string, GroupTarget>; labels: Map<string, Dismissal> } {
	const groups = new Map<string, GroupTarget>()
	const existing: Array<ExistingGroup> = []
	for (const n of notes.filter((x) => x.rule === bucket.rule)) {
		const label = `G${existing.length + 1}`
		existing.push({ label, kind: 'note', problem: '', text: n.text, paths: n.paths })
		groups.set(label, { kind: 'note', id: n.id })
	}
	for (const s of suggestions.filter((x) => x.rule === bucket.rule && x.reason === bucket.reason)) {
		const label = `G${existing.length + 1}`
		existing.push({ label, kind: s.state, problem: s.problem, text: s.text, paths: s.paths })
		groups.set(label, { kind: 'suggestion', id: s.id })
	}
	const labels = new Map(bucket.free.map((x, i) => [`D${i + 1}`, x] as const))
	return {
		input: {
			rule: bucket.rule,
			reason: bucket.reason,
			existing,
			dismissals: [...labels].map(([label, x]) => ({ label, ref: x.ref, body: x.body })),
		},
		groups,
		labels,
	}
}

/**
 * Applies the model's groups: dismissals joining a note are kept with it (`after`), ones joining a suggestion extend
 * it (a pending one takes the new draft; a put-off one comes back once LATER_MORE more joined; a refused one only
 * absorbs them), and a new group becomes a suggestion only when it meets its reason's threshold. Returns how many
 * suggestions are now waiting that were not before.
 */
export function applyGroups(
	bucket: Bucket,
	drafted: Array<DraftGroup>,
	groups: Map<string, GroupTarget>,
	labels: Map<string, Dismissal>,
	notes: Array<ReviewerNote>,
	suggestions: Array<NoteSuggestion>,
	model: string,
	now = new Date().toISOString(),
): { notes: Array<ReviewerNote>; suggestions: Array<NoteSuggestion>; surfaced: number } {
	const nextNotes = notes.map((n) => ({ ...n }))
	const next = suggestions.map((s) => ({ ...s }))
	const stillFree = new Set(freeDismissals([...labels.values()], notes, suggestions).map((x) => x.ref.key))
	let surfaced = 0
	for (const g of drafted) {
		// A dismissal a note or suggestion took while the request ran stays where it went.
		const refs = g.dismissals.flatMap((l) => {
			const x = labels.get(l)
			return x && stillFree.has(x.ref.key) ? [x.ref] : []
		})
		if (!refs.length) continue
		const target = g.group ? groups.get(g.group) : undefined
		const draft = { problem: g.problem, text: g.note, paths: g.paths }
		if (target?.kind === 'note') {
			const n = nextNotes.find((x) => x.id === target.id)
			if (n) n.after = [...(n.after ?? []), ...refs]
			continue
		}
		const s = target?.kind === 'suggestion' ? next.find((x) => x.id === target.id) : undefined
		if (s) {
			s.from = [...s.from, ...refs]
			if (s.state === 'pending') Object.assign(s, draft)
			else if (s.state === 'later' && s.from.length - (s.laterAt ?? 0) >= LATER_MORE) {
				Object.assign(s, draft, { state: 'pending', laterAt: null })
				surfaced++
			}
			continue
		}
		const t = THRESHOLDS[bucket.reason]
		if (refs.length < t.dismissals || prCount(refs) < t.prs) continue
		next.push({
			id: randomUUID(),
			rule: bucket.rule,
			reason: bucket.reason,
			...draft,
			from: refs,
			state: 'pending',
			at: now,
			laterAt: null,
			model,
		})
		surfaced++
	}
	return { notes: nextNotes, suggestions: next, surfaced }
}
