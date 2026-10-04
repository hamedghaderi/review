import { computeGaps, type Gap } from '../../shared/diff.ts'
import type { DiffLine, Hunk, Side } from '../../shared/types.ts'

export { computeGaps, type Gap }

export type Row =
	| { t: 'hunk'; key: string; hunk: Hunk }
	| { t: 'line'; key: string; line: DiffLine; block: number | null }
	| { t: 'gap'; key: string; from: number; to: number | null; offset: number; edge: 'top' | 'mid' | 'bottom' }

export interface Range {
	side: Side
	start: number
	end: number
}

/**
 * Builds rendered rows: gap i precedes hunk i, the last gap trails. Revealed gap lines become context rows,
 * remaining hidden runs become gap rows.
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

	const pushGap = (g: Gap, edge: 'top' | 'mid' | 'bottom'): void => {
		const to = g.to ?? (fileLines ? fileLines.length : null)
		if (to === null) {
			rows.push({ t: 'gap', key: `g${g.from}-`, from: g.from, to: null, offset: g.offset, edge })
			return
		}
		let runStart: number | null = null
		const flush = (end: number): void => {
			if (runStart === null) return
			rows.push({ t: 'gap', key: `g${runStart}-${end}`, from: runStart, to: end, offset: g.offset, edge })
			runStart = null
		}
		for (let n = g.from; n <= to; n++) {
			if (revealed.has(n) && fileLines && n <= fileLines.length) {
				flush(n - 1)
				rows.push({ t: 'line', key: `c${n}`, line: { kind: 'ctx', oldNo: n + g.offset, newNo: n, text: fileLines[n - 1] }, block: null })
			} else if (runStart === null) runStart = n
		}
		flush(to)
	}

	hunks.forEach((h, i) => {
		const g = gaps?.[i]
		if (g) pushGap(g, i === 0 ? 'top' : 'mid')
		rows.push({ t: 'hunk', key: `h${h.oldStart},${h.newStart}`, hunk: h })
		inBlock = false
		h.lines.forEach((line, j) => {
			const changed = line.kind !== 'ctx'
			if (changed && !inBlock) blocks.push(rows.length)
			inBlock = changed
			rows.push({ t: 'line', key: `l${h.oldStart},${h.newStart},${j}`, line, block: changed ? blocks.length - 1 : null })
		})
	})
	const tail = gaps?.[hunks.length]
	if (tail) pushGap(tail, hunks.length === 0 ? 'top' : 'bottom')
	return { rows, blocks }
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

export function rangeLabel(r: { start: number; end: number }): string {
	return r.start === r.end ? `line ${r.start}` : `lines ${r.start}–${r.end}`
}
