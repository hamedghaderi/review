import { useEffect, useRef, useState } from 'react'
import type { PrGraphNode } from '../../shared/types.ts'
import type { StackGuide, StackMember } from '../../shared/prStack.ts'

const MARK = { 'needs-you': '●', reviewed: '✓' } as const
const MARK_TITLE = { 'needs-you': 'Needs your review', reviewed: 'You reviewed it; no new commits since' } as const

/** "2/6", for rows and pills: where a PR sits in its stack, counted from the bottom. */
export function stackPosition(g: StackGuide): string {
	return `${g.index + 1}/${g.members.length}`
}

/** Whether `number` is the PR to review next in its stack (and isn't the only one left to review there). */
export function isStackStart(g: StackGuide, number: number): boolean {
	return g.next?.node.number === number
}

/**
 * The whole stack in review order, bottom first, with your status on each PR and the one to review next marked.
 * `onPick` opens or selects a PR; the current one is shown, not linked.
 */
export function StackList({ guide, current, onPick }: { guide: StackGuide; current: number; onPick(n: PrGraphNode): void }) {
	return (
		<div className="stack-list">
			<div className="stack-list-head muted small">
				Review bottom up: each PR's changes build on the one below.{guide.base ? ` Merges into ${guide.base}.` : ''}
			</div>
			<ol>
				{guide.members.map((m, i) => (
					<StackItem
						key={m.node.number}
						m={m}
						i={i}
						// Where the stack forks, a PR doesn't sit on the one listed above it; say which it is on.
						on={m.parent !== null && m.parent !== guide.members[i - 1]?.node.number ? m.parent : null}
						current={m.node.number === current}
						next={guide.next === m}
						onPick={onPick}
					/>
				))}
			</ol>
		</div>
	)
}

function StackItem({
	m,
	i,
	on,
	current,
	next,
	onPick,
}: {
	m: StackMember
	i: number
	on: number | null
	current: boolean
	next: boolean
	onPick(n: PrGraphNode): void
}) {
	const body = (
		<>
			<span className="stack-n muted">{i + 1}</span>
			<span className="mono stack-num">#{m.node.number}</span>
			<span className="ellipsis stack-title">{m.node.title}</span>
			{on !== null && (
				<span className="muted small nowrap" title={`Stacked on #${on}, not on the PR listed above`}>
					on #{on}
				</span>
			)}
			{m.node.draft && <span className="pill small-pill">Draft</span>}
			{current && <span className="pill small-pill">This PR</span>}
			{next && <span className="pill small-pill stack-start">Start here</span>}
			{m.mine && (
				<span className={`stack-status ${m.mine}`} title={MARK_TITLE[m.mine]} aria-label={MARK_TITLE[m.mine]}>
					{MARK[m.mine]}
				</span>
			)}
		</>
	)
	return (
		<li className={`stack-item${current ? ' current' : ''}`}>
			{current ? (
				<div className="stack-row">{body}</div>
			) : (
				<button className="stack-row" title={`${m.node.title}\nOpen #${m.node.number}`} onClick={() => onPick(m.node)}>
					{body}
				</button>
			)}
		</li>
	)
}

/** The review header's stack control: "Stack 3/6" opening the ordered list, and a button to the PR to review next. */
export function StackControl({ guide, number, onOpen }: { guide: StackGuide; number: number; onOpen(n: number): void }) {
	// Where the list opens: under the button, moved left only as far as needed to stay in the window.
	const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)
	const ref = useRef<HTMLSpanElement>(null)
	const button = useRef<HTMLButtonElement>(null)
	const pop = useRef<HTMLDivElement>(null)
	const toggle = (): void => {
		if (pos) return setPos(null)
		const r = button.current!.getBoundingClientRect()
		const width = Math.min(560, window.innerWidth - 24)
		const top = r.bottom + 4
		setPos({ left: Math.max(12, Math.min(r.left, window.innerWidth - width - 12)), top, width, maxHeight: window.innerHeight - top - 12 })
	}
	useEffect(() => {
		if (!pos) return
		// A long stack scrolls; open it at this PR. Only the list scrolls: scrollIntoView would move the page too.
		const list = pop.current
		const here = list?.querySelector<HTMLElement>('.stack-item.current')
		if (list && here) list.scrollTop = Math.max(0, here.offsetTop - list.clientHeight / 2)
		const close = (e: Event): void => {
			if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setPos(null)
		}
		const reset = (): void => setPos(null)
		document.addEventListener('mousedown', close)
		document.addEventListener('keydown', close)
		window.addEventListener('resize', reset)
		return () => {
			document.removeEventListener('mousedown', close)
			document.removeEventListener('keydown', close)
			window.removeEventListener('resize', reset)
		}
	}, [pos])
	const next = guide.next && guide.next.node.number !== number ? guide.next : null
	const below = next ? guide.members.indexOf(next) < guide.index : false
	return (
		<span className="stack-control" ref={ref}>
			<button
				ref={button}
				className="pill small-pill stack-badge nowrap"
				aria-expanded={!!pos}
				onClick={toggle}
				title="This PR is part of a stack. Click to see the whole stack in review order."
			>
				Stack {stackPosition(guide)} ▾
			</button>
			{next && (
				<button
					className={`btn small ${below ? 'stack-first' : ''}`}
					onClick={() => onOpen(next.node.number)}
					title={`${next.node.title}\n${below ? 'A PR below this one still needs your review; it is easier to follow from the bottom up.' : 'The next PR in this stack that needs your review.'}`}
				>
					{below ? `Review #${next.node.number} first ↓` : `Next: #${next.node.number} →`}
				</button>
			)}
			{pos && (
				<div ref={pop} className="stack-popover" role="dialog" aria-label="Stack" style={pos}>
					<StackList
						guide={guide}
						current={number}
						onPick={(n) => {
							setPos(null)
							onOpen(n.number)
						}}
					/>
				</div>
			)}
		</span>
	)
}
