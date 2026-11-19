import type { SearchLine } from './diffModel.ts'

/**
 * Find in the open file (issue #241): ⌘F/Ctrl+F searches the code of the file on screen, the collapsed unchanged lines
 * included. Landing on a match in a collapsed line opens it. Matches are painted with the CSS Custom Highlight API, so
 * the code's own spans (syntax colours, hidden-character marks) are left as they are.
 */

export interface Match {
	key: string // the key of the line's row
	start: number // character offsets in the line
	end: number
	gapLine: number | null // the line is collapsed until this new line number is revealed
}

export const MAX_MATCHES = 5000 // past this the count reads "5000+" and the rest are not marked

/** Plain-text matches of `query` in `lines`, in reading order. Case is ignored unless `matchCase`. */
export function findMatches(
	lines: ReadonlyArray<SearchLine>,
	query: string,
	matchCase: boolean,
): { matches: Array<Match>; capped: boolean } {
	const matches: Array<Match> = []
	if (!query) return { matches, capped: false }
	const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'g' : 'gi')
	for (const l of lines) {
		re.lastIndex = 0
		for (let m = re.exec(l.text); m; m = re.exec(l.text)) {
			if (matches.length === MAX_MATCHES) return { matches, capped: true }
			matches.push({ key: l.key, start: m.index, end: m.index + m[0].length, gapLine: l.gapLine })
		}
	}
	return { matches, capped: false }
}

/** The first match at or after line `from` (an index into the searched lines), wrapping to the first; -1 for none. */
export function firstFrom(matches: ReadonlyArray<Match>, order: ReadonlyMap<string, number>, from: number): number {
	if (!matches.length) return -1
	const i = matches.findIndex((m) => (order.get(m.key) ?? 0) >= from)
	return i < 0 ? 0 : i
}

/** "3 of 12", "No results", or "1 of 5000+" when the search stopped counting. */
export function countLabel(at: number, total: number, capped: boolean): string {
	if (total === 0) return 'No results'
	return `${at >= 0 ? at + 1 : '–'} of ${total}${capped ? '+' : ''}`
}

/**
 * DOM ranges over the line's code element for each span (sorted by start) of its text. The "no newline at end of file"
 * mark is drawn text, not the line's, so it is skipped.
 */
export function textRanges(code: Element, spans: ReadonlyArray<{ start: number; end: number }>): Array<Range> {
	const nodes: Array<{ node: Text; at: number }> = []
	const walk = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
	let at = 0
	for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
		if (n.parentElement?.closest('.eol')) continue
		nodes.push({ node: n, at })
		at += n.length
	}
	const out: Array<Range> = []
	let j = 0
	// The text node holding offset `off`. A span's end at a node's last character stays in that node.
	const point = (off: number, end: boolean): { node: Text; offset: number } | null => {
		while (j < nodes.length && (end ? off > nodes[j].at + nodes[j].node.length : off >= nodes[j].at + nodes[j].node.length)) j++
		return j < nodes.length ? { node: nodes[j].node, offset: off - nodes[j].at } : null
	}
	for (const s of spans) {
		const a = point(s.start, false)
		const b = a && point(s.end, true)
		if (!a || !b) break
		const r = document.createRange()
		r.setStart(a.node, a.offset)
		r.setEnd(b.node, b.offset)
		out.push(r)
	}
	return out
}

/**
 * Scrolls `scroller` so the range is in view, like a browser's find: left alone when it already shows, else the line is
 * centred. `inset` is the width of the line numbers that stay put at the left while the code scrolls under them.
 */
export function scrollToRange(scroller: HTMLElement, r: Range, inset: number): void {
	const b = r.getBoundingClientRect()
	const s = scroller.getBoundingClientRect()
	const pad = 24
	if (b.top < s.top + pad || b.bottom > s.bottom - pad) scroller.scrollTop += b.top - s.top - (scroller.clientHeight - b.height) / 2
	if (b.left < s.left + inset || b.right > s.left + scroller.clientWidth) scroller.scrollLeft += b.left - s.left - inset - 3 * pad
}
