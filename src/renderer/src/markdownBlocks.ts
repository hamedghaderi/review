import { Marked, type Token, type Tokens } from 'marked'
import type { Hunk } from '../../shared/types.ts'

/**
 * A Markdown file read as blocks (issue #258): each top-level block of the file (a paragraph, heading, list, table,
 * code block…) with the lines it came from and its HTML, so the rendered file can mark the blocks a change touched.
 * The HTML is unsafe as it stands (a file can hold raw HTML); RenderedMarkdown sanitises it before showing it.
 */

/** The lines a change touched in the new version of a file. */
export interface LineChanges {
	added: ReadonlySet<number> // lines the change added or rewrote
	cuts: ReadonlyArray<readonly [number, number]> // removed lines with nothing added in their place, between these two lines
}

export interface MdItem {
	start: number
	end: number
	changed: boolean
}

export interface MdBlock {
	start: number // first line, 1-based
	end: number // last line
	html: string
	changed: boolean
	items: Array<MdItem> | null // a list's own items, marked one by one; null for anything else
}

const MARKDOWN = /\.(md|markdown)$/i

export function isMarkdownPath(path: string | null): boolean {
	return !!path && MARKDOWN.test(path)
}

/** Where a change touched the new version, read from its hunks. */
export function changedLines(hunks: ReadonlyArray<Hunk>): LineChanges {
	const added = new Set<number>()
	const cuts: Array<[number, number]> = []
	for (const h of hunks) {
		let last = h.newStart - 1 // the new line before the current one
		let cutFrom: number | null = null // a run of removed lines started after this new line
		for (const l of h.lines) {
			if (l.kind === 'del') {
				if (cutFrom === null) cutFrom = last
				continue
			}
			if (l.newNo === null) continue
			if (l.kind === 'add') added.add(l.newNo)
			// Lines removed and others added in their place are a rewrite, marked by the added lines.
			else if (cutFrom !== null) cuts.push([cutFrom, l.newNo])
			cutFrom = null
			last = l.newNo
		}
		if (cutFrom !== null) cuts.push([cutFrom, cutFrom + 1])
	}
	return { added, cuts }
}

/**
 * Whether a change touched lines start–end: a line in it was added, or lines were removed from inside it (between two
 * of its own lines). Removing a whole paragraph touches neither neighbour.
 */
function touches(start: number, end: number, changes: LineChanges | null): boolean {
	if (!changes) return false
	for (let n = start; n <= end; n++) if (changes.added.has(n)) return true
	return changes.cuts.some(([a, b]) => a >= start && b <= end)
}

function lineCount(raw: string): number {
	return raw.split('\n').length - 1
}

/** The last line of a token's raw text that starts at `start`, leaving out the blank lines it ends with. */
function span(raw: string, start: number): number {
	return start + lineCount(raw.replace(/\n+$/, ''))
}

const marked = new Marked({ gfm: true })

/** The file's blocks, in order, with the lines each came from; blank lines between them are left out. */
export function markdownBlocks(text: string, changes: LineChanges | null): Array<MdBlock> {
	const tokens = marked.lexer(text.replace(/\r\n?/g, '\n'))
	const out: Array<MdBlock> = []
	let line = 1
	for (const t of tokens) {
		const start = line
		line += lineCount(t.raw)
		if (t.type === 'space') continue
		const end = span(t.raw, start)
		const one = Object.assign([t], { links: tokens.links }) as typeof tokens
		const html = marked.parser(one)
		if (!html.trim()) continue // a link definition, which shows nothing itself
		out.push({ start, end, html, changed: touches(start, end, changes), items: listItems(t, start, changes) })
	}
	return out
}

function listItems(t: Token, start: number, changes: LineChanges | null): Array<MdItem> | null {
	if (t.type !== 'list') return null
	let line = start
	return (t as Tokens.List).items.map((item) => {
		const s = line
		line += lineCount(item.raw)
		const e = span(item.raw, s)
		return { start: s, end: e, changed: touches(s, e, changes) }
	})
}
