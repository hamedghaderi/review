import { describeHiddenChars, hiddenInHunks } from '../../shared/hiddenChars.ts'
import type { ContextFact, FileSource } from './context.ts'

/**
 * Hidden, direction-changing and look-alike characters on the lines a change adds (issue #223). The model reads code
 * points, but nothing in an excerpt says a character is there, and the person reading the finding sees the rendered
 * line. The reviewer is told what each one is and where, so it judges what the code does rather than how it looks.
 */
const MAX_PER_FILE = 10

export interface HiddenCharFacts {
	facts: Array<ContextFact>
	summary: string
}

export function hiddenCharFacts(sources: ReadonlyArray<FileSource>): HiddenCharFacts | null {
	const facts: Array<ContextFact> = []
	const all = []
	for (const s of sources) {
		if (s.patch.kind !== 'text') continue
		const path = s.file.newPath ?? s.file.key
		const lines = hiddenInHunks(s.file.key, path, s.patch.hunks)
		if (!lines.length) continue
		all.push(...lines.flatMap((l) => l.found))
		const shown = lines
			.slice(0, MAX_PER_FILE)
			.map((l) => `- line ${l.line}: ${l.found.map((h) => `${h.name} at column ${h.start + 1}`).join('; ')}`)
		const more = lines.length > MAX_PER_FILE ? [`- and ${lines.length - MAX_PER_FILE} more lines`] : []
		facts.push({
			kind: 'hidden',
			title: 'Hidden or look-alike characters this change adds',
			text: [
				`${path}:`,
				...shown,
				...more,
				'These change how the line looks without changing what it does. Read the line as the compiler would: which name is declared, where a comment or string really ends, what a hidden tag text says. A character that has no reason to be there is a problem whatever the line seems to do.',
			].join('\n'),
			fileKeys: [s.file.key],
		})
	}
	if (!facts.length) return null
	return {
		facts,
		summary: `${describeHiddenChars(all)} on added lines in ${facts.length} file${facts.length === 1 ? '' : 's'}; the reviewer was told where.`,
	}
}
