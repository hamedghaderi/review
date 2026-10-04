import { computeGaps } from '../../shared/diff.ts'
import type {
	ChangedFile,
	Comparison,
	DiffLine,
	FileRisk,
	FileCoverage,
	FileLinesResult,
	Hunk,
	LineRange,
	PatchResult,
	Side,
	SkippedRange,
	SuppliedExcerpt,
} from '../../shared/types.ts'
import type { RelatedSnippet } from './related.ts'
import { byRisk } from './risk.ts'

export interface ContextLimits {
	contextLines: number // unchanged lines of surrounding source on each side of a change
	maxBatchChars: number // input characters per provider request
	maxRunChars: number // input characters across the whole run
	relatedCode?: boolean // also send definitions and uses of the change's names (default on)
	lookups?: boolean // let the reviewer read files and search the repository while it reviews (default on)
	verify?: boolean // double-check blocking findings after the review (default on)
	groupDuplicates?: boolean // fold findings the model says are the same problem (default off)
}

// With related code, changed excerpts fill at most this share of a request; related code fills the rest.
export const CHANGED_SHARE = 0.7

// ponytail: fixed chars-per-token estimate for sizing batches; code usually tokenises at 3–4 chars per token, so 3
// errs on the side of smaller requests. Use a real tokenizer per provider if batches turn out too conservative.
export const CHARS_PER_TOKEN = 3

/**
 * Caps the per-request input so instructions, input and the requested output fit the model's context window.
 * Returns null when the window is too small for any useful request.
 */
export function fitToModel(
	limits: ContextLimits,
	model: { contextWindow: number },
	outputTokens: number,
	instructionChars: number,
	reserve = 0, // share of the request input kept free, e.g. for lookups
): { limits: ContextLimits; note: string | null } | null {
	const maxChars = Math.floor(capacityChars(model.contextWindow, outputTokens, instructionChars) * (1 - reserve))
	if (maxChars < 3000) return null
	if (maxChars >= limits.maxBatchChars) return { limits, note: null }
	return {
		limits: { ...limits, maxBatchChars: maxChars },
		note: `Requests were limited to ${maxChars.toLocaleString()} characters to fit the model's ${model.contextWindow.toLocaleString()}-token context window${reserve ? `, with ${Math.round(reserve * 100)}% kept free for lookups` : ''}.`,
	}
}

/** Input characters a request can carry besides its instructions, by the fixed chars-per-token estimate. */
export function capacityChars(contextWindow: number, outputTokens: number, instructionChars: number): number {
	return Math.floor((contextWindow - outputTokens - Math.ceil(instructionChars / CHARS_PER_TOKEN) - 256) * CHARS_PER_TOKEN)
}

// Lines this close to a changed line count as part of the change for anchoring.
export const ANCHOR_MARGIN = 3

export interface ExcerptLine {
	kind: DiffLine['kind']
	oldNo: number | null
	newNo: number | null
	text: string
}

export interface ContextExcerpt {
	id: string
	file: ChangedFile
	lines: Array<ExcerptLine>
	old: LineRange | null
	new: LineRange | null
	anchorable: { old: Set<number>; new: Set<number> }
	text: string // rendered for the model
}

/** Code outside the change, sent read-only so the reviewer can see definitions and callers. Never citable. */
export interface ContextReference {
	id: string // R1, R2…
	path: string
	start: number
	end: number
	text: string
}

/**
 * Something the app computed or read for the reviewer (project context, dependency range checks, CI results). Sent as data with the
 * request; `fileKeys` null means every request, otherwise only requests that carry one of those files.
 */
export interface ContextFact {
	kind: 'project' | 'dependencies' | 'ci' | 'structure' | 'decisions'
	title: string
	text: string
	fileKeys: Array<string> | null
}

export interface ContextBatch {
	index: number
	excerpts: Array<ContextExcerpt>
	references: Array<ContextReference>
	facts: Array<ContextFact>
	fileKeys: Array<string>
	overview: string
	chars: number
}

export interface FileSource {
	file: ChangedFile
	patch: PatchResult
	fullText: FileLinesResult | null // newer version (older for deletions), for surrounding context
}

