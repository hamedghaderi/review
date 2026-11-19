import { computeGaps, type Gap } from '../../shared/diff.ts'
import type { DiffLine, Hunk, Side } from '../../shared/types.ts'

export { computeGaps, type Gap }

export type Row =
	| { t: 'hunk'; key: string; hunk: Hunk }
	| { t: 'line'; key: string; line: DiffLine; block: number | null }
	| { t: 'gap'; key: string; from: number; to: number | null; offset: number; edge: 'top' | 'mid' | 'bottom' }

// A line row's key: an unchanged line from a gap by its new line number, a hunk's line by the hunk and its place in it.
const ctxKey = (n: number): string => `c${n}`
const hunkLineKey = (h: Hunk, j: number): string => `l${h.oldStart},${h.newStart},${j}`

export interface Range {
	side: Side
	start: number
	end: number
}

/**
 * Builds rendered rows: gap i precedes hunk i, the last gap trails. Revealed gap lines become context rows,
 * remaining hidden runs become gap rows. A hunk's "@@" row marks where lines were left out, so it shows only while the
 * line just above the hunk is hidden: once that line is shown the code runs straight on, even if lines further up are
 * still hidden behind their own gap row. A hunk with no gap above it (one starting at line 1) keeps it.
 */
export function buildRows(
	hunks: Array<Hunk>,
	gaps: Array<Gap> | null,
	revealed: Set<number>,
	fileLines: Array<string> | null,
): { rows: Array<Row>; blocks: Array<number> } {
	const rows: Array<Row> = []
	const blocks: Array<number> = []
	let inBlock = false

	/** Pushes the gap's rows; true when it has lines and its last one, the line just above the next hunk, is shown. */
	const pushGap = (g: Gap, edge: 'top' | 'mid' | 'bottom'): boolean => {
		const to = g.to ?? (fileLines ? fileLines.length : null)
		if (to === null) {
			rows.push({ t: 'gap', key: `g${g.from}-`, from: g.from, to: null, offset: g.offset, edge })
			return false
		}
		let lastHidden = false
		let runStart: number | null = null
		const flush = (end: number): void => {
			if (runStart === null) return
			rows.push({ t: 'gap', key: `g${runStart}-${end}`, from: runStart, to: end, offset: g.offset, edge })
			runStart = null
		}
		for (let n = g.from; n <= to; n++) {
			if (revealed.has(n) && fileLines && n <= fileLines.length) {
				flush(n - 1)
				rows.push({ t: 'line', key: ctxKey(n), line: { kind: 'ctx', oldNo: n + g.offset, newNo: n, text: fileLines[n - 1] }, block: null })
			} else {
				lastHidden = n === to
				if (runStart === null) runStart = n
			}
		}
		flush(to)
		return !lastHidden && to >= g.from
	}

	hunks.forEach((h, i) => {
		const g = gaps?.[i]
		const shown = g ? pushGap(g, i === 0 ? 'top' : 'mid') : false
		if (!shown) rows.push({ t: 'hunk', key: `h${h.oldStart},${h.newStart}`, hunk: h })
		inBlock = false
		h.lines.forEach((line, j) => {
			const changed = line.kind !== 'ctx'
			if (changed && !inBlock) blocks.push(rows.length)
			inBlock = changed
			rows.push({ t: 'line', key: hunkLineKey(h, j), line, block: changed ? blocks.length - 1 : null })
		})
	})
	const tail = gaps?.[hunks.length]
	if (tail) pushGap(tail, hunks.length === 0 ? 'top' : 'bottom')
	return { rows, blocks }
}

/** A line of the file's diff that a search looks through. `gapLine`: the new line number of an unchanged line that is collapsed until revealed. */
export interface SearchLine {
	key: string // the key of the line's row, once it is shown
	text: string
	gapLine: number | null
}

/**
 * Every line of the diff in the order it reads, the unchanged lines in its gaps included (when the file's lines are
 * loaded), keyed like buildRows keys their rows. What is revealed doesn't matter: a search finds collapsed lines too.
 */
export function searchLines(hunks: Array<Hunk>, gaps: Array<Gap> | null, fileLines: Array<string> | null): Array<SearchLine> {
	const out: Array<SearchLine> = []
	const gap = (g: Gap | undefined): void => {
		if (!g || !fileLines) return
		const to = Math.min(g.to ?? fileLines.length, fileLines.length)
		for (let n = g.from; n <= to; n++) out.push({ key: ctxKey(n), text: fileLines[n - 1], gapLine: n })
	}
	hunks.forEach((h, i) => {
		gap(gaps?.[i])
		h.lines.forEach((l, j) => out.push({ key: hunkLineKey(h, j), text: l.text, gapLine: null }))
	})
	gap(gaps?.[hunks.length])
	return out
}

export function lineNo(row: Row, side: Side): number | null {
	if (row.t !== 'line') return null
	return side === 'old' ? row.line.oldNo : row.line.newNo
}

/**
 * Normalises a span of rendered rows (e.g. a text selection starting at row `a`) to one side's source lines.
 * Only additions → new; only deletions → old; mixed → the side of the row where the selection started; context → new.
 */
export function normalizeSpan(rows: Array<Row>, a: number, b: number): Range | null {
	const lo = Math.min(a, b)
	const hi = Math.max(a, b)
	let add = false
	let del = false
	for (let i = lo; i <= hi; i++) {
		const r = rows[i]
		if (r?.t !== 'line') continue
		if (r.line.kind === 'add') add = true
		if (r.line.kind === 'del') del = true
	}
	const first = rows[a]
	const side: Side = del && (!add || (first?.t === 'line' && first.line.kind === 'del')) ? 'old' : 'new'
	return spanOnSide(rows, lo, hi, side)
}

