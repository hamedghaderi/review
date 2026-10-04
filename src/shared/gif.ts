import type { GifResult } from './types.ts'

/** The Markdown inserted for a GIF. The title is reduced to plain words so it cannot break out of the image syntax. */
export function gifMarkdown(g: GifResult): string {
	const alt =
		g.title
			.replace(/[^\p{L}\p{N} .,'!?-]/gu, '')
			.trim()
			.slice(0, 60) || 'GIF'
	return `![GIF: ${alt}](${g.url})`
}

/**
 * A "/gif words" command that ends at the cursor, on the current line: "/gif" at the start of the text or after a
 * space, then a space. `query` is the words after it (empty shows trending GIFs).
 */
export function gifCommandAt(text: string, cursor: number): { start: number; end: number; query: string } | null {
	const before = text.slice(0, cursor)
	const m = /(^|\s)\/gif ([^\n]{0,50})$/.exec(before)
	if (!m) return null
	const start = m.index + m[1].length
	return { start, end: cursor, query: m[2].trim() }
}

/** Replaces `text[start, end)` with a GIF on a line of its own, and returns where the cursor goes. */
export function insertGif(text: string, start: number, end: number, markdown: string): { text: string; cursor: number } {
	const head = text.slice(0, start).replace(/[ \t]+$/, '')
	const tail = text.slice(end)
	const lead = head && !head.endsWith('\n') ? `${head}\n` : head
	const block = `${markdown}\n`
	const rest = tail.startsWith('\n') ? tail.slice(1) : tail
	return { text: lead + block + rest, cursor: lead.length + block.length }
}

/** A "/" that is being typed toward "/gif" ("/", "/g", "/gi", "/gif") at the cursor, to suggest the command. */
export function gifSlashAt(text: string, cursor: number): { start: number } | null {
	const m = /(^|\s)\/(g|gi|gif)?$/.exec(text.slice(0, cursor))
	return m ? { start: m.index + m[1].length } : null
}
