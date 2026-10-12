import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FileLinesResult, Side } from '../../shared/types.ts'
import { useSymbolLinks, type SymbolRequest } from './SymbolNav.tsx'

export interface OutsideFile {
	path: string
	side: Side
	line: number | null // the line to show and mark
	scrollTop: number | null // restores an earlier place instead (back and forward)
	nonce: number
}

interface Props {
	comparisonId: string
	file: OutsideFile
	placeRef: React.RefObject<(() => number) | null> // reads the scroll position, for back and forward
	onLookup(r: SymbolRequest): void
}

/** A file the change doesn't touch, read-only, at the head commit (base for the old side). No comments here. */
export function FileView({ comparisonId, file, placeRef, onLookup }: Props) {
	const [lines, setLines] = useState<
		{ state: 'loading' } | { state: 'error'; message: string } | { state: 'done'; value: FileLinesResult }
	>({
		state: 'loading',
	})
	const scroller = useRef<HTMLDivElement>(null)
	placeRef.current = () => scroller.current?.scrollTop ?? 0
	useSymbolLinks(scroller, () => file.side, onLookup)

	useEffect(() => {
		let live = true
		setLines({ state: 'loading' })
		void window.review.loadFileAt(comparisonId, file.path, file.side).then((r) => {
			if (live) setLines(r.ok ? { state: 'done', value: r.value } : { state: 'error', message: r.error.message })
		})
		return () => {
			live = false
		}
	}, [comparisonId, file.path, file.side])

	useLayoutEffect(() => {
		const sc = scroller.current
		if (!sc || lines.state !== 'done') return
		if (file.scrollTop !== null) sc.scrollTop = file.scrollTop
		else if (file.line) sc.querySelector(`[data-line="${file.line}"]`)?.scrollIntoView({ block: 'center' })
	}, [lines, file.nonce]) // eslint-disable-line react-hooks/exhaustive-deps

	let body: React.ReactNode
	if (lines.state === 'loading') body = <div className="state">Loading file…</div>
	else if (lines.state === 'error') body = <div className="state error">Could not load this file: {lines.message}</div>
	else if (lines.value.kind === 'binary') body = <div className="state">Binary file. Its content is not shown.</div>
	else if (lines.value.kind === 'too-large') body = <div className="state">This file is too large to show: {lines.value.reason}.</div>
	else
		// ponytail: every line is rendered; virtualise if very large files make this slow
		body = (
			<div className="diff-table">
				{lines.value.lines.map((text, i) => (
					<div key={i} data-line={i + 1} className={`row line ctx ${i + 1 === file.line ? 'jump-target' : ''}`}>
						<span className="ln">{i + 1}</span>
						<span className="code">{text}</span>
					</div>
				))}
			</div>
		)

	return (
		<div className="diff">
			<div className="diff-head">
				<span className="status">read-only</span>
				<span className="mono ellipsis diff-path" title={file.path}>
					{file.path}
				</span>
				<span className="muted small">Not changed by this review · {file.side === 'old' ? 'base' : 'head'} commit</span>
			</div>
			<div className="diff-scroll" ref={scroller}>
				{body}
			</div>
		</div>
	)
}
