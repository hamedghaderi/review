import { randomUUID } from 'node:crypto'
import {
	REVIEW_RULES,
	type Anchor,
	type FindingLevel,
	type Comparison,
	type Finding,
	type FindingCategory,
	type NearMiss,
	type OutdatedDoc,
	type RejectedFinding,
	type ReviewRule,
	type Side,
} from '../../shared/types.ts'
import type { ContextBatch, ContextExcerpt } from './context.ts'
import { DEFAULT_LEVELS, residueLevel } from './prompt.ts'
import { reviewOutputSchema, type ModelFinding } from './schema.ts'

const TEXT_LIMITS = {
	title: 200,
	body: 6000,
	reasoning: 600,
	disproof: 2000,
	background: 1200,
	evidence: 4000,
	limitation: 1000,
	note: 400,
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
 * line range and evidence all match are kept; everything else is recorded with a reason.
 */
export function validateBatchOutput(
	output: unknown,
	batch: ContextBatch,
	comparison: Comparison,
	runId: string,
	rules: ReadonlyArray<ReviewRule> = REVIEW_RULES,
	levels: ReadonlyArray<FindingLevel> = DEFAULT_LEVELS,
): ValidatedBatch {
	const parsed = reviewOutputSchema.safeParse(output)
	if (!parsed.success)
		throw new InvalidOutputError(`Output does not match the findings schema: ${parsed.error.issues[0]?.message ?? 'unknown'}`)
	const excerpts = new Map(batch.excerpts.map((e) => [e.id, e]))
	const findings: Array<Finding> = []
	const rejected: Array<RejectedFinding> = []
	const items = parsed.data.findings
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
		if (typeof result === 'string') rejected.push(reject(f, result))
		else findings.push(result)
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
			nearMisses: e.near_misses.slice(0, 10).map((m) => ({
				fileKey: (m.excerpt_id && excerpts.get(m.excerpt_id)?.file.key) || null,
				line: m.line,
				note: clip(m.note.trim(), TEXT_LIMITS.note),
			})),
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
		.filter((d) => /^\.review\/[^\0]+\.md$/.test(d.doc_path) && !d.doc_path.split('/').includes('..') && d.why.trim())
		.slice(0, 10)
		.map((d) => ({ path: d.doc_path, line: d.line, why: clip(d.why.trim(), TEXT_LIMITS.note) }))
	return { findings, rejected, limitations, evaluation, unexplained, outdatedDocs }
}

function reject(f: ModelFinding, reason: string): RejectedFinding {
	return { title: clip(String(f.title ?? ''), TEXT_LIMITS.title), excerptId: clip(String(f.excerpt_id ?? ''), 40), reason }
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
	const cited: Array<string> = []
	for (let n = f.start_line; n <= f.end_line; n++) {
		const text = supplied.get(n)
		if (text === undefined) return `Line ${n} (${side}) is not part of excerpt ${excerpt.id}`
		cited.push(text)
	}
	const anchorable = side === 'old' ? excerpt.anchorable.old : excerpt.anchorable.new
	let touchesChange = false
	for (let n = f.start_line; n <= f.end_line && !touchesChange; n++) touchesChange = anchorable.has(n)
	if (!touchesChange) return `Lines ${f.start_line}-${f.end_line} (${side}) are not part of or next to a changed line`
	const evidence = f.evidence.trim()
	if (!evidence) return 'Evidence is empty'
	if (!evidenceMatches(evidence, cited)) return `Evidence is not found verbatim in ${side} lines ${f.start_line}-${f.end_line}`
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
		startLine: f.start_line,
		endLine: f.end_line,
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
		disproof: policy.severity === 'blocking' ? clip(f.disproof!.trim(), TEXT_LIMITS.disproof) : null,
		background: f.background?.trim() ? clip(f.background.trim(), TEXT_LIMITS.background) : null,
		evidence: clip(evidence, TEXT_LIMITS.evidence),
		adjusted: policy.adjusted,
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
): { severity: Finding['severity']; adjusted: string | null } | string {
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
	let severity: FindingLevel = f.severity
	let adjusted: string | null = null
	if (severity === 'blocking' && !f.disproof?.trim()) {
		severity = 'should_fix'
		adjusted = 'Lowered to should fix: a blocking finding needs a check that would prove it false, and none was given.'
	}
	if (!levels.includes(severity)) {
		const to = FALLBACK[severity]?.find((l) => levels.includes(l))
		if (!to) return `The ${LEVEL_NAME[severity]} level is turned off in settings`
		adjusted = `${adjusted ? `${adjusted} ` : ''}Moved from ${LEVEL_NAME[severity]} to ${LEVEL_NAME[to]}: ${LEVEL_NAME[severity]} is turned off in settings.`
		severity = to
	}
	return { severity, adjusted }
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

type Budget = 'defect' | 'structure' | 'convention' | 'tests' | 'residue'
export function budgetOf(c: FindingCategory | undefined): Budget {
	if (c === 'file-split' || c === 'over-engineered') return 'structure'
	if (c === 'test-value') return 'tests'
	return c === 'convention' ? 'convention' : c === 'residue' ? 'residue' : 'defect'
}

/** Review-wide limits (pr-narrative §2, §2d, §2e). Separate budgets, so residue and structure never displace a defect. */
export const BUDGETS = {
	defect: { perFile: 3, total: 10 },
	structure: { perFile: 2, total: 2 },
	convention: { perFile: 3, total: 3 },
	tests: { perFile: 2, total: 4 },
	residue: { perFile: 2, total: 4 },
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
			reason = `Over the limit of ${limit.perFile} ${label(kind)} per file; more severe ones were kept.`
		else if (same.length >= limit.total) reason = `Over the limit of ${limit.total} ${label(kind)} per review; more severe ones were kept.`
		if (reason) held.push({ ...f, heldBack: reason })
		else kept.push(f)
	}
	return { kept, held }
}

function label(k: Budget): string {
	return k === 'defect'
		? 'line findings'
		: k === 'structure'
			? 'structural findings'
			: k === 'convention'
				? 'convention findings'
				: k === 'tests'
					? 'test findings'
					: 'residue findings'
}

function squash(s: string): string {
	return s.replace(/\s+/g, ' ').trim()
}

/** Evidence must appear in the cited lines, ignoring whitespace differences (models often re-indent). */
export function evidenceMatches(evidence: string, cited: Array<string>): boolean {
	const source = squash(cited.join('\n'))
	return evidence
		.split('\n')
		.map(squash)
		.filter(Boolean)
		.every((line) => source.includes(line))
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
