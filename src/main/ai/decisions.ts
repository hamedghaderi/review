import type { DismissReason, PastDecision } from '../../shared/types.ts'
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
