import { basename } from 'node:path'
import { findingRoots, findingState } from '../../shared/findings.ts'
import type {
	AiTextFeature,
	AiTextRow,
	AfterMergeItem,
	AfterMergeResult,
	AiCost,
	AiRun,
	Finding,
	FindingCategory,
	FindingDecision,
	JudgeRow,
	NoteCheck,
	NoteFindingRef,
	NotePeriod,
	OutcomeCounts,
	OutcomeFilter,
	OutcomeGroup,
	OutcomeRow,
	OutcomeSummary,
	Review,
	ReviewerNote,
	Severity,
} from '../../shared/types.ts'
import { FINDING_LEVELS } from '../../shared/types.ts'
import { notesKeyOf, type RepoState } from '../store.ts'
import { noteCovers } from '../../shared/notes.ts'
import { mergeOutcomes, mergeScoreOutcomes } from '../../shared/mergeScore.ts'

export const MIN_DECIDED = 10
const AI_TEXT_ORDER: Array<AiTextFeature> = ['explain', 'conclusion', 'conclusion-answer', 'reply']

const DEFECTS: ReadonlySet<FindingCategory> = new Set([
	'bug',
	'security',
	'error-handling',
	'breaking-change',
	'performance',
	'resilience',
	'drift',
])

export function outcomeGroup(category: FindingCategory | undefined): OutcomeGroup {
	return !category ? 'uncategorised' : DEFECTS.has(category) ? 'defect' : 'design'
}

interface Raiser {
	model: { key: string; label: string; detail: string | null }
	setup: { key: string; label: string; detail: string | null }
}

/** One finding as one run raised or carried it. */
interface Occurrence {
	finding: Finding
	run: AiRun
	review: Review
	raisers: Array<Raiser> // empty for carried and held-back findings: that run didn't raise it
}

/** A problem: every finding that is the same one, across re-runs, snapshots and team members. */
interface Problem {
	occurrences: Array<Occurrence>
	fixed: boolean
	after: Followed | null // what happened to its lines after its pull request merged
}

interface Followed {
	result: AfterMergeResult
	finding: Finding
	repo: string
	number: number
	mergedAt: string
}

const AFTER_RANK: Record<AfterMergeResult['state'], number> = { reverted: 3, changed: 2, untouched: 1, unknown: 0 }

type Decided = 'accepted' | 'auto' | 'undecided' | { dismissed: keyof OutcomeCounts['dismissed'] }

function modelOf(run: AiRun, memberId: string | null | undefined): Raiser['model'] {
	const m = memberId ? run.team?.members.find((x) => x.id === memberId) : undefined
	const connectionId = m?.connectionId ?? run.connectionId ?? run.provider
	const model = m?.model ?? run.model
	return { key: `${connectionId}\u0000${model}`, label: model, detail: m?.connectionLabel ?? run.connectionLabel ?? run.providerLabel }
}

function setupOf(run: AiRun, model: Raiser['model']): Raiser['setup'] {
	return run.team ? { key: `team:${run.team.id}`, label: run.team.name, detail: 'Team' } : { ...model, key: `model:${model.key}` }
}

/** Who raised it: the member (or model) that reported it, and every other member that reported the same problem. */
function raisersOf(run: AiRun, f: Finding): Array<Raiser> {
	if (f.carried || f.heldBack) return []
	return [f.memberId ?? null, ...(f.alsoBy ?? [])].map((id) => {
		const model = modelOf(run, id)
		return { model, setup: setupOf(run, model) }
	})
}

function since(period: OutcomeFilter['period'], now: Date): number {
	if (period === 'all') return -Infinity
	const d = new Date(now)
	if (period === '30d') d.setDate(d.getDate() - 30)
	else d.setMonth(d.getMonth() - 12)
	return d.getTime()
}

export function repoLabel(s: RepoState): string {
	return s.githubRepo ?? s.githubResolved ?? basename(s.root)
}

