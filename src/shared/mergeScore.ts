import type { HeadChecks } from './ci.ts'
import type { FixLevel, MergeOutcome, MergeScorePart, RiskLevel, Severity, TrackRecord } from './types.ts'

/**
 * How safe a pull request is to merge (issue #328), from the data alone: 100 less fixed deductions, each one listed. The
 * same state always gives the same score. The AI then sets the final score from this and the code (see MergeVerdict).
 */

/** The deductions below are starting guesses until merged pull requests' outcomes can tune them. */
export const WEIGHTS_TUNED = false

/** A finding still standing: not dismissed, not folded into another, not held back, not doubted by the double-check. */
export interface ScoredFinding {
	title: string
	severity: Severity
	losesData: boolean
	fileRisk: RiskLevel | null // the app's risk estimate for its file
}

/** Other reviewers' concerns still open on GitHub (see othersConcerns in src/main/autoReview.ts). */
export interface ScoredConcerns {
	changes: number // standing change requests
	threads: number // threads the author hasn't settled
	bots: number // bot threads the check says still hold
}

export interface MergeInput {
	findings: Array<ScoredFinding>
	ci: HeadChecks | null | undefined // undefined: not a pull request; null: couldn't be read
	others: ScoredConcerns | null | undefined // undefined: not a pull request; null: couldn't be read
	hidden: number // added lines with hidden or direction-changing characters
	drift: number | null // commits on the base branch since it branched that touch its files; null: unknown
	risk: RiskLevel | null // the change's risk: its riskiest file's
}

const FINDING_POINTS: Partial<Record<Severity, number>> = { blocking: 30, high: 30, should_fix: 8, medium: 8, question: 2 }
const LOSES_DATA = 40 // a blocking finding that loses, corrupts or leaks data
const RISKY_FILE = 1.5 // a finding in a high-risk file (auth, money, migrations…) costs more when it's real
const CHANGE_RISK: Record<RiskLevel, number> = { high: 10, medium: 4, low: 0 }
const CI_NEW_FAILURE = 25
const CI_OLD_FAILURE = 5 // fails on the base branch too
const CI_PENDING = 10
const CHANGE_REQUEST = 15
const OPEN_THREAD = 5
const OPEN_THREADS_MAX = 15
const BOT_HOLDS = 5
const BOT_HOLDS_MAX = 10
const HIDDEN = 10
const DRIFT = 5

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function dataScore(i: MergeInput): { score: number; parts: Array<MergeScorePart> } {
	const parts: Array<MergeScorePart> = []
	const add = (points: number, label: string, detail: Array<string> = []) => {
		if (points) parts.push({ points: -Math.round(points), label, detail })
	}
	const groups = new Map<string, { points: number; titles: Array<string> }>()
	for (const f of i.findings) {
		const base = f.losesData && (f.severity === 'blocking' || f.severity === 'high') ? LOSES_DATA : (FINDING_POINTS[f.severity] ?? 0)
		if (!base) continue
		const key =
			f.losesData && base === LOSES_DATA
				? 'blocking, loses data'
				: f.severity === 'high'
					? 'blocking'
					: f.severity === 'medium'
						? 'should_fix'
						: f.severity
		const g = groups.get(key) ?? { points: 0, titles: [] }
		g.points += base * (f.fileRisk === 'high' ? RISKY_FILE : 1)
		g.titles.push(f.fileRisk === 'high' ? `${f.title} (high-risk file)` : f.title)
		groups.set(key, g)
	}
	const LABEL: Record<string, [string, string]> = {
		'blocking, loses data': ['blocking finding that loses data', 'blocking findings that lose data'],
		blocking: ['blocking finding', 'blocking findings'],
		should_fix: ['should-fix finding', 'should-fix findings'],
		question: ['open question', 'open questions'],
	}
	for (const [key, g] of groups) add(g.points, plural(g.titles.length, ...LABEL[key]), g.titles)

	if (i.ci === null) parts.push({ points: 0, label: "CI couldn't be read", detail: [] })
	else if (i.ci) {
		const fresh = i.ci.failed.filter((f) => f.atBase !== 'fails')
		const old = i.ci.failed.filter((f) => f.atBase === 'fails')
		if (fresh.length)
			add(
				CI_NEW_FAILURE,
				`${plural(fresh.length, 'CI check')} failed`,
				fresh.map((f) => f.name),
			)
		if (old.length)
			add(
				CI_OLD_FAILURE,
				`${plural(old.length, 'CI check')} failed, also on the base branch`,
				old.map((f) => f.name),
			)
		if (i.ci.pending.length) add(CI_PENDING, `${plural(i.ci.pending.length, 'CI check')} not finished`, i.ci.pending)
	}

	if (i.others === null) parts.push({ points: 0, label: "Other reviewers' threads couldn't be read", detail: [] })
	else if (i.others) {
		add(i.others.changes * CHANGE_REQUEST, `${plural(i.others.changes, 'reviewer')} requested changes`)
		add(
			Math.min(OPEN_THREADS_MAX, i.others.threads * OPEN_THREAD),
			`${plural(i.others.threads, 'thread')} from other reviewers not settled`,
		)
		add(Math.min(BOT_HOLDS_MAX, i.others.bots * BOT_HOLDS), `${plural(i.others.bots, 'bot comment')} still holding`)
	}

	if (i.hidden) add(HIDDEN, `${plural(i.hidden, 'added line')} with hidden characters`)
	if (i.drift) add(DRIFT, `${plural(i.drift, 'commit')} on the base branch since it branched touch its files`)
	if (i.risk) add(CHANGE_RISK[i.risk], `${i.risk === 'high' ? 'High' : 'Medium'}-risk area: a missed problem costs more here`)

	const score = Math.max(0, Math.min(100, 100 + parts.reduce((a, p) => a + p.points, 0)))
	return { score, parts }
}