export interface ContextPackage {
	batches: Array<ContextBatch>
	files: Array<FileCoverage>
	skippedRanges: Array<SkippedRange>
	supplied: Array<SuppliedExcerpt>
	inputChars: number
	related: { sent: number; chars: number; omitted: number }
}

/** The change cut into excerpts once, so excerpt ids mean the same lines in every member's requests. */
export interface PreparedChange {
	excerpts: Array<ContextExcerpt>
	files: Array<FileCoverage>
	skippedRanges: Array<SkippedRange>
}

/** Which files one reviewer gets, and who gets the rest; null in either means everything. */
export interface Routing {
	fileKeys: Set<string>
	label: string | null // the member's role, put in front of its run-limit skips
}

/**
 * Turns the changed files in scope into bounded provider batches. Nothing is truncated: content that does not fit
 * is recorded in `skippedRanges`/`files` with a reason.
 */
export function buildContext(
	comparison: Comparison,
	sources: Array<FileSource>,
	limits: ContextLimits,
	related: Array<RelatedSnippet> = [],
	factsIn: Array<ContextFact> = [],
	risk: Array<FileRisk> = [],
): ContextPackage {
	const prepared = prepareChange(sources, limits, factsIn)
	const pkg = packContext(comparison, sources, prepared, limits, related, factsIn, risk, null)
	return { ...pkg, files: settleFiles(prepared, [pkg], null, risk), skippedRanges: [...prepared.skippedRanges, ...pkg.skippedRanges] }
}

/** Cuts every changed file into excerpts that fit a request of `limits.maxBatchChars` (the smallest reviewer's). */
export function prepareChange(sources: Array<FileSource>, limits: ContextLimits, factsIn: Array<ContextFact> = []): PreparedChange {
	const files: Array<FileCoverage> = []
	const skippedRanges: Array<SkippedRange> = []
	const excerpts: Array<ContextExcerpt> = []
	let nextId = 1
	const excerptBudget = budgets(limits, factsIn).excerpt

	for (const source of sources) {
		const { file, patch } = source
		if (patch.kind === 'binary') {
			files.push({ fileKey: file.key, state: 'not-reviewable', reason: 'Binary file' })
			continue
		}
		if (patch.kind === 'too-large') {
			files.push({ fileKey: file.key, state: 'skipped', reason: `Diff too large to review: ${patch.reason}` })
			skippedRanges.push({ fileKey: file.key, old: null, new: null, reason: `Diff too large: ${patch.reason}` })
			continue
		}
		if (patch.hunks.length === 0) {
			files.push({ fileKey: file.key, state: 'not-reviewable', reason: 'No content changes' })
			continue
		}
		const { rows, note } = fileRows(file, patch.hunks, source.fullText)
		let fileSkipped = false
		for (const segment of segments(rows, limits.contextLines)) {
			for (const chunk of chunkBySize(file, segment, excerptBudget)) {
				if (chunk.tooLong) {
					fileSkipped = true
					skippedRanges.push({
						fileKey: file.key,
						...ranges(chunk.lines),
						reason: `A single line is ${chunk.chars.toLocaleString()} characters, over the per-request limit of ${excerptBudget.toLocaleString()}`,
					})
					continue
				}
				excerpts.push(makeExcerpt(`E${nextId++}`, file, chunk.lines))
			}
		}
		files.push({ fileKey: file.key, state: 'pending', reason: fileSkipped ? 'Some lines were too long to send' : note })
	}
	return { excerpts, files, skippedRanges }
}

function budgets(limits: ContextLimits, factsIn: Array<ContextFact>): { overview: number; facts: Array<ContextFact>; excerpt: number } {
	const overview = Math.floor(limits.maxBatchChars / 4)
	const facts = fitFacts(factsIn, Math.floor(limits.maxBatchChars / 8))
	return { overview, facts, excerpt: limits.maxBatchChars - overview - facts.reduce((n, f) => n + f.text.length, 0) }
}

/**
 * Packs the excerpts of the routed files into one reviewer's requests, sized by `limits` (that reviewer's own), with
 * the facts and related code about those files. `skippedRanges` holds only what this reviewer's run limit left out.
 */
