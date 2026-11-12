import { randomUUID } from 'node:crypto'
import {
	REVIEW_RULES,
	type Anchor,
	type FindingLevel,
	type Comparison,
	type Finding,
	type FindingCategory,
	type FindingReach,
	type FindingVerification,
	type NearMiss,
	type OutdatedDoc,
	type RaisedBefore,
	type RejectedFinding,
	type ReviewRule,
	type Side,
} from '../../shared/types.ts'
import type { EarlierThread } from './background.ts'
import type { ContextBatch, ContextExcerpt } from './context.ts'
import { isProjectDocPath } from './facts.ts'
import { DEFAULT_LEVELS, residueLevel } from './prompt.ts'
import type { z } from 'zod'
import { modelFindingSchema, reviewEnvelopeSchema, type ModelFinding } from './schema.ts'

const TEXT_LIMITS = {
	title: 200,
	body: 6000,
	reasoning: 600,
	disproof: 2000,
	reach: 400,
	background: 1200,
	evidence: 4000,
	limitation: 1000,
	note: 400,
	whyAgain: 600,
}
const MAX_FINDINGS_PER_BATCH = 50
const MAX_LIMITATIONS_PER_BATCH = 20

export interface ValidatedBatch {
	findings: Array<Finding>
	rejected: Array<RejectedFinding>
	limitations: Array<string>
	evaluation: Array<{ rule: ReviewRule; nearMisses: Array<NearMiss>; why: string }>
	unexplained: Array<{ fileKey: string; why: string }>
	outdatedDocs: Array<OutdatedDoc>
}

export class InvalidOutputError extends Error {}

/**
 * Checks untrusted model output against the excerpts supplied in this batch. Only findings whose excerpt, file, side,
 * line range and evidence all match are kept; everything else is recorded with a reason. `threads` are the PR's review
 * threads by the label the conversation sent them under, so a finding that says it raises one again links to it.
 */
export function validateBatchOutput(
	output: unknown,
	batch: ContextBatch,
	comparison: Comparison,
	runId: string,
	rules: ReadonlyArray<ReviewRule> = REVIEW_RULES,
	levels: ReadonlyArray<FindingLevel> = DEFAULT_LEVELS,
	threads: ReadonlyMap<string, EarlierThread> = new Map(),
): ValidatedBatch {
	const parsed = reviewEnvelopeSchema.safeParse(output)
	if (!parsed.success) throw new InvalidOutputError(`Output does not match the findings schema: ${issueText(parsed.error)}`)
	const excerpts = new Map(batch.excerpts.map((e) => [e.id, e]))
	const findings: Array<Finding> = []
	const rejected: Array<RejectedFinding> = []
	const items: Array<ModelFinding> = []
	for (const raw of parsed.data.findings) {
		const f = modelFindingSchema.safeParse(raw)
		if (f.success) items.push(f.data)
		else rejected.push(reject(raw, `Malformed finding (${issueText(f.error)})`))
	}
	if (items.length > MAX_FINDINGS_PER_BATCH) {
		for (const f of items.slice(MAX_FINDINGS_PER_BATCH))
			rejected.push(reject(f, `More than ${MAX_FINDINGS_PER_BATCH} findings in one response`))
	}
	const owned = new Set(rules)
	for (const f of items.slice(0, MAX_FINDINGS_PER_BATCH)) {
		// Residue signature 7 ("test that cannot fail") is now part of test-value.
		if (f.category === 'residue' && f.signature === 7) {
			f.category = 'test-value'
			f.signature = null
			f.test_pattern ??= 'self-computed-expectation'
		}
		const rule = f.category === 'residue' ? `residue-${f.signature}` : f.category
		// A malformed residue finding gets its own reason from validateFinding below.
		const malformed =
			f.category === 'residue' && !(Number.isInteger(f.signature) && (f.signature as number) >= 1 && (f.signature as number) <= 7)
		if (!malformed && !owned.has(rule as ReviewRule)) {
			rejected.push(reject(f, `Outside this reviewer's assigned rules (${rule})`))
			continue
		}
		const result = validateFinding(f, excerpts, comparison, runId, levels)
		if (typeof result === 'string') {
			rejected.push(reject(f, result))
			continue
		}
		const before = raisedBefore(f, threads)
		if (typeof before === 'string') rejected.push(reject(f, before))
		else findings.push(before ? { ...result, raisedBefore: before } : result)
	}
	const limitations = parsed.data.limitations
		.map((l) => l.trim())
		.filter(Boolean)
		.slice(0, MAX_LIMITATIONS_PER_BATCH)
		.map((l) => clip(l, TEXT_LIMITS.limitation))
	const given = new Map(parsed.data.evaluation.map((e) => [e.rule, e]))
	const missing = rules.filter((r) => !given.has(r))
	// The evaluation is the proof that every rule was checked; an answer that skips rules is not a complete review.
	if (missing.length) throw new InvalidOutputError(`The review did not report on every rule (missing: ${missing.join(', ')})`)
	const evaluation = rules.map((rule) => {
		const e = given.get(rule)!
		return {
			rule,
			why: clip(e.why.trim(), TEXT_LIMITS.note),
			nearMisses: e.near_misses.slice(0, 10).map((m) => {
				const excerpt = m.excerpt_id ? excerpts.get(m.excerpt_id) : undefined
				return {
					fileKey: excerpt?.file.key ?? null,
					line: m.line,
					note: clip(m.note.trim(), TEXT_LIMITS.note),
					...(excerpt ? { excerptId: excerpt.id } : {}),
				}
			}),
		}
	})
	const byPath = new Map(
		batch.excerpts.flatMap((e) => [e.file.newPath, e.file.oldPath].filter(Boolean).map((p) => [p as string, e.file.key])),
	)
	const unexplained = parsed.data.unexplained_files
		.filter((u) => byPath.has(u.file_path))
		.slice(0, 20)
		.map((u) => ({ fileKey: byPath.get(u.file_path)!, why: clip(u.why.trim(), TEXT_LIMITS.note) }))
	const outdatedDocs = parsed.data.outdated_docs
		.filter((d) => isProjectDocPath(d.doc_path) && d.why.trim())
		.slice(0, 10)
		.map((d) => ({ path: d.doc_path, line: d.line, why: clip(d.why.trim(), TEXT_LIMITS.note) }))
	return { findings, rejected, limitations, evaluation, unexplained, outdatedDocs }
}