/**
 * The AI's final score, carried onto the data as it is now: the AI judged the code, which doesn't change for the same
 * head, so its move from the data score it saw is kept while CI, threads and the like move under it.
 */
export function finalScore(dataNow: number, verdict: { data: number; ai: number }): number {
	return Math.max(0, Math.min(100, Math.round(dataNow + verdict.ai - verdict.data)))
}

/** How long a merged pull request's lines are followed for the track record. */
export const MERGE_OUTCOME_DAYS = 30
/** Below this many settled pull requests in a band, the track record gives counts only, no share. */
export const MIN_TRACK_RECORD = 10

const RANK: Record<FixLevel, number> = { blocking: 0, should_fix: 1, minor: 2, 'not-a-fix': 3 }

/**
 * The most serious fix a merged pull request needed: "none" when nothing in its window was a fix; null while it isn't
 * settled (the window hasn't passed, or a change in it hasn't been judged).
 */
export function worstFix(o: MergeOutcome): FixLevel | 'none' | null {
	if (!o.done) return null
	let worst: FixLevel | null = null
	for (const f of o.fixes) {
		const level = f.reverted ? 'blocking' : f.level
		if (!level) return null
		if (!worst || RANK[level] < RANK[worst]) worst = level
	}
	return !worst || worst === 'not-a-fix' ? 'none' : worst
}

/** Scores in tens: 0–9, 10–19 … 90–100. */
export function bandOf(score: number): [number, number] {
	const lo = Math.min(90, Math.floor(score / 10) * 10)
	return [lo, lo === 90 ? 100 : lo + 9]
}

/** Wilson score interval, 95%: where the true share likely is, given k of n. Narrows as n grows. */
export function wilson(k: number, n: number): [number, number] {
	if (!n) return [0, 1]
	const z = 1.96
	const p = k / n
	const d = 1 + (z * z) / n
	const mid = (p + (z * z) / (2 * n)) / d
	const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
	return [Math.max(0, mid - half), Math.min(1, mid + half)]
}

/**
 * How merged pull requests that scored in `score`'s band did: this repository's, or every repository's while this
 * one has fewer than MIN_TRACK_RECORD settled in the band. Each is banded by the score it showed: the AI's when there was one.
 */
export function trackRecord(score: number, here: Array<MergeOutcome>, everywhere: Array<MergeOutcome>): TrackRecord {
	const band = bandOf(score)
	const settled = (list: Array<MergeOutcome>) =>
		list.flatMap((o) => {
			const s = o.score.final ?? o.score.data
			const w = worstFix(o)
			return w && s >= band[0] && s <= band[1] ? [w] : []
		})
	const mine = settled(here)
	const all = mine.length < MIN_TRACK_RECORD ? settled(everywhere) : mine
	const use = all.length > mine.length ? all : mine
	const count = (l: FixLevel) => use.filter((w) => w === l).length
	const blocking = count('blocking')
	const shouldFix = count('should_fix')
	return {
		band,
		scope: use === mine ? 'repo' : 'all',
		followed: use.length,
		blocking,
		shouldFix,
		minorOnly: count('minor'),
		range: use.length >= MIN_TRACK_RECORD ? wilson(blocking + shouldFix, use.length) : null,
	}
}

const pct = (x: number) => `${Math.round(x * 100)}%`

/** "Of 31 merged pull requests here that scored 70–79, 3 needed a fix (10%, likely 3–25%): 1 blocking, 2 should fix." */
export function recordText(r: TrackRecord): string {
	const where = r.scope === 'repo' ? 'here' : 'in all your repositories'
	const band = `${r.band[0]}–${r.band[1]}`
	if (!r.range)
		return `No track record for scores of ${band} yet: ${r.followed} of ${MIN_TRACK_RECORD} merged pull requests ${where} followed for 30 days.`
	const needed = r.blocking + r.shouldFix
	const kinds = [r.blocking ? `${r.blocking} blocking` : null, r.shouldFix ? `${r.shouldFix} should fix` : null].filter(Boolean).join(', ')
	const minor = r.minorOnly ? ` ${r.minorOnly} more needed only minor fixes.` : ''
	return `Of ${r.followed} merged pull requests ${where} that scored ${band}, ${needed} needed a fix within 30 days (${pct(needed / r.followed)}, likely ${pct(r.range[0])}–${pct(r.range[1])})${kinds ? `: ${kinds}` : ''}.${minor}`
}
