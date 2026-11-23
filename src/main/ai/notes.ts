import type { ReviewerNote } from '../../shared/types.ts'
import { noteCovers } from '../../shared/notes.ts'
import type { ContextFact, FileSource } from './context.ts'

/**
 * Your reviewer notes (issue #278), told to the reviewer with the changed files they cover. Each note sent gets a label
 * (N1, N2…) that means the same note in every request of the run, so a finding that says a note covers it names one.
 * Notes are your own decisions, so the prompt treats them like project context, not like repository text.
 */
export interface NoteFacts {
	facts: Array<ContextFact>
	labels: Map<string, ReviewerNote> // label → note, for every note sent
}

export function noteFacts(notes: Array<ReviewerNote>, sources: Array<FileSource>): NoteFacts {
	const labels = new Map<string, ReviewerNote>()
	const groups = new Map<string, { keys: Array<string> | null; lines: Array<string> }>()
	for (const note of notes) {
		if (!note.on || !note.text.trim()) continue
		const keys = note.paths.length
			? sources.filter(({ file }) => [file.newPath, file.oldPath].some((p) => p && noteCovers(note, p))).map((s) => s.file.key)
			: null
		if (keys && !keys.length) continue
		const label = `N${labels.size + 1}`
		labels.set(label, note)
		const where = note.paths.length ? `files ${note.paths.map((p) => `"${p}"`).join(', ')}` : 'the whole repository'
		const line = `- ${label} (rule ${note.rule ? `"${note.rule}"` : 'any'}; ${where}): ${note.text.trim().replace(/\s*\n\s*/g, ' ')}`
		const group = keys ? keys.join('\u0000') : ''
		const g = groups.get(group) ?? { keys, lines: [] }
		g.lines.push(line)
		groups.set(group, g)
	}
	const facts = [...groups.values()].map((g) => ({
		kind: 'notes' as const,
		title: 'Reviewer notes',
		text: g.lines.join('\n'),
		fileKeys: g.keys,
	}))
	return { facts, labels }
}

/** What the run's details say was sent. */
export function notesSummary(labels: Map<string, ReviewerNote>): string | null {
	if (!labels.size) return null
	const clip = (t: string): string => (t.length > 90 ? `${t.slice(0, 89).trimEnd()}…` : t)
	return `${labels.size} of your reviewer notes ${labels.size === 1 ? 'was' : 'were'} sent: ${[...labels.values()].map((n) => `“${clip(n.text.trim())}”`).join('; ')}`
}