/**
 * The thread a finding says already raised it. Saying so without what is new is the repeat this field exists to stop,
 * so it is rejected; a thread id that was never sent is dropped, since the finding itself was checked.
 */
function raisedBefore(f: ModelFinding, threads: ReadonlyMap<string, EarlierThread>): RaisedBefore | null | string {
	const b = f.raised_before
	if (!b) return null
	const t = threads.get(b.thread_id.trim())
	if (!t) return null
	const why = b.why_again.trim()
	if (!why) return `Raises thread ${t.path} again without saying what is new since it`
	return { threadId: t.id, url: t.url, path: t.path, outcome: b.outcome, whyAgain: clip(why, TEXT_LIMITS.whyAgain), settled: t.settled }
}

function reject(f: unknown, reason: string): RejectedFinding {
	const o = (f && typeof f === 'object' ? f : {}) as { title?: unknown; excerpt_id?: unknown }
	return { title: clip(String(o.title ?? ''), TEXT_LIMITS.title), excerptId: clip(String(o.excerpt_id ?? ''), 40), reason }
}

/** The first problem with where it is, e.g. "evaluation.2.near_misses.0.line: Invalid input: expected number, received undefined". */
function issueText(error: z.ZodError): string {
	const issue = error.issues[0]
	if (!issue) return 'unknown'
	return issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message
}

