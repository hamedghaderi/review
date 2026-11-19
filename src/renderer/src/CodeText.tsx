import { memo, useMemo } from 'react'
import { findHiddenChars } from '../../shared/hiddenChars.ts'
import { KINDS, pieces, type LineTokens } from './syntax.ts'

/**
 * A line of code, coloured by its language when `tokens` are known (issue #237). With `marks`, hidden and
 * direction-changing characters are drawn as labelled boxes and look-alike letters are marked (issue #223). Each box is
 * an isolated inline block, so a bidi control inside it can't reorder the rest of the line; the character itself stays
 * in the text, so copying the line copies what is really there.
 */
export const CodeText = memo(function CodeText({
	text,
	tokens,
	fileStart,
	marks = true,
}: {
	text: string
	tokens: LineTokens | null
	fileStart: boolean
	marks?: boolean
}) {
	const found = useMemo(() => (marks ? findHiddenChars(text, fileStart) : []), [text, fileStart, marks])
	const parts = useMemo(() => (found.length || tokens ? pieces(text, tokens, found) : null), [text, tokens, found])
	if (!parts) return <>{text}</>
	return (
		<>
			{parts.map((p) => {
				const raw = text.slice(p.start, p.end)
				if (p.mark === null)
					return p.kind ? (
						<span key={p.start} className={`tk-${KINDS[p.kind]}`}>
							{raw}
						</span>
					) : (
						raw
					)
				const h = found[p.mark]
				return h.kind === 'lookalike' ? (
					<span key={p.start} className={`lookalike${h.warn ? ' warn' : ''}`} title={h.name}>
						{raw}
					</span>
				) : (
					<span
						key={p.start}
						className={`hidden-char${h.warn ? ' warn' : ''}`}
						data-label={h.label}
						title={h.name}
						role="img"
						aria-label={h.name}
					>
						<span className="hc-raw">{raw}</span>
					</span>
				)
			})}
		</>
	)
})
