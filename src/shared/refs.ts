/**
 * File references in a finding's text: `src/cart.ts:40`, `src/cart.ts:40-52` (or with an en dash), and a path with a
 * folder but no line. A bare file name needs a line (`cart.ts:40`), or every "node.js" would count. Whether a reference
 * points at a real file is for the caller to decide; this only finds the text.
 */
export interface FileRef {
	start: number // offsets in the text
	end: number
	path: string
	line: number | null
	endLine: number | null
}

// A path ends in a name with an extension that starts with a letter. It can't follow a letter, a dot, a slash or "@",
// so the path inside a URL, an email address or a longer name isn't matched.
const REF = /(?<![\w./@:-])((?:[\w@.-]+\/)*[\w@-][\w.@-]*\.[A-Za-z]\w*)(?::(\d+)(?:\s?[-–]\s?(\d+))?)?(?![\w/])/g

export function fileRefs(text: string): Array<FileRef> {
	const out: Array<FileRef> = []
	for (const m of text.matchAll(REF)) {
		const path = m[1].replace(/^\.\//, '')
		const line = m[2] ? Number(m[2]) : null
		if (line === null && !path.includes('/')) continue
		if (line === 0 || path.split('/').some((p) => p === '..' || p === '.')) continue
		const endLine = m[3] && line !== null && Number(m[3]) >= line ? Number(m[3]) : null
		out.push({ start: m.index, end: m.index + m[0].length, path, line, endLine })
	}
	return out
}
