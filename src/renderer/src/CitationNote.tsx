import type { CitationCheckResult } from '../../shared/types.ts'

/**
 * Under an AI text: the file:line references in it that point at no file, or past its end, at the head commit (issue
 * #289). Nothing shows while the check runs or when every reference was found; a found one isn't shown as proof the
 * text is right about it.
 */
export function CitationNote({ result }: { result: CitationCheckResult | undefined }) {
	if (!result?.broken.length) return null
	const n = result.broken.length
	return (
		<div className="citation-note small" role="note">
			<b>
				{n === 1 ? 'A reference' : `${n} references`} in this text {n === 1 ? 'points' : 'point'} at code that isn’t there at the head
				commit:
			</b>
			<ul>
				{result.broken.map((b) => (
					<li key={b.ref}>
						<code>{b.ref}</code> <span className="muted">{b.reason}</span>
					</li>
				))}
			</ul>
		</div>
	)
}
