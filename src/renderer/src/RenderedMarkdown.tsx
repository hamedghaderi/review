import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { markdownBlocks, type LineChanges } from './markdownBlocks.ts'
import { renderBlocks } from './markdownHtml.ts'
import { drawDiagrams } from './mermaidDiagrams.ts'
import { useStored } from './useStored.ts'

/**
 * A Markdown file shown rendered (issue #258), read-only. With `changes`, the blocks and list items the change touched
 * get a bar in the margin; clicking one shows those lines in the source. The file's HTML is sanitised as a GitHub
 * comment's is: no scripts, styles, forms or event handlers, links only to web addresses, and images as links, since
 * the window loads no remote media. Mermaid diagrams are drawn (mermaidDiagrams), in the theme's colours.
 */
export function RenderedMarkdown({
	text,
	changes,
	onShowSource,
}: {
	text: string
	changes: LineChanges | null
	onShowSource?(line: number): void
}) {
	const box = useRef<HTMLDivElement>(null)
	const blocks = useMemo(() => markdownBlocks(text, changes), [text, changes])
	const [bars, setBars] = useState<Array<Bar>>([])
	const diagrams = useMemo(() => blocks.some((b) => b.html.includes('class="language-mermaid"')), [blocks])
	const theme = useThemeVersion()

	useLayoutEffect(() => {
		const el = box.current
		if (!el) return
		el.replaceChildren(renderBlocks(blocks, document))
		const stop = drawDiagrams(el)
		const measure = (): void => {
			const top = el.getBoundingClientRect().top
			setBars(
				[...el.querySelectorAll<HTMLElement>('[data-changed]')].map((c) => {
					const r = c.getBoundingClientRect()
					return { top: r.top - top, height: r.height, start: Number(c.dataset.start), end: Number(c.dataset.end) }
				}),
			)
		}
		measure()
		const ro = new ResizeObserver(measure) // also as diagrams are drawn
		ro.observe(el)
		return () => {
			stop()
			ro.disconnect()
		}
	}, [blocks, diagrams ? theme : 0])

	if (!blocks.length) return <div className="state">This file is empty.</div>
	return (
		<div className="md-rendered">
			<div className="md-bars">
				{bars.map((b) => (
					<button
						key={`${b.start}-${b.end}`}
						className="md-bar"
						style={{ top: b.top, height: b.height }}
						onClick={onShowSource && (() => onShowSource(b.start))}
						disabled={!onShowSource}
						title={`Changed: ${b.start === b.end ? `line ${b.start}` : `lines ${b.start}–${b.end}`}. Click to show in the source.`}
						aria-label={`Changed ${b.start === b.end ? `line ${b.start}` : `lines ${b.start} to ${b.end}`}, show in the source`}
					/>
				))}
			</div>
			<div ref={box} className="md-body selectable" />
		</div>
	)
}

/** Changes whenever the app's colours or fonts may have: another theme, light and dark swapping, a font setting. */
function useThemeVersion(): number {
	const [version, setVersion] = useState(0)
	useEffect(() => {
		const bump = (): void => setVersion((n) => n + 1)
		const mo = new MutationObserver(bump)
		mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })
		const scheme = matchMedia('(prefers-color-scheme: dark)')
		scheme.addEventListener('change', bump)
		return () => {
			mo.disconnect()
			scheme.removeEventListener('change', bump)
		}
	}, [])
	return version
}

interface Bar {
	top: number
	height: number
	start: number
	end: number
}

export type MarkdownView = 'source' | 'rendered'

/**
 * Source or rendered. A file opens the way you last chose, kept on this computer (source until you first switch).
 * `choose` is that choice; `show` changes only this view, as a click on a changed block does to show its source.
 */
export function useMarkdownView(): { view: MarkdownView; choose(v: MarkdownView): void; show(v: MarkdownView): void } {
	const [stored, store] = useStored<MarkdownView>('review.markdownView', 'source', ['source', 'rendered'])
	const [view, setView] = useState(stored)
	return {
		view,
		choose: (v) => {
			setView(v)
			store(v)
		},
		show: setView,
	}
}

export function MarkdownSwitch({ view, onView }: { view: MarkdownView; onView(v: MarkdownView): void }) {
	return (
		<span className="seg md-switch" role="group" aria-label="Show the Markdown file as">
			{(['source', 'rendered'] as const).map((v) => (
				<button key={v} className={view === v ? 'on' : ''} aria-pressed={view === v} onClick={() => onView(v)}>
					{v === 'source' ? 'Source' : 'Rendered'}
				</button>
			))}
		</span>
	)
}