export function packContext(
	comparison: Comparison,
	sources: Array<FileSource>,
	prepared: PreparedChange,
	limits: ContextLimits,
	related: Array<RelatedSnippet>,
	factsIn: Array<ContextFact>,
	risk: Array<FileRisk>,
	routing: Routing | null,
): ContextPackage {
	const riskOf = new Map(risk.map((r) => [r.fileKey, r]))
	const mine = (key: string): boolean => !routing || routing.fileKeys.has(key)
	const { overview: overviewBudget, excerpt: excerptBudget } = budgets(limits, factsIn)
	const facts = budgets(limits, factsIn).facts.filter((f) => !f.fileKeys || f.fileKeys.some(mine))
	const skippedRanges: Array<SkippedRange> = []

	// Pack excerpts into batches, respecting the per-request and per-run limits.
	const batches: Array<ContextBatch> = []
	const supplied: Array<SuppliedExcerpt> = []
	let current: Array<ContextExcerpt> = []
	let currentChars = 0
	let runChars = 0
	let runLimitHit = false
	const packBudget = related.length ? Math.floor(excerptBudget * CHANGED_SHARE) : excerptBudget
	// Riskiest files are packed first, so when the run limit is reached it is low-risk code that is left out. Excerpt
	// ids and the file list keep the comparison's order.
	const rank = new Map(byRisk(sources, risk).map((x, i) => [x.file.key, i]))
	const pending = prepared.excerpts.filter((e) => mine(e.file.key)).sort((a, b) => rank.get(a.file.key)! - rank.get(b.file.key)!)
	function close(): void {
		if (current.length === 0) return
		batches.push({
			index: batches.length,
			excerpts: current,
			references: [],
			facts: [],
			fileKeys: [...new Set(current.map((e) => e.file.key))],
			overview: '',
			chars: 0,
		})
		current = []
		currentChars = 0
	}
	for (const excerpt of pending) {
		const size = excerpt.text.length
		if (runLimitHit || runChars + size > limits.maxRunChars) {
			runLimitHit = true
			skippedRanges.push({
				fileKey: excerpt.file.key,
				old: excerpt.old,
				new: excerpt.new,
				reason: `${routing?.label ? `${routing.label}: ` : ''}Run input limit of ${limits.maxRunChars.toLocaleString()} characters reached`,
			})
			continue
		}
		if (currentChars + size > packBudget) close()
		current.push(excerpt)
		currentChars += size
		runChars += size
	}
	close()

	// Facts go with the files they are about (or the first request when none of those files is sent), CI with every request.
	for (const f of facts) {
		const keys = f.fileKeys && new Set(f.fileKeys)
		const into = keys ? batches.filter((b) => b.fileKeys.some((k) => keys.has(k))) : batches
		for (const b of into.length ? into : batches.slice(0, 1)) {
			b.facts.push(f)
			runChars += f.text.length
		}
	}

	// Related code fills the space the changed excerpts leave, most useful first, and only in requests that carry a
	// file it relates to. Changed code was counted against the run limit first, so related code never displaces it.
	const refs = related.map((r, i) => ({ r, ref: reference(`R${i + 1}`, r) })).sort((a, b) => a.r.priority - b.r.priority)
	const sent = new Set<string>()
	const wanted = new Set<string>()
	let relatedChars = 0
	for (const batch of batches) {
		let room = excerptBudget - batch.excerpts.reduce((n, e) => n + e.text.length, 0)
		const inBatch = new Set(batch.fileKeys)
		for (const { r, ref } of refs) {
			if (![...r.fileKeys].some((k) => inBatch.has(k))) continue
			if (covered(batch, r)) continue
			wanted.add(ref.id)
			if (ref.text.length > room || runChars + ref.text.length > limits.maxRunChars) continue
			batch.references.push(ref)
			sent.add(ref.id)
			room -= ref.text.length
			runChars += ref.text.length
			relatedChars += ref.text.length
		}
	}

	for (const batch of batches) {
		batch.overview = overview(comparison, sources, batch, batches, overviewBudget, riskOf, routing)
		batch.chars =
			batch.overview.length +
			batch.excerpts.reduce((n, e) => n + e.text.length, 0) +
			batch.references.reduce((n, r) => n + r.text.length, 0) +
			batch.facts.reduce((n, f) => n + f.text.length, 0)
		for (const e of batch.excerpts) {
			supplied.push({
				excerptId: e.id,
				batch: batch.index,
				fileKey: e.file.key,
				oldPath: e.file.oldPath,
				newPath: e.file.newPath,
				old: e.old,
				new: e.new,
			})
		}
	}
	return {
		batches,
		files: [],
		skippedRanges,
		supplied,
		inputChars: batches.reduce((n, b) => n + b.chars, 0),
		related: { sent: sent.size, chars: relatedChars, omitted: [...wanted].filter((id) => !sent.has(id)).length },
	}
}

