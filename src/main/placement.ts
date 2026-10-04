import type { Anchor, Hunk, PublishPlacement } from '../shared/types.ts'

/**
 * Where a local comment can go on GitHub. GitHub accepts line comments only on lines of its own diff (changed lines
 * plus 3 lines of context), and a multi-line range must stay inside one hunk. `hunks` must come from a 3-line-context
 * diff of the same commits GitHub diffs, which for a pull request is merge-base..head. GitHub addresses both sides
 * of a renamed file by its new path.
 */
export function placeComment(a: Anchor, hunks: Array<Hunk> | null): PublishPlacement {
	const path = a.newPath ?? a.oldPath ?? a.fileKey
	if (a.side === null || a.startLine === null || a.endLine === null) return { kind: 'file', path }
	if (!hunks)
		return {
			kind: 'outside-diff',
			path,
			reason: 'There is no text diff for this file (binary or too large), so GitHub has no lines to attach it to.',
		}
	const side = a.side === 'old' ? 'LEFT' : 'RIGHT'
	for (const h of hunks) {
		const lines = new Set(h.lines.map((l) => (a.side === 'old' ? l.oldNo : l.newNo)))
		const hasStart = lines.has(a.startLine)
		const hasEnd = lines.has(a.endLine)
		if (hasStart && hasEnd) return { kind: 'line', path, side, line: a.endLine, startLine: a.startLine === a.endLine ? null : a.startLine }
		if (hasStart || hasEnd) return { kind: 'outside-diff', path, reason: 'Part of the selected range is outside the lines GitHub shows.' }
	}
	const which = a.startLine === a.endLine ? `Line ${a.startLine} is` : `Lines ${a.startLine}–${a.endLine} are`
	return { kind: 'outside-diff', path, reason: `${which} outside the lines GitHub shows (changes plus 3 lines of context).` }
}