/** Groups each repository's findings into problems (findings are linked within a repository only). */
function problemsOf(s: RepoState): Array<Problem> {
	const parent = new Map<string, string>()
	const find = (id: string): string => {
		let root = id
		while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!
		parent.set(id, root)
		return root
	}
	const union = (a: string, b: string): void => {
		const ra = find(a)
		const rb = find(b)
		if (ra !== rb) parent.set(rb, ra)
	}
	const occurrences: Array<Occurrence> = []
	const gone: Array<{ id: string; fixed: boolean }> = []
	for (const [reviewId, runs] of Object.entries(s.aiRuns)) {
		const review = s.reviews[reviewId]
		if (!review) continue
		for (const run of runs) {
			if (run.fixture) continue
			for (const f of run.findings) {
				find(f.id)
				if (f.repeatOf) union(f.repeatOf, f.id)
				if (f.previous) union(f.previous.findingId, f.id)
				if (f.mergedInto) union(f.mergedInto, f.id)
				occurrences.push({ finding: f, run, review, raisers: raisersOf(run, f) })
			}
			for (const g of run.history?.gone ?? []) {
				// Asking whether it is still there settles it either way: "wrong" means it is gone.
				const checked = g.check && !g.check.error ? g.check.verdict : null
				gone.push({ id: g.finding.id, fixed: checked === 'wrong' || (g.state === 'fixed' && checked !== 'holds') })
			}
		}
	}
	const followed = new Map<string, Omit<Followed, 'finding'>>()
	for (const [number, m] of Object.entries(s.merged ?? {}))
		for (const [id, result] of Object.entries(m?.findings ?? {}))
			followed.set(id, { result, repo: m!.repo, number: Number(number), mergedAt: m!.mergedAt })
	const byRoot = new Map<string, Problem>()
	for (const o of occurrences) {
		const root = find(o.finding.id)
		const p = byRoot.get(root) ?? { occurrences: [], fixed: false, after: null }
		p.occurrences.push(o)
		const f = followed.get(o.finding.id)
		if (f && (!p.after || AFTER_RANK[f.result.state] > AFTER_RANK[p.after.result.state])) p.after = { ...f, finding: o.finding }
		byRoot.set(root, p)
	}
	for (const g of gone) {
		const p = byRoot.get(find(g.id))
		if (p && g.fixed) p.fixed = true
	}
	return [...byRoot.values()]
}

/**
 * Accepted when any of its findings became a comment you kept; otherwise your newest decision on any of them. A
 * problem only an automatic review added is counted apart: nobody decided it.
 */
function decided(p: Problem, roots: Map<string, Map<string, string>>, byId: Map<string, Map<string, Finding>>): Decided {
	const accepted = p.occurrences.filter(
		(o) => findingState(o.review, roots.get(o.review.id)!, o.finding, byId.get(o.review.id)!) === 'accepted',
	)
	if (accepted.length) return accepted.every((o) => o.run.auto) ? 'auto' : 'accepted'
	let newest: Omit<FindingDecision, 'history'> | null = null
	for (const o of p.occurrences)
		for (const d of [o.review.findingDecisions[o.finding.id], o.finding.carried?.decision, o.finding.previous?.decision])
			if (d && d.status !== 'accepted' && (!newest || d.decidedAt > newest.decidedAt)) newest = d
	return newest?.status === 'dismissed' ? { dismissed: newest.reason ?? 'unspecified' } : 'undecided'
}

// Most severe first, like the findings list; levels from before FINDING_LEVELS (high, medium, low) go last.
const levelOrder = (l: Severity): number => {
	const i = (FINDING_LEVELS as ReadonlyArray<string>).indexOf(l)
	return i === -1 ? FINDING_LEVELS.length : i
}

function emptyCounts(): OutcomeCounts {
	return {
		raised: 0,
		accepted: 0,
		dismissed: { wrong: 0, 'not-worth-it': 0, 'handled-elsewhere': 0, intended: 0, unspecified: 0 },
		undecided: 0,
		auto: 0,
		fixed: 0,
		checked: 0,
		likelyWrong: 0,
		reproduced: 0,
		followed: 0,
		reverted: 0,
		changedAfterMerge: 0,
	}
}

function addCost(a: AiCost | null, b: AiCost | null | undefined): AiCost {
	const base = a ?? { usd: 0, estimated: false, unpriced: false }
	// A run from before prices has no cost: what it cost is unknown, never zero.
	if (!b) return { ...base, unpriced: true }
	return { usd: base.usd + b.usd, estimated: base.estimated || b.estimated, unpriced: base.unpriced || b.unpriced }
}