/**
 * The run's file list after packing: a file no reviewer was given is not reviewable by this team, and one whose every
 * excerpt was left out is skipped. `routed` is every file some reviewer was given (null: all of them).
 */
export function settleFiles(
	prepared: PreparedChange,
	packages: Array<ContextPackage>,
	routed: { fileKeys: Set<string>; reason: (key: string) => string } | null,
	risk: Array<FileRisk> = [],
): Array<FileCoverage> {
	const riskOf = new Map(risk.map((r) => [r.fileKey, r]))
	const skipped = [...prepared.skippedRanges, ...packages.flatMap((p) => p.skippedRanges)]
	return prepared.files.map((f0) => {
		const f = { ...f0, risk: riskOf.get(f0.fileKey) ?? f0.risk ?? null }
		if (f.state !== 'pending') return f
		if (routed && !routed.fileKeys.has(f.fileKey)) return { ...f, state: 'not-reviewable', reason: routed.reason(f.fileKey) }
		if (!packages.some((p) => p.supplied.some((s) => s.fileKey === f.fileKey)))
			return { ...f, state: 'skipped', reason: skipped.find((r) => r.fileKey === f.fileKey)?.reason ?? 'Not supplied' }
		return f
	})
}

const FACT_ORDER: Record<ContextFact['kind'], number> = { project: 0, decisions: 1, ci: 2, structure: 3, dependencies: 4 }

/** Facts in order (project context first: every finding may need it; then CI: it is short), cut to fit `budget` characters per request. */
function fitFacts(facts: Array<ContextFact>, budget: number): Array<ContextFact> {
	const out: Array<ContextFact> = []
	let left = budget
	for (const f of [...facts].sort((a, b) => FACT_ORDER[a.kind] - FACT_ORDER[b.kind])) {
		if (left < 300) break
		const text = f.text.length <= left ? f.text : `${f.text.slice(0, left - 60)}\n… (cut to fit the request size limit)`
		out.push({ ...f, text })
		left -= text.length
	}
	return out
}

/** True when every line of the snippet is already in one of the batch's excerpts (new side). */
function covered(batch: ContextBatch, r: RelatedSnippet): boolean {
	return batch.excerpts.some((e) => e.file.newPath === r.path && e.new !== null && e.new.start <= r.start && e.new.end >= r.end)
}

function reference(id: string, r: RelatedSnippet): ContextReference {
	const width = String(r.end).length
	const body = r.lines.map((l, i) => `${String(r.start + i).padStart(width)} | ${l}`).join('\n')
	const text = [
		`=== BEGIN ${id} (reference, not part of the change) ===`,
		`path: ${r.path} (head version), lines ${r.start}-${r.end}`,
		`why: ${r.reasons.slice(0, 4).join('; ')}`,
		body,
		`=== END ${id} ===`,
		'',
	].join('\n')
	return { id, path: r.path, start: r.start, end: r.end, text }
}

