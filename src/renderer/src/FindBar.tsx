import { useEffect, useRef } from 'react'
import { keyLabel, useKeymap } from './keymap.ts'
import { IS_MAC } from './SymbolNav.tsx'

interface Props {
	query: string
	matchCase: boolean
	count: string // "3 of 12", "No results"
	focusNonce: number // focus and select the box each time this changes (⌘F again while it is open)
	onQuery(q: string): void
	onMatchCase(on: boolean): void
	onStep(dir: 1 | -1): void
	onClose(): void
}

/** The bar over the code for finding text in the open file (issue #241). Enter and Shift+Enter step, Escape closes. */
export function FindBar(p: Props) {
	useKeymap()
	const box = useRef<HTMLInputElement>(null)
	useEffect(() => {
		box.current?.focus()
		box.current?.select()
	}, [p.focusNonce])
	// The step buttons' tooltips name both ways to step: the shortcut, then the key in the box.
	const keys = (id: string, enter: string): string => [keyLabel(id), enter].filter(Boolean).join(', ')
	const next = keys('findNext', IS_MAC ? '↵' : 'Enter')
	const prev = keys('findPrev', IS_MAC ? '⇧↵' : 'Shift+Enter')
	return (
		<div className="find-bar" role="search" aria-label="Find in file">
			<input
				ref={box}
				type="search"
				value={p.query}
				placeholder="Find in file"
				aria-label="Find in file"
				aria-describedby="find-count"
				spellCheck={false}
				onChange={(e) => p.onQuery(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault()
						p.onStep(e.shiftKey ? -1 : 1)
					} else if (e.key === 'Escape') {
						e.preventDefault()
						e.stopPropagation()
						p.onClose()
					}
				}}
			/>
			<span id="find-count" className="find-count">
				{p.query ? p.count : ''}
			</span>
			<button
				className={`btn small ghost ${p.matchCase ? 'on' : ''}`}
				onClick={() => p.onMatchCase(!p.matchCase)}
				aria-pressed={p.matchCase}
				title="Match case"
			>
				Aa
			</button>
			<button className="btn small" onClick={() => p.onStep(-1)} title={`Previous match (${prev})`} aria-label="Previous match">
				↑
			</button>
			<button className="btn small" onClick={() => p.onStep(1)} title={`Next match (${next})`} aria-label="Next match">
				↓
			</button>
			<button className="btn small ghost" onClick={p.onClose} title="Close (Esc)" aria-label="Close find">
				✕
			</button>
		</div>
	)
}
