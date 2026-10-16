import type { DismissReason, EarlierLimitations, PastDecision } from '../../shared/types.ts'
import type { ContextFact, FileSource } from './context.ts'

/**
 * Findings the reviewer dismissed on earlier runs of the same pull request or branch, told to later runs with the
 * files they are about, so the model does not raise a rejected finding again under new words. They are the reviewer's
 * own decisions, so the prompt treats them like project context, not like repository text.
 */
export const REASON_TEXT: Record<DismissReason, string> = {
	wrong: 'wrong (the finding is incorrect)',
	'not-worth-it': 'not worth fixing',
	'handled-elsewhere': 'handled elsewhere',
	intended: 'intended (the code is meant to work this way)',
}

const MAX_PER_FILE = 10

export function decisionFacts(decisions: Array<PastDecision>, sources: Array<FileSource>): Array<ContextFact> {
	const out: Array<ContextFact> = []
	for (const { file } of sources) {
		const mine = decisions.filter((d) => d.path === file.newPath || d.path === file.oldPath).slice(0, MAX_PER_FILE)
		if (!mine.length) continue
		const lines = mine.map(
			(d) =>
				`- "${d.title}"${d.line === null ? '' : ` near line ${d.line} (in the version reviewed then)`}${d.category ? `, ${d.category}` : ''}: dismissed as ${d.reason ? REASON_TEXT[d.reason] : 'not useful (no reason given)'}${d.note ? `. Reviewer's note: "${d.note}"` : ''}`,
		)
		out.push({
			kind: 'decisions',
			title: `Findings the reviewer dismissed earlier on ${file.newPath ?? file.oldPath}`,
			text: lines.join('\n'),
			fileKeys: [file.key],
		})
	}
	return out
}

/**
 * What an earlier run of the same pull request or branch could not settle, told to the next run as leads to settle
 * first. A note goes with the files it names (by path, file name or class name), else with every request.
 */
export function earlierFacts(earlier: EarlierLimitations | null, sources: Array<FileSource>): Array<ContextFact> {
	if (!earlier?.items.length) return []
	const named = (text: string, path: string): boolean => {
		const file = path.slice(path.lastIndexOf('/') + 1)
		const stem = file.slice(0, file.indexOf('.') > 0 ? file.indexOf('.') : undefined)
		return text.includes(path) || text.includes(file) || (stem.length >= 4 && new RegExp(`\\b${escape(stem)}\\b`).test(text))
	}
	const byFiles = new Map<string, { keys: Array<string> | null; items: Array<string> }>()
	for (const item of earlier.items) {
		const keys = sources.filter(({ file }) => [file.newPath, file.oldPath].some((p) => p && named(item, p))).map((s) => s.file.key)
		const group = keys.length ? keys.join('\u0000') : ''
		const g = byFiles.get(group) ?? { keys: keys.length ? keys : null, items: [] }
		g.items.push(item)
		byFiles.set(group, g)
	}
	return [...byFiles.values()].map((g) => ({
		kind: 'earlier' as const,
		title: `Questions an earlier run could not settle (it reviewed commit ${earlier.headSha.slice(0, 7)})`,
		text: g.items.map((i) => `- ${i}`).join('\n'),
		fileKeys: g.keys,
	}))
}

function escape(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