/** All rows of the file: hunk lines plus, when the full text is available, every unchanged line between them. */
function fileRows(
	file: ChangedFile,
	hunks: Array<Hunk>,
	fullText: FileLinesResult | null,
): { rows: Array<ExcerptLine>; note: string | null } {
	const hunkRows = (h: Hunk): Array<ExcerptLine> => h.lines.map((l) => ({ kind: l.kind, oldNo: l.oldNo, newNo: l.newNo, text: l.text }))
	const hasBothSides = file.oldPath !== null && file.newPath !== null
	if (!hasBothSides) return { rows: hunks.flatMap(hunkRows), note: null }
	if (!fullText || fullText.kind !== 'text') {
		const why = !fullText ? 'unavailable' : fullText.kind === 'binary' ? 'binary content' : fullText.reason
		return { rows: hunks.flatMap(hunkRows), note: `Only the diff's own context was supplied (full file ${why})` }
	}
	const lines = fullText.lines
	const gaps = computeGaps(hunks, lines.length)
	const rows: Array<ExcerptLine> = []
	hunks.forEach((h, i) => {
		pushGap(rows, gaps[i], lines)
		rows.push(...hunkRows(h))
	})
	pushGap(rows, gaps[hunks.length], lines)
	return { rows, note: null }
}

function pushGap(rows: Array<ExcerptLine>, gap: { from: number; to: number | null; offset: number }, lines: Array<string>): void {
	const to = Math.min(gap.to ?? lines.length, lines.length)
	for (let n = gap.from; n <= to; n++) rows.push({ kind: 'ctx', oldNo: n + gap.offset, newNo: n, text: lines[n - 1] })
}

/** Contiguous runs of rows within `contextLines` of a changed row. */
function segments(rows: Array<ExcerptLine>, contextLines: number): Array<Array<ExcerptLine>> {
	const keep = new Uint8Array(rows.length)
	rows.forEach((r, i) => {
		if (r.kind === 'ctx') return
		for (let j = Math.max(0, i - contextLines); j <= Math.min(rows.length - 1, i + contextLines); j++) keep[j] = 1
	})
	const out: Array<Array<ExcerptLine>> = []
	let run: Array<ExcerptLine> = []
	rows.forEach((r, i) => {
		if (keep[i]) run.push(r)
		else if (run.length) {
			out.push(run)
			run = []
		}
	})
	if (run.length) out.push(run)
	return out
}

interface Chunk {
	lines: Array<ExcerptLine>
	chars: number
	tooLong: boolean
}

/** Splits a segment into consecutive chunks that each fit the per-request excerpt budget. */
function chunkBySize(file: ChangedFile, lines: Array<ExcerptLine>, budget: number): Array<Chunk> {
	const header = excerptHeader('E0000', file, null, null).length + 200
	const out: Array<Chunk> = []
	let cur: Array<ExcerptLine> = []
	let chars = header
	for (const line of lines) {
		const size = renderLine(line).length + 1
		if (header + size > budget) {
			if (cur.length) out.push({ lines: cur, chars, tooLong: false })
			out.push({ lines: [line], chars: line.text.length, tooLong: true })
			cur = []
			chars = header
			continue
		}
		if (chars + size > budget && cur.length) {
			out.push({ lines: cur, chars, tooLong: false })
			cur = []
			chars = header
		}
		cur.push(line)
		chars += size
	}
	if (cur.length) out.push({ lines: cur, chars, tooLong: false })
	return out
}

function ranges(lines: Array<ExcerptLine>): { old: LineRange | null; new: LineRange | null } {
	const span = (nums: Array<number>): LineRange | null => (nums.length ? { start: Math.min(...nums), end: Math.max(...nums) } : null)
	return {
		old: span(lines.flatMap((l) => (l.oldNo === null ? [] : [l.oldNo]))),
		new: span(lines.flatMap((l) => (l.newNo === null ? [] : [l.newNo]))),
	}
}

function makeExcerpt(id: string, file: ChangedFile, lines: Array<ExcerptLine>): ContextExcerpt {
	const r = ranges(lines)
	const anchorable = { old: new Set<number>(), new: new Set<number>() }
	lines.forEach((l, i) => {
		if (l.kind === 'ctx') return
		for (let j = Math.max(0, i - ANCHOR_MARGIN); j <= Math.min(lines.length - 1, i + ANCHOR_MARGIN); j++) {
			const near = lines[j]
			if (near.oldNo !== null) anchorable.old.add(near.oldNo)
			if (near.newNo !== null) anchorable.new.add(near.newNo)
		}
	})
	const text = `${excerptHeader(id, file, r.old, r.new)}\n${lines.map(renderLine).join('\n')}\n=== END ${id} ===\n`
	return { id, file, lines, old: r.old, new: r.new, anchorable, text }
}

