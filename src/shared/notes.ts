import type { ReviewerNote } from './types.ts'
import { CATEGORY_LABEL } from './findings.ts'

/**
 * Reviewer notes (issue #278): which files a note covers, and the note as Markdown to commit to `.review/`.
 *
 * A note's paths are globs from the repository root, as in .gitignore but simpler:
 * - `*` matches within one folder, `**` across folders, `?` one character;
 * - a pattern without a slash matches the file or folder name at any depth (`*.sql`, `migrations`);
 * - a pattern also covers everything under it when it names a folder (`src/errors` and `src/errors/` both do).
 */

/** The pattern as a regular expression over repository paths, or null when it is empty. */
export function pathPattern(glob: string): RegExp | null {
	let g = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
	if (!g) return null
	if (!g.includes('/')) g = `**/${g}`
	let re = ''
	for (let i = 0; i < g.length; i++) {
		const c = g[i]
		if (c === '*' && g[i + 1] === '*') {
			const slash = g[i + 2] === '/'
			re += slash ? '(?:.*/)?' : '.*'
			i += slash ? 2 : 1
		} else if (c === '*') re += '[^/]*'
		else if (c === '?') re += '[^/]'
		else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
	}
	return new RegExp(`^${re}(?:/.*)?$`)
}

/** True when the note covers this repository path: it has no paths, or one of them matches. */
export function noteCovers(note: Pick<ReviewerNote, 'paths'>, path: string): boolean {
	const patterns = note.paths.map(pathPattern).filter((p): p is RegExp => !!p)
	return !patterns.length || patterns.some((p) => p.test(path))
}

/** Where a note applies, in words: its rule and its paths. */
export function noteScope(note: Pick<ReviewerNote, 'rule' | 'paths'>): string {
	const rule = note.rule ? `${CATEGORY_LABEL[note.rule]} findings` : 'Any finding'
	return `${rule} in ${note.paths.length ? note.paths.join(', ') : 'the whole repository'}`
}

/** The notes that are on, as a Markdown file for the repository's `.review/` folder. */
export function notesMarkdown(notes: Array<ReviewerNote>): string {
	const on = notes.filter((n) => n.on)
	const lines = ['# Notes for the reviewer', '']
	for (const n of on) {
		lines.push(`## ${noteScope(n)}`, '', n.text.trim(), '')
	}
	return `${lines.join('\n').trimEnd()}\n`
}