/** How many problems were accepted, dismissed, fixed and so on, for each model, setup and rule, from stored runs. */
export function summarizeOutcomes(
	repos: Array<RepoState>,
	filter: OutcomeFilter,
	now = new Date(),
	notes: Record<string, Array<ReviewerNote>> = {},
): OutcomeSummary {
	const from = since(filter.period, now)
	const runMatches = (s: RepoState, run: AiRun): boolean =>
		!run.fixture &&
		(filter.repoId === null || s.repoId === filter.repoId) &&
		(filter.promptVersion === null || run.promptVersion === filter.promptVersion) &&
		Date.parse(run.startedAt) >= from

	const total = emptyCounts()
	const rows = {
		models: new Map<string, OutcomeRow>(),
		setups: new Map<string, OutcomeRow>(),
		rules: new Map<string, OutcomeRow & { group: OutcomeGroup }>(),
		groups: new Map<string, OutcomeRow & { group: OutcomeGroup }>(),
		levels: new Map<string, OutcomeRow & { level: Severity }>(),
	}
	const row = <R extends OutcomeRow>(map: Map<string, R>, r: Omit<R, 'counts' | 'cost'>): R => {
		let out = map.get(r.key)
		if (!out) map.set(r.key, (out = { ...r, counts: emptyCounts(), cost: null } as R))
		return out
	}
	const allModels = new Map<string, { key: string; label: string; detail: string | null }>()
	const versions = new Map<string, string>() // version → newest run with it
	const repoList: OutcomeSummary['repos'] = []
	const afterMerge: Array<AfterMergeItem> = []
	let followedAt: string | null = null
	let cost: AiCost | null = null
	const judge = new Map<string, JudgeRow>()

	for (const s of repos) {
		const runs = Object.values(s.aiRuns)
			.flat()
			.filter((r) => !r.fixture)
		if (!runs.length) continue
		repoList.push({ id: s.repoId, label: repoLabel(s) })
		if (s.followedAt && (filter.repoId === null || s.repoId === filter.repoId) && s.followedAt > (followedAt ?? ''))
			followedAt = s.followedAt
		for (const run of runs) {
			if (run.startedAt > (versions.get(run.promptVersion) ?? '')) versions.set(run.promptVersion, run.startedAt)
			for (const m of run.team?.members ?? [null]) {
				const model = modelOf(run, m?.id)
				allModels.set(model.key, model)
			}
		}

		// Cost: every matching run, with or without findings, booked to its models and setup.
		if (filter.group === null)
			for (const run of runs) {
				if (!runMatches(s, run)) continue
				for (const m of run.team?.members ?? [null]) {
					const model = modelOf(run, m?.id)
					if (filter.model !== null && model.key !== filter.model) continue
					const c = m ? m.cost : run.cost
					const mr = row(rows.models, model)
					mr.cost = addCost(mr.cost, c)
					const sr = row(rows.setups, setupOf(run, model))
					sr.cost = addCost(sr.cost, c)
					cost = addCost(cost, c)
				}
			}

		const roots = new Map<string, Map<string, string>>()
		const byId = new Map<string, Map<string, Finding>>()
		for (const [reviewId, rs] of Object.entries(s.aiRuns)) {
			roots.set(reviewId, findingRoots(rs))
			byId.set(reviewId, new Map(rs.flatMap((r) => r.findings.map((f) => [f.id, f] as const))))
		}

		for (const p of problemsOf(s)) {
			const raised = p.occurrences.flatMap((o) =>
				runMatches(s, o.run) ? o.raisers.filter((r) => filter.model === null || r.model.key === filter.model) : [],
			)
			if (!raised.length) continue
			// The rule is the lead's: the finding others were folded under, else the first raised.
			const lead = p.occurrences.find((o) => o.raisers.length && !o.finding.mergedInto) ?? p.occurrences.find((o) => o.raisers.length)!
			const group = outcomeGroup(lead.finding.category)
			if (filter.group !== null && group !== filter.group) continue

			const state = decided(p, roots, byId)
			const verified = [...p.occurrences]
				.sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt))
				.find((o) => o.finding.verification && !o.finding.verification.error)?.finding.verification
			const add = (c: OutcomeCounts): void => {
				c.raised++
				if (state === 'accepted') c.accepted++
				else if (state === 'auto') c.auto++
				else if (state === 'undecided') c.undecided++
				else c.dismissed[state.dismissed]++
				if (p.fixed) c.fixed++
				if (verified) c.checked++
				if (verified?.verdict === 'wrong') c.likelyWrong++
				if (p.occurrences.some((o) => o.finding.reproducer?.code && !o.finding.reproducer.error)) c.reproduced++
				const after = p.after?.result.state
				if (after && after !== 'unknown') c.followed++
				if (after === 'reverted') c.reverted++
				if (after === 'changed') c.changedAfterMerge++
			}
			add(total)
			// Only your decision counts as the answer: "probably fixed" and automatic reviews are themselves the AI's call.
			const yours = state === 'accepted' ? 'real' : typeof state === 'object' && state.dismissed === 'wrong' ? 'wrong' : null
			if (verified && yours) {
				let j = judge.get(verified.model)
				if (!j) {
					const cell = () => ({ real: 0, wrong: 0 })
					judge.set(verified.model, (j = { model: verified.model, cells: { holds: cell(), unsure: cell(), wrong: cell() } }))
				}
				j.cells[verified.verdict][yours]++
			}
			for (const key of new Set(raised.map((r) => r.model.key)))
				add(row(rows.models, raised.find((r) => r.model.key === key)!.model).counts)
			for (const key of new Set(raised.map((r) => r.setup.key)))
				add(row(rows.setups, raised.find((r) => r.setup.key === key)!.setup).counts)
			const category = lead.finding.category
			add(row(rows.rules, { key: category ?? 'uncategorised', label: category ?? 'uncategorised', detail: null, group }).counts)
			add(row(rows.groups, { key: group, label: group, detail: null, group }).counts)
			const level = lead.finding.severity
			add(row(rows.levels, { key: level, label: level, detail: null, level }).counts)
			const a = p.after
			if (a?.result.commit && (a.result.state === 'reverted' || a.result.state === 'changed'))
				afterMerge.push({
					repo: a.repo,
					number: a.number,
					title: a.finding.title,
					category: lead.finding.category ?? null,
					state: a.result.state,
					commit: a.result.commit,
					days: Math.max(0, Math.floor((Date.parse(a.result.commit.at) - Date.parse(a.mergedAt)) / 86_400_000)),
				})
		}
	}

	// The AI's other text (issue #289): by feature and model. Prompt versions and kinds of finding don't apply to it.
	const aiText = new Map<string, AiTextRow>()
	const flagNotes = new Map<string, Array<{ at: string; note: string }>>() // by row key
	for (const s of repos) {
		if (!s.aiText?.length) continue
		if (!repoList.some((r) => r.id === s.repoId)) repoList.push({ id: s.repoId, label: repoLabel(s) })
		for (const t of s.aiText) {
			const model = { key: `${t.connectionId}\u0000${t.model}`, label: t.model, detail: t.connectionLabel }
			if (!allModels.has(model.key)) allModels.set(model.key, model)
			if ((filter.repoId !== null && s.repoId !== filter.repoId) || (filter.model !== null && model.key !== filter.model)) continue
			if (Date.parse(t.at) < from) continue
			const key = `${t.feature}\u0000${model.key}`
			let r = aiText.get(key)
			if (!r) {
				r = {
					feature: t.feature,
					...model,
					counts: { made: 0, asDrafted: 0, light: 0, rewrite: 0, flagged: 0, cited: 0, brokenRefs: 0 },
					notes: [],
				}
				aiText.set(key, r)
			}
			r.counts.made++
			if (t.sent?.fate === 'as-drafted') r.counts.asDrafted++
			else if (t.sent?.fate === 'light') r.counts.light++
			else if (t.sent?.fate === 'rewrite') r.counts.rewrite++
			if (t.citations) {
				r.counts.cited += t.citations.checked
				r.counts.brokenRefs += t.citations.broken
			}
			if (t.flagged) {
				r.counts.flagged++
				if (t.flagged.note) flagNotes.set(key, [...(flagNotes.get(key) ?? []), { at: t.flagged.at, note: t.flagged.note }])
			}
		}
	}

	const sorted = <R extends OutcomeRow>(map: Map<string, R>): Array<R> =>
		[...map.values()].filter((r) => r.counts.raised > 0 || r.cost).sort((a, b) => b.counts.raised - a.counts.raised)
	return {
		filter,
		total,
		cost: filter.group === null ? cost : null,
		models: sorted(rows.models),
		setups: sorted(rows.setups),
		rules: sorted(rows.rules),
		groups: sorted(rows.groups),
		levels: [...rows.levels.values()].sort((a, b) => levelOrder(a.level) - levelOrder(b.level)),
		repos: repoList.sort((a, b) => a.label.localeCompare(b.label)),
		promptVersions: [...versions.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(([v]) => v),
		allModels: [...allModels.values()].sort((a, b) => a.label.localeCompare(b.label)),
		minDecided: MIN_DECIDED,
		afterMerge: afterMerge.sort((a, b) => b.commit.at.localeCompare(a.commit.at)),
		followedAt,
		aiText: [...aiText.entries()]
			.map(([key, r]) => ({
				...r,
				notes: (flagNotes.get(key) ?? [])
					.sort((a, b) => b.at.localeCompare(a.at))
					.slice(0, 5)
					.map((n) => n.note),
			}))
			.sort((a, b) => AI_TEXT_ORDER.indexOf(a.feature) - AI_TEXT_ORDER.indexOf(b.feature) || b.counts.made - a.counts.made),
		notes: noteChecks(
			repos,
			notes,
			filter.repoId === null ? null : notesKeyOf(repos.find((r) => r.repoId === filter.repoId) ?? { repoId: filter.repoId }),
		),
		merge: mergeScoreOutcomes(
			mergeOutcomes(repos.filter((r) => filter.repoId === null || r.repoId === filter.repoId)),
			mergeOutcomes(repos),
		),
		judge: [...judge.values()].sort((a, b) => judgeTotal(b) - judgeTotal(a)),
	}
}

