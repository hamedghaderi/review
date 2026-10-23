import { basename } from 'node:path'
import { findingRoots, findingState } from '../../shared/findings.ts'
import type {
	AiCost,
	AiRun,
	Finding,
	FindingCategory,
	FindingDecision,
	OutcomeCounts,
	OutcomeFilter,
	OutcomeGroup,
	OutcomeRow,
	OutcomeSummary,
	Review,
} from '../../shared/types.ts'
import type { RepoState } from '../store.ts'

export const MIN_DECIDED = 10

const DEFECTS: ReadonlySet<FindingCategory> = new Set(['bug', 'security', 'error-handling', 'breaking-change', 'performance'])

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
}

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
	const byRoot = new Map<string, Problem>()
	for (const o of occurrences) {
		const root = find(o.finding.id)
		const p = byRoot.get(root) ?? { occurrences: [], fixed: false }
		p.occurrences.push(o)
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
	}
}

function addCost(a: AiCost | null, b: AiCost | null | undefined): AiCost {
	const base = a ?? { usd: 0, estimated: false, unpriced: false }
	// A run from before prices has no cost: what it cost is unknown, never zero.
	if (!b) return { ...base, unpriced: true }
	return { usd: base.usd + b.usd, estimated: base.estimated || b.estimated, unpriced: base.unpriced || b.unpriced }
}

/** How many problems were accepted, dismissed, fixed and so on, for each model, setup and rule, from stored runs. */
export function summarizeOutcomes(repos: Array<RepoState>, filter: OutcomeFilter, now = new Date()): OutcomeSummary {
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
	}
	const row = <R extends OutcomeRow>(map: Map<string, R>, r: Omit<R, 'counts' | 'cost'>): R => {
		let out = map.get(r.key)
		if (!out) map.set(r.key, (out = { ...r, counts: emptyCounts(), cost: null } as R))
		return out
	}
	const allModels = new Map<string, { key: string; label: string; detail: string | null }>()
	const versions = new Map<string, string>() // version → newest run with it
	const repoList: OutcomeSummary['repos'] = []
	let cost: AiCost | null = null

	for (const s of repos) {
		const runs = Object.values(s.aiRuns)
			.flat()
			.filter((r) => !r.fixture)
		if (!runs.length) continue
		repoList.push({ id: s.repoId, label: repoLabel(s) })
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
			}
			add(total)
			for (const key of new Set(raised.map((r) => r.model.key)))
				add(row(rows.models, raised.find((r) => r.model.key === key)!.model).counts)
			for (const key of new Set(raised.map((r) => r.setup.key)))
				add(row(rows.setups, raised.find((r) => r.setup.key === key)!.setup).counts)
			const category = lead.finding.category
			add(row(rows.rules, { key: category ?? 'uncategorised', label: category ?? 'uncategorised', detail: null, group }).counts)
			add(row(rows.groups, { key: group, label: group, detail: null, group }).counts)
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
		repos: repoList.sort((a, b) => a.label.localeCompare(b.label)),
		promptVersions: [...versions.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(([v]) => v),
		allModels: [...allModels.values()].sort((a, b) => a.label.localeCompare(b.label)),
		minDecided: MIN_DECIDED,
	}
}
