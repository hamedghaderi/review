import { Fragment, memo, useMemo } from 'react'
import { findHiddenChars } from '../../shared/hiddenChars.ts'
import { KINDS, pieces, splitFences, type LineTokens } from './syntax.ts'
import { useSyntax } from './useSyntax.ts'

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

/**
 * A fenced code block, coloured by the language it names, else as the file `path` it's about (an AI answer about a
 * line quotes that file's code without saying so).
 */
export function CodeBlock({ lines, lang, path }: { lines: Array<string>; lang: string | null; path: string | null }) {
	const tokens = useSyntax(path, lines, lang)
	return (
		<pre className="code-block">
			<code>
				{lines.map((l, i) => (
					<Fragment key={i}>
						<CodeText text={l} tokens={tokens?.[i] ?? null} fileStart={false} marks={false} />
						{i < lines.length - 1 ? '\n' : null}
					</Fragment>
				))}
			</code>
		</pre>
	)
}

/** An AI answer: its prose as written, its fenced code blocks coloured (see CodeBlock). */
export function AnswerText({ text, path }: { text: string; path: string | null }) {
	const parts = useMemo(() => splitFences(text), [text])
	if (!parts.some((p) => p.kind === 'code')) return <span className="selectable">{text}</span>
	return (
		<div className="selectable answer-text">
			{parts.map((p, i) =>
				p.kind === 'text' ? <Fragment key={i}>{p.text}</Fragment> : <CodeBlock key={i} lines={p.lines} lang={p.lang} path={path} />,
			)}
		</div>
	)
}