function excerptHeader(id: string, file: ChangedFile, old: LineRange | null, next: LineRange | null): string {
	const fmt = (r: LineRange | null): string => (r ? `${r.start}-${r.end}` : 'none')
	return [
		`=== BEGIN ${id} ===`,
		`file status: ${file.status}`,
		`old path: ${file.oldPath ?? '(none: file added)'}`,
		`new path: ${file.newPath ?? '(none: file deleted)'}`,
		`old lines supplied: ${fmt(old)}; new lines supplied: ${fmt(next)}`,
		'columns: OLD_LINE NEW_LINE MARK | source   (MARK: "+" added, "-" deleted, " " unchanged; "." = no line on that side)',
	].join('\n')
}

export function renderLine(l: ExcerptLine): string {
	const mark = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '
	return `${String(l.oldNo ?? '.').padStart(6)} ${String(l.newNo ?? '.').padStart(6)} ${mark} | ${l.text}`
}

function overview(
	comparison: Comparison,
	sources: Array<FileSource>,
	batch: ContextBatch,
	batches: Array<ContextBatch>,
	budget: number,
	riskOf: Map<string, FileRisk>,
	routing: Routing | null,
): string {
	const where = new Map<string, number>()
	for (const b of batches) for (const k of b.fileKeys) where.set(k, b.index)
	const inScope = new Set(sources.map((s) => s.file.key))
	const describe = (f: ChangedFile): string => {
		const path = f.oldPath && f.newPath && f.oldPath !== f.newPath ? `${f.oldPath} -> ${f.newPath}` : (f.newPath ?? f.oldPath)
		const counts = f.binary ? 'binary' : `+${f.additions ?? 0} -${f.deletions ?? 0}`
		const b = where.get(f.key)
		const state =
			b === batch.index
				? 'IN THIS REQUEST'
				: b !== undefined
					? 'reviewed in another request'
					: routing && inScope.has(f.key) && !routing.fileKeys.has(f.key)
						? "checked by other team members: not one this reviewer's rules apply to"
						: inScope.has(f.key)
							? 'not supplied'
							: 'outside the requested scope'
		const r = inScope.has(f.key) ? riskOf.get(f.key) : undefined
		return `- ${f.status} ${path} (${counts}) [${state}]${r ? ` risk ${r.level}: ${r.reasons.join('; ')}` : ''}`
	}
	const head = [
		`Comparison: base ${comparison.baseSha} (merge base with ${comparison.baseRef}) .. head ${comparison.headSha}${comparison.headRef ? ` (${comparison.headRef})` : ''}${comparison.pr ? ` · pull request #${comparison.pr.number} in ${comparison.pr.repo}` : ''}`,
		`Request ${batch.index + 1} of ${batches.length}. Changed files in the comparison (${comparison.files.length}):`,
	].join('\n')
	const all = comparison.files.map(describe)
	let listed = all
	if (head.length + all.join('\n').length > budget) {
		// ponytail: large comparisons list only this request's files plus a count; a smarter relevance ranking can come later
		listed = comparison.files.filter((f) => batch.fileKeys.includes(f.key)).map(describe)
		listed.push(`- … and ${all.length - listed.length} other changed files, omitted from this list for size`)
	}
	return `${head}\n${listed.join('\n')}\n`
}

export function manifestText(batch: ContextBatch): string {
	const fmt = (side: Side, r: LineRange | null): string => (r ? `${side} ${r.start}-${r.end}` : `${side} none`)
	return batch.excerpts
		.map(
			(e) =>
				`- ${e.id}: old path ${e.file.oldPath ?? '(none)'}, new path ${e.file.newPath ?? '(none)'}; ${fmt('old', e.old)}; ${fmt('new', e.new)}`,
		)
		.join('\n')
}