/** Min/max source line numbers on `side` among rows lo..hi. */
export function spanOnSide(rows: Array<Row>, a: number, b: number, side: Side): Range | null {
	const lo = Math.min(a, b)
	const hi = Math.max(a, b)
	let start = Infinity
	let end = -Infinity
	for (let i = lo; i <= hi; i++) {
		const n = lineNo(rows[i], side)
		if (n === null) continue
		start = Math.min(start, n)
		end = Math.max(end, n)
	}
	return start === Infinity ? null : { side, start, end }
}

export function excerpt(rows: Array<Row>, r: Range, maxLines = 6): string {
	const out: Array<string> = []
	for (const row of rows) {
		const n = lineNo(row, r.side)
		if (n === null || n < r.start || n > r.end || row.t !== 'line') continue
		out.push(row.line.text.length > 240 ? `${row.line.text.slice(0, 240)}…` : row.line.text)
		if (out.length >= maxLines) break
	}
	return out.join('\n')
}

/** Index of the rendered row an anchor's inline content attaches to: the last rendered row inside the range. */
export function anchorRow(rows: Array<Row>, r: Range): number | null {
	let found: number | null = null
	rows.forEach((row, i) => {
		const n = lineNo(row, r.side)
		if (n !== null && n >= r.start && n <= r.end) found = i
	})
	return found
}

/** New-side line numbers that must be revealed so every line of `r` that sits in a gap is rendered. */
export function linesToReveal(gaps: Array<Gap>, r: Range, totalNew: number): Array<number> {
	const out: Array<number> = []
	for (const g of gaps) {
		const to = g.to ?? totalNew
		const off = r.side === 'old' ? g.offset : 0
		const from = Math.max(g.from, r.start - off)
		const end = Math.min(to, r.end - off)
		for (let n = from; n <= end; n++) out.push(n)
	}
	return out
}

const JUMP_BEFORE = 3 // lines above a jump target: decorators, doc comments, the line before
const JUMP_AFTER = 3 // lines below one that opens no block
const JUMP_BODY = 40 // at most this much of a body; the rest stays collapsed behind its gap row

const indentOf = (s: string): number => /^[ \t]*/.exec(s)![0].replace(/\t/g, '    ').length
// A line at the opening line's own indent that still belongs to it: a closing bracket or `end`.
const CLOSER = /^\s*([}\])]|end\b)/

/**
 * The lines to show around line `n` (1-based) of `lines` when you jump to it (issue #244): a few lines above, and
 * the block it opens, read from indentation: the lines below indented deeper than it, and the closing line at its own
 * indent (`}`, `)`, `end`). A closing line that opens the body (Python's `) -> T:`, `) {`) keeps going. A line that
 * opens no block gets a few lines below instead.
 */
export function blockSpan(lines: ReadonlyArray<string>, n: number): { start: number; end: number } {
	const own = indentOf(lines[n - 1] ?? '')
	let last = n
	for (let i = n + 1; i <= lines.length && i - n <= JUMP_BODY; i++) {
		const t = lines[i - 1]
		if (!t.trim()) continue
		if (indentOf(t) > own) {
			last = i
			continue
		}
		if (!CLOSER.test(t)) break
		last = i
		if (!/[:{]\s*$/.test(t)) break
	}
	return { start: Math.max(1, n - JUMP_BEFORE), end: Math.min(lines.length, Math.max(last, n + JUMP_AFTER)) }
}

/**
 * What to open for a jump to `line` on `side` (go to definition, a file:line reference), in new line numbers: see
 * blockSpan. Only the new version is loaded, so a removed line, which has no unchanged text to read, opens just itself.
 */
export function jumpContext(gaps: ReadonlyArray<Gap>, fileLines: ReadonlyArray<string>, side: Side, line: number): Range {
	let n: number | null = side === 'new' ? line : null
	if (side === 'old')
		for (const g of gaps) {
			const at = line - g.offset
			if (at >= g.from && at <= (g.to ?? fileLines.length)) n = at
		}
	if (n === null || n < 1 || n > fileLines.length) return { side, start: line, end: line }
	return { side: 'new', ...blockSpan(fileLines, n) }
}

/**
 * The lines of `r` that are shown in `rows`, as a fenced code block under their `path:line` (issue #245), to paste into
 * a comment. Lines left out in between (collapsed ones) become "…". The fence is longer than any run of backticks in
 * the code, so the block can't end early.
 */
export function snippet(rows: ReadonlyArray<Row>, r: Range, path: string, lang: string | null): string {
	const lines: Array<string> = []
	let prev: number | null = null
	for (const row of rows) {
		const n = lineNo(row, r.side)
		if (row.t !== 'line' || n === null || n < r.start || n > r.end) continue
		if (prev !== null && n > prev + 1) lines.push('…')
		lines.push(row.line.text)
		prev = n
	}
	const longest = Math.max(0, ...lines.flatMap((l) => (l.match(/`+/g) ?? []).map((m) => m.length)))
	const fence = '`'.repeat(Math.max(3, longest + 1))
	return `${snippetLabel(r, path)}\n${fence}${lang ?? ''}\n${lines.join('\n')}\n${fence}\n`
}

/** Where a snippet is from: "src/a.ts:21-25", and "(before the change)" for removed code. */
export function snippetLabel(r: Range, path: string): string {
	return `${path}:${r.start === r.end ? r.start : `${r.start}-${r.end}`}${r.side === 'old' ? ' (before the change)' : ''}`
}

export function rangeLabel(r: { start: number; end: number }): string {
	return r.start === r.end ? `line ${r.start}` : `lines ${r.start}–${r.end}`
}