const judgeTotal = (j: JudgeRow): number => Object.values(j.cells).reduce((n, c) => n + c.real + c.wrong, 0)

/**
 * How each reviewer note is doing (issue #278). A problem is of a note's kind when its lead finding is under the
 * note's rule in a file it covers; it falls before or after the note by when it was first raised. Runs count when
 * they reviewed a file the note covers. Warnings: findings you accepted although the reviewer said the note covers
 * them, and dismissed findings of its kind whose lines were reverted after merge. Lines that only changed after merge
 * are listed apart: nothing judged whether that change fixed anything.
 */
export function noteChecks(
	repos: Array<RepoState>,
	notes: Record<string, Array<ReviewerNote>>,
	only: string | null = null, // a NotesRepo key
): Array<NoteCheck> {
	const keys = Object.keys(notes).filter((k) => (only === null || k === only) && notes[k].length)
	const out: Array<NoteCheck> = []
	for (const key of keys) {
		const mine = repos.filter((s) => notesKeyOf(s) === key)
		const repo = mine[0] ? repoLabel(mine[0]) : key.replace(/^local:/, '')
		const checks = notes[key].map((note): NoteCheck => ({
			key,
			repo,
			note,
			before: emptyPeriod(),
			after: emptyPeriod(),
			marked: 0,
			acceptedUnder: [],
			reverted: [],
			changed: [],
		}))
		for (const s of mine) {
			const roots = new Map<string, Map<string, string>>()
			const byId = new Map<string, Map<string, Finding>>()
			for (const [reviewId, rs] of Object.entries(s.aiRuns)) {
				roots.set(reviewId, findingRoots(rs))
				byId.set(reviewId, new Map(rs.flatMap((r) => r.findings.map((f) => [f.id, f] as const))))
			}
			for (const run of Object.values(s.aiRuns).flat()) {
				if (run.fixture) continue
				const files = run.coverage.files.filter((f) => f.state === 'reviewed' || f.state === 'carried' || f.state === 'partial')
				for (const c of checks) if (files.some((f) => noteCovers(c.note, f.fileKey))) periodOf(c, run.startedAt).runs++
			}
			for (const p of problemsOf(s)) {
				const raised = p.occurrences.filter((o) => o.raisers.length)
				if (!raised.length) continue
				const lead = raised.find((o) => !o.finding.mergedInto) ?? raised[0]
				const path = lead.finding.anchor.newPath ?? lead.finding.anchor.oldPath ?? lead.finding.anchor.fileKey
				const first = raised.reduce((a, o) => (o.run.startedAt < a ? o.run.startedAt : a), raised[0].run.startedAt)
				const state = decided(p, roots, byId)
				const ref = (o: Occurrence, commit: NoteFindingRef['commit'] = null): NoteFindingRef => ({
					repoId: s.repoId,
					reviewId: o.review.id,
					findingId: o.finding.id,
					target: o.review.pr ? `#${o.review.pr.number}` : (o.review.headRef ?? 'a branch'),
					title: o.finding.title,
					path,
					line: o.finding.anchor.startLine,
					commit,
				})
				for (const c of checks) {
					if (c.note.rule && lead.finding.category !== c.note.rule) continue
					if (!noteCovers(c.note, path)) continue
					const period = periodOf(c, first)
					period.raised++
					if (state === 'accepted') period.accepted++
					else if (typeof state === 'object') period.dismissed++
					const marked = p.occurrences.find((o) => o.finding.underNote?.noteId === c.note.id)
					if (marked) {
						c.marked++
						if (state === 'accepted') c.acceptedUnder.push(ref(marked))
					}
					if (typeof state === 'object' && p.after?.result.commit) {
						if (p.after.result.state === 'reverted') c.reverted.push(ref(lead, p.after.result.commit))
						else if (p.after.result.state === 'changed') c.changed.push(ref(lead, p.after.result.commit))
					}
				}
			}
		}
		out.push(...checks)
	}
	return out
}

function emptyPeriod(): NotePeriod {
	return { runs: 0, raised: 0, accepted: 0, dismissed: 0 }
}

function periodOf(c: NoteCheck, at: string): NotePeriod {
	return at < c.note.addedAt ? c.before : c.after
}