function clip(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

export function validateFinding(
	f: ModelFinding,
	excerpts: Map<string, ContextExcerpt>,
	comparison: Comparison,
	runId: string,
	levels: ReadonlyArray<FindingLevel> = DEFAULT_LEVELS,
): Finding | string {
	const excerpt = excerpts.get(f.excerpt_id)
	if (!excerpt) return `Unknown excerpt id "${clip(f.excerpt_id, 40)}" (not supplied in this request)`
	const side: Side = f.side
	const file = excerpt.file
	const path = side === 'old' ? file.oldPath : file.newPath
	if (path === null) return `Side "${side}" does not exist for this ${file.status} file`
	if (f.file_path !== path)
		return `File path "${clip(f.file_path, 200)}" does not match excerpt ${excerpt.id} (${path} on the ${side} side)`
	if (!Number.isInteger(f.start_line) || !Number.isInteger(f.end_line) || f.start_line < 1 || f.end_line < f.start_line) {
		return `Invalid line range ${f.start_line}-${f.end_line}`
	}
	const lineNumbers = excerpt.lines.map((l) => (side === 'old' ? l.oldNo : l.newNo))
	const supplied = new Map<number, string>()
	excerpt.lines.forEach((l, i) => {
		const n = lineNumbers[i]
		if (n !== null) supplied.set(n, l.text)
	})
	for (let n = f.start_line; n <= f.end_line; n++) {
		if (!supplied.has(n)) return `Line ${n} (${side}) is not part of excerpt ${excerpt.id}`
	}
	const anchorable = side === 'old' ? excerpt.anchorable.old : excerpt.anchorable.new
	const touchesChange = (from: number, to: number): boolean => {
		for (let n = from; n <= to; n++) if (anchorable.has(n)) return true
		return false
	}
	const evidence = f.evidence.trim()
	if (!evidence) return 'Evidence is empty'
	let start = f.start_line
	let end = f.end_line
	let moved: string | null = null
	const linesOf = (from: number, to: number): Array<string> => Array.from({ length: to - from + 1 }, (_, i) => supplied.get(from + i)!)
	if (!evidenceMatches(evidence, linesOf(start, end))) {
		// Models often cite a range a few lines off from the code they quote; the quote is the better witness.
		const found = locateEvidence(evidence, supplied, start, end)
		if (!found || !touchesChange(found.start, found.end))
			return `Evidence is not found verbatim in ${side} lines ${f.start_line}-${f.end_line}`
		moved = `Moved from lines ${start}-${end} to ${found.start}-${found.end}, where the quoted code is.`
		start = found.start
		end = found.end
	}
	if (!touchesChange(start, end)) return `Lines ${start}-${end} (${side}) are not part of or next to a changed line`
	const cited = linesOf(start, end)
	for (const key of ['title', 'body', 'reasoning'] as const) {
		if (!f[key].trim()) return `Missing ${key}`
	}
	const policy = checkPolicy(f, levels)
	if (typeof policy === 'string') return policy
	const anchor: Anchor = {
		repoId: comparison.repoId,
		baseSha: comparison.baseSha,
		headSha: comparison.headSha,
		fileKey: file.key,
		oldPath: file.oldPath,
		newPath: file.newPath,
		side,
		startLine: start,
		endLine: end,
		excerpt: cited
			.slice(0, 6)
			.map((t) => clip(t, 240))
			.join('\n'),
	}
	return {
		id: randomUUID(),
		runId,
		excerptId: excerpt.id,
		anchor,
		severity: policy.severity,
		category: f.category,
		signature: f.category === 'residue' ? f.signature : null,
		testPattern: f.category === 'test-value' ? f.test_pattern : null,
		title: clip(f.title.trim(), TEXT_LIMITS.title),
		body: clip(f.body.trim(), TEXT_LIMITS.body),
		reasoning: clip(f.reasoning.trim(), TEXT_LIMITS.reasoning),
		// Kept on a finding lowered for its reach: whoever raises it back still has the check.
		disproof:
			policy.severity === 'blocking' || (policy.reach && f.disproof?.trim()) ? clip(f.disproof!.trim(), TEXT_LIMITS.disproof) : null,
		reach: policy.reach,
		background: f.background?.trim() ? clip(f.background.trim(), TEXT_LIMITS.background) : null,
		evidence: clip(evidence, TEXT_LIMITS.evidence),
		adjusted: [moved, policy.adjusted].filter(Boolean).join(' ') || null,
		repeatOf: null,
	}
}

// Residue comments name the defect, never the author (pr-narrative §2e).
const AUTHOR_WORDS = /\b(ai|a\.i\.|llm|chatgpt|copilot|generated|auto-?generated|slop|boilerplate|machine[- ]written|assistant)\b/i

const LEVEL_NAME: Record<FindingLevel, string> = {
	blocking: 'blocking',
	should_fix: 'should fix',
	question: 'question',
	suggestion: 'suggestion',
	nit: 'nit',
	fyi: 'FYI',
	pre_existing: 'pre-existing',
}

// Where a finding goes when its level is turned off: only to a neighbour that says the same thing less strongly.
const FALLBACK: Partial<Record<FindingLevel, Array<FindingLevel>>> = {
	blocking: ['should_fix'],
	nit: ['suggestion'],
	suggestion: ['nit'],
}

/** Severity and residue rules from the review policy that can be checked mechanically, and the levels turned on. */
function checkPolicy(
	f: ModelFinding,
	levels: ReadonlyArray<FindingLevel>,
): { severity: Finding['severity']; adjusted: string | null; reach?: FindingReach | null } | string {
	if (f.category === 'test-value' && !f.test_pattern) return 'Test finding without a test_pattern'
	if (f.category === 'residue') {
		if (f.signature === null || !Number.isInteger(f.signature) || f.signature < 1 || f.signature > 6)
			return 'Residue finding without a signature 1-6'
		if (f.severity === 'pre_existing') return 'Residue must be text this change added, not pre-existing'
		if (AUTHOR_WORDS.test(f.body) || AUTHOR_WORDS.test(f.title))
			return 'Residue comment speculates about who or what wrote the code; it must name the defect only'
		const level = residueLevel(levels)
		if (!level) return 'Residue needs the nit, suggestion or should fix level, and all three are turned off'
		return {
			severity: level,
			adjusted: f.severity === 'blocking' ? `Lowered to ${LEVEL_NAME[level]}: residue has no behavior, so it cannot block.` : null,
		}
	}
	if (f.category === 'misleading-name') {
		if (f.severity === 'pre_existing') return 'Misleading name must be one this change added or renamed, not pre-existing'
		const level = residueLevel(levels)
		if (!level) return 'Misleading name needs the nit, suggestion or should fix level, and all three are turned off'
		return {
			severity: level,
			adjusted: f.severity === 'blocking' ? `Lowered to ${LEVEL_NAME[level]}: a name has no behavior, so it cannot block.` : null,
		}
	}
	let severity: FindingLevel = f.severity
	let adjusted: string | null = null
	const reach: FindingReach | null =
		f.severity === 'blocking' && f.reach?.note.trim()
			? { path: f.reach.path, note: clip(f.reach.note.trim(), TEXT_LIMITS.reach), losesData: f.reach.loses_data }
			: null
	// Reach only moves a finding to should fix, never out of the review: with should fix turned off, it stays blocking.
	// With blocking turned off, the finding moves down for that reason below.
	const capReach = levels.includes('blocking') && levels.includes('should_fix')
	if (severity === 'blocking' && !f.disproof?.trim()) {
		severity = 'should_fix'
		adjusted = 'Lowered to should fix: a blocking finding needs a check that would prove it false, and none was given.'
	} else if (severity === 'blocking' && !reach && capReach) {
		severity = 'should_fix'
		adjusted =
			'Lowered to should fix: a blocking finding needs to say who it reaches (the case this change is for, or a path its callers commonly use), and it did not.'
	} else if (severity === 'blocking' && reach && !reachBlocks(f.category, reach) && capReach) {
		severity = 'should_fix'
		adjusted = `Lowered to should fix: it needs a rare path or another case (${reach.note.replace(/\.$/, '')}), not the case this change is for or a path its callers commonly use.`
	}
	if (!levels.includes(severity)) {
		const to = FALLBACK[severity]?.find((l) => levels.includes(l))
		if (!to) return `The ${LEVEL_NAME[severity]} level is turned off in settings`
		adjusted = `${adjusted ? `${adjusted} ` : ''}Moved from ${LEVEL_NAME[severity]} to ${LEVEL_NAME[to]}: ${LEVEL_NAME[severity]} is turned off in settings.`
		severity = to
	}
	return { severity, adjusted, reach }
}

/** Whether a problem with this reach may block: the change's own case or a common path, or any path for security or data loss. */
export function reachBlocks(category: FindingCategory | undefined, reach: FindingReach): boolean {
	return reach.path !== 'rare-path' || category === 'security' || reach.losesData
}

/**
 * What the double-check does to a blocking finding whose reach it could not confirm: should fix, with the reason, when
 * should fix is turned on. Never for security or data loss, a finding it showed to be wrong (that says more), or a
 * check that failed. Returns null when the level stays.
 */
export function reachLowered(
	f: Finding,
	v: FindingVerification,
	levels: ReadonlyArray<FindingLevel>,
): { severity: FindingLevel; adjusted: string } | null {
	if (f.severity !== 'blocking' || v.error || v.verdict === 'wrong' || !v.reach || v.reach.verdict === 'confirmed') return null
	if (f.category === 'security' || f.reach?.losesData || !levels.includes('should_fix')) return null
	const why =
		v.reach.verdict === 'rare'
			? 'the double-check found it only happens on a rare path or another case'
			: 'the double-check could not confirm it hits the case this change is for or a path its callers commonly use'
	const note = v.reach.note.trim().replace(/\.$/, '')
	return {
		severity: 'should_fix',
		adjusted: `Lowered to should fix: ${why}${note ? ` (${clip(note, TEXT_LIMITS.reach)})` : ''}.`,
	}
}

const SEVERITY_RANK: Record<string, number> = {
	blocking: 0,
	high: 0,
	should_fix: 1,
	medium: 1,
	question: 2,
	suggestion: 3,
	nit: 4,
	fyi: 5,
	pre_existing: 6,
	low: 6,
}

type Budget = 'defect' | 'performance' | 'structure' | 'convention' | 'naming' | 'tests' | 'residue' | 'drift'
export function budgetOf(c: FindingCategory | undefined): Budget {
	if (c === 'drift') return 'drift'
	if (c === 'file-split' || c === 'over-engineered') return 'structure'
	if (c === 'test-value') return 'tests'
	if (c === 'misleading-name') return 'naming'
	if (c === 'performance') return 'performance'
	return c === 'convention' ? 'convention' : c === 'residue' ? 'residue' : 'defect'
}

/** Review-wide limits (pr-narrative §2, §2d, §2e). Separate budgets, so residue and structure never displace a defect. */
export const BUDGETS = {
	defect: { perFile: 3, total: 10 },
	performance: { perFile: 2, total: 3 },
	structure: { perFile: 2, total: 2 },
	convention: { perFile: 3, total: 3 },
	naming: { perFile: 2, total: 3 },
	tests: { perFile: 2, total: 4 },
	residue: { perFile: 2, total: 4 },
	drift: { perFile: 2, total: 3 },
} as const

/**
 * Splits new findings into those that fit the run's remaining budget and those held back. Most severe first; within a
 * severity, the order the model gave. Residue also allows one finding per file and signature.
 */
export function applyBudget(existing: Array<Finding>, incoming: Array<Finding>): { kept: Array<Finding>; held: Array<Finding> } {
	const counted = existing.filter((f) => !f.heldBack)
	const kept: Array<Finding> = []
	const held: Array<Finding> = []
	const order = incoming
		.map((f, i) => [f, i] as const)
		.sort((a, b) => (SEVERITY_RANK[a[0].severity] ?? 3) - (SEVERITY_RANK[b[0].severity] ?? 3) || a[1] - b[1])
	for (const [f] of order) {
		const kind = budgetOf(f.category)
		const same = [...counted, ...kept].filter((x) => budgetOf(x.category) === kind)
		const inFile = same.filter((x) => x.anchor.fileKey === f.anchor.fileKey)
		const limit = BUDGETS[kind]
		let reason: string | null = null
		if (kind === 'residue' && inFile.some((x) => x.signature === f.signature))
			reason = 'Another finding already covers this signature in this file.'
		else if (inFile.length >= limit.perFile)
			reason = `Over the limit of ${limit.perFile} ${BUDGET_LABEL[kind]} per file; more severe ones were kept.`
		else if (same.length >= limit.total)
			reason = `Over the limit of ${limit.total} ${BUDGET_LABEL[kind]} per review; more severe ones were kept.`
		if (reason) held.push({ ...f, heldBack: reason })
		else kept.push(f)
	}
	return { kept, held }
}

const BUDGET_LABEL: Record<Budget, string> = {
	defect: 'line findings',
	performance: 'performance findings',
	structure: 'structural findings',
	convention: 'convention findings',
	naming: 'misleading-name findings',
	tests: 'test findings',
	residue: 'residue findings',
	drift: 'base-branch findings',
}

function squash(s: string): string {
	return s.replace(/\s+/g, ' ').trim()
}

// A line that only marks code left out of a quote ("...", "…", "// ...").
const ELISION = /^(?:(?:\/\/|#|--|\*)\s*)?(?:\.\.\.|…)$/

/**
 * Evidence must appear in the cited lines, ignoring whitespace differences (models often re-indent) and lines that
 * only mark an omission between the quoted lines.
 */
export function evidenceMatches(evidence: string, cited: Array<string>): boolean {
	const source = squash(cited.join('\n'))
	const lines = evidence
		.split('\n')
		.map(squash)
		.filter((line) => line && !ELISION.test(line))
	return lines.length > 0 && lines.every((line) => source.includes(line))
}

export const EVIDENCE_NEARBY = 10 // how many lines from the cited range the quoted code may sit and still be found

/**
 * The lines the evidence really quotes when the cited range misses them: the shortest window of consecutive supplied
 * lines that holds it, at most EVIDENCE_NEARBY lines from the cited range, closest first. Null when there is none.
 */
export function locateEvidence(
	evidence: string,
	supplied: ReadonlyMap<number, string>,
	start: number,
	end: number,
): { start: number; end: number } | null {
	const quoted = evidence.split('\n').filter((l) => squash(l) && !ELISION.test(squash(l))).length
	const longest = Math.max(end - start + 1, quoted) + 2
	let best: { start: number; end: number; distance: number } | null = null
	for (let from = Math.max(1, start - EVIDENCE_NEARBY); from <= end + EVIDENCE_NEARBY; from++) {
		const window: Array<string> = []
		for (let to = from; to <= end + EVIDENCE_NEARBY && to - from < longest; to++) {
			const text = supplied.get(to)
			if (text === undefined) break
			window.push(text)
			if (!evidenceMatches(evidence, window)) continue
			const distance = Math.max(0, start - from) + Math.max(0, to - end)
			if (!best || distance < best.distance || (distance === best.distance && to - from < best.end - best.start))
				best = { start: from, end: to, distance }
			break
		}
	}
	return best && { start: best.start, end: best.end }
}

export function findingKey(f: Pick<Finding, 'anchor' | 'title'>): string {
	const a = f.anchor
	return [a.fileKey, a.side, a.startLine, a.endLine, squash(f.title).toLowerCase()].join('\u0000')
}

function overlaps(a: Anchor, b: Anchor): boolean {
	return a.fileKey === b.fileKey && a.side === b.side && (a.startLine ?? 0) <= (b.endLine ?? 0) && (b.startLine ?? 0) <= (a.endLine ?? 0)
}

function words(s: string): Set<string> {
	return new Set(
		s
			.toLowerCase()
			.split(/[^a-z0-9_]+/)
			.filter((w) => w.length > 2),
	)
}

/** Same problem reported twice: same location and title, or overlapping lines with near-identical titles. */
export function isDuplicate(a: Pick<Finding, 'anchor' | 'title'>, b: Pick<Finding, 'anchor' | 'title'>): boolean {
	if (findingKey(a) === findingKey(b)) return true
	if (!overlaps(a.anchor, b.anchor)) return false
	const wa = words(a.title)
	const wb = words(b.title)
	if (wa.size === 0 || wb.size === 0) return false
	let common = 0
	for (const w of wa) if (wb.has(w)) common++
	return common / Math.min(wa.size, wb.size) >= 0.8
}

/**
 * Two team members describe the same problem in their own words and under their own rule, so titles rarely match. Treat
 * overlapping lines that quote the same source as one problem.
 */
export function sameProblem(a: Pick<Finding, 'anchor' | 'title' | 'evidence'>, b: Pick<Finding, 'anchor' | 'title' | 'evidence'>): boolean {
	if (isDuplicate(a, b)) return true
	if (!overlaps(a.anchor, b.anchor)) return false
	const ea = squash(a.evidence)
	const eb = squash(b.evidence)
	return !!ea && !!eb && (ea.includes(eb) || eb.includes(ea))
}

export function dedupe(existing: Array<Finding>, incoming: Array<Finding>): { kept: Array<Finding>; dropped: Array<RejectedFinding> } {
	const kept: Array<Finding> = []
	const dropped: Array<RejectedFinding> = []
	for (const f of incoming) {
		const dup = [...existing, ...kept].find((e) => isDuplicate(e, f))
		if (dup) dropped.push({ title: f.title, excerptId: f.excerptId, reason: `Duplicate of "${dup.title}"` })
		else kept.push(f)
	}
	return { kept, dropped }
}

// "@login" as GitHub reads a mention: not inside a word or an email address, not part of a longer name.
const MENTION = /(^|[^\w@./`-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?![\w-])/g

/**
 * The text with every @mention of someone outside `people` turned into code, so posting it pings nobody the model was
 * not shown taking part (a comment in the pull request could ask for any login). Code spans and blocks are left as
 * they are: GitHub does not read mentions there, and "@Override" in code is not a person.
 */
export function onlyKnownMentions(text: string, people: ReadonlySet<string>): string {
	return text
		.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/)
		.map((part, i) =>
			i % 2
				? part
				: part.replace(MENTION, (all, before: string, login: string) => (people.has(login.toLowerCase()) ? all : `${before}\`@${login}\``)),
		)
		.join('')
}

/** The finding with @mentions of anyone outside `people` defused in its posted text (body and background). */
export function withKnownMentions(f: Finding, people: ReadonlySet<string>): Finding {
	return {
		...f,
		...(f.body === undefined ? {} : { body: onlyKnownMentions(f.body, people) }),
		...(f.background ? { background: onlyKnownMentions(f.background, people) } : {}),
	}
}
