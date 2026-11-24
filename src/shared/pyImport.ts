import type { PyImportRef } from './types.ts'

const FROM = /^(\s*from\s+)(\.*)\s*([\w.]*)(\s+import\b)(.*)$/
const IMPORT = /^(\s*import\s+)(.*)$/
const NAME = /[A-Za-z_]\w*/g

/** The dotted parts of `dotted` (at `start` in the line) up to the one `offset` falls in, or null when it's in none. */
function partsUpTo(dotted: string, start: number, offset: number): Array<string> | null {
	let at = start
	const parts = dotted.split('.')
	for (let i = 0; i < parts.length; i++) {
		const end = at + parts[i].length
		if (parts[i] && offset >= at && offset <= end) return parts.slice(0, i + 1)
		at = end + 1
	}
	return null
}

/**
 * The module a ⌘/Ctrl-click in a Python import line points at (issue #287), or null when the click isn't on a module.
 * `offset` is where the clicked name starts in `text`. In `from a.b import c`, `a` and `b` are modules; `c` may be a
 * module of `a.b` or a name defined in it, so it comes back with `name: true`. An alias after `as` is neither. Only
 * the first line of an import is read: the names of `from x import (` on the lines after it are looked up by name.
 */
export function pythonImportAt(text: string, offset: number): PyImportRef | null {
	const code = text.replace(/\s+#.*$/, '')
	const from = FROM.exec(code)
	if (from) {
		const level = from[2].length
		// Measured from the end: the groups after the module are contiguous, the space before it may not be captured.
		const namesStart = code.length - from[5].length
		const modStart = namesStart - from[4].length - from[3].length
		const parts = from[3] ? partsUpTo(from[3], modStart, offset) : null
		if (parts) return { level, parts, name: false }
		if (offset < namesStart) return null
		let prev = ''
		for (const m of from[5].matchAll(NAME)) {
			const start = namesStart + m.index
			if (offset >= start && offset <= start + m[0].length) {
				if (prev === 'as' || m[0] === 'as') return null
				return { level, parts: [...(from[3] ? from[3].split('.') : []), m[0]], name: true }
			}
			prev = m[0]
		}
		return null
	}
	const imp = IMPORT.exec(code)
	if (!imp) return null
	let at = imp[1].length
	for (const item of imp[2].split(',')) {
		const lead = item.length - item.trimStart().length
		const dotted = /^[\w.]+/.exec(item.trimStart())?.[0] ?? ''
		const parts = dotted ? partsUpTo(dotted, at + lead, offset) : null
		if (parts) return { level: 0, parts, name: false }
		at += item.length + 1
	}
	return null
}
