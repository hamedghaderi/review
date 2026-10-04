import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

interface Props {
	id: string // identifies the list content; scroll position is restored when it changes
	label: string
	count: number
	rowHeight: number
	active: number // index of the cursor row, -1 for none
	rowKey(i: number): string
	rowClass?(i: number): string
	renderRow(i: number): ReactNode
	onRowClick(i: number): void
	onRowDoubleClick?(i: number): void
	onMove(i: number): void
	onEnter(i: number): void
	onKey?(e: React.KeyboardEvent, i: number): boolean // return true when handled
	onEndReached?(): void
	initialScroll: number
	onScrollSettled(top: number): void
	empty?: ReactNode
	footer?: ReactNode
}

/**
 * Fixed-height virtualised listbox. The container holds focus and exposes the cursor row through
 * aria-activedescendant, so ↑/↓/Home/End/PageUp/PageDown work without moving DOM focus and Tab leaves the list.
 */
export function VirtualList(p: Props) {
	const ref = useRef<HTMLDivElement>(null)
	const [top, setTop] = useState(p.initialScroll)
	const [height, setHeight] = useState(400)
	const settle = useRef(0)
	// Desired scroll offset. Restored when the list becomes visible again (it is hidden, not unmounted, during a
	// review) and when asynchronously loaded rows first make it reachable.
	const want = useRef(p.initialScroll)
	const domId = `vl-${p.id.replace(/[^A-Za-z0-9_-]/g, '_')}`

	useLayoutEffect(() => {
		const el = ref.current
		if (!el) return
		want.current = p.initialScroll
		el.scrollTop = p.initialScroll
		setTop(el.scrollTop)
		const ro = new ResizeObserver(() => {
			if (!el.clientHeight) return
			setHeight(el.clientHeight)
			if (el.scrollTop !== want.current) el.scrollTop = want.current
		})
		ro.observe(el)
		return () => ro.disconnect()
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [p.id])

	// Keep the cursor row visible after keyboard moves or an external selection (quick open).
	useEffect(() => {
		const el = ref.current
		if (!el || p.active < 0 || !el.clientHeight) return
		const y = p.active * p.rowHeight
		if (y < el.scrollTop) el.scrollTop = y
		else if (y + p.rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = y + p.rowHeight - el.clientHeight
	}, [p.active, p.rowHeight])

	useLayoutEffect(() => {
		const el = ref.current
		if (el && el.clientHeight && el.scrollTop < want.current) el.scrollTop = want.current
	}, [p.count])

	// Short result lists may not fill the viewport, so there is nothing to scroll: ask for more right away.
	useEffect(() => {
		const el = ref.current
		if (el && p.onEndReached && el.clientHeight && p.count * p.rowHeight <= el.clientHeight) p.onEndReached()
	}, [p.count, p.rowHeight, p.onEndReached])

	const onScroll = (): void => {
		const el = ref.current!
		if (!el.clientHeight) return
		// Programmatic restores clamp to what is loaded; only user-visible scrolling updates the target.
		if (el.scrollTop < want.current && el.scrollTop + el.clientHeight >= el.scrollHeight - 1 && p.count * p.rowHeight < want.current) {
			setTop(el.scrollTop)
			return
		}
		want.current = el.scrollTop
		setTop(el.scrollTop)
		if (p.onEndReached && el.scrollTop + el.clientHeight > el.scrollHeight - p.rowHeight * 6) p.onEndReached()
		window.clearTimeout(settle.current)
		settle.current = window.setTimeout(() => p.onScrollSettled(el.scrollTop), 250)
	}

	const onKeyDown = (e: React.KeyboardEvent): void => {
		if (e.target !== e.currentTarget) return
		if (p.onKey?.(e, p.active)) return
		const page = Math.max(1, Math.floor(height / p.rowHeight) - 1)
		const go = (i: number): void => {
			e.preventDefault()
			if (p.count) p.onMove(Math.max(0, Math.min(p.count - 1, i)))
		}
		if (e.key === 'ArrowDown') go(p.active + 1)
		else if (e.key === 'ArrowUp') go(p.active < 0 ? 0 : p.active - 1)
		else if (e.key === 'Home') go(0)
		else if (e.key === 'End') go(p.count - 1)
		else if (e.key === 'PageDown') go(p.active + page)
		else if (e.key === 'PageUp') go(p.active - page)
		else if (e.key === 'Enter' && p.active >= 0) {
			e.preventDefault()
			p.onEnter(p.active)
		}
	}

	const overscan = 8
	const first = Math.max(0, Math.floor(top / p.rowHeight) - overscan)
	const last = Math.min(p.count, Math.ceil((top + height) / p.rowHeight) + overscan)
	const rows: Array<ReactNode> = []
	for (let i = first; i < last; i++) {
		rows.push(
			<div
				key={p.rowKey(i)}
				id={`${domId}-${i}`}
				role="option"
				aria-selected={i === p.active}
				className={`vrow ${i === p.active ? 'cursor' : ''} ${p.rowClass?.(i) ?? ''}`}
				style={{ top: i * p.rowHeight, height: p.rowHeight }}
				onClick={() => p.onRowClick(i)}
				onDoubleClick={p.onRowDoubleClick && (() => p.onRowDoubleClick!(i))}
			>
				{p.renderRow(i)}
			</div>,
		)
	}
	return (
		<div
			ref={ref}
			className="vlist"
			role="listbox"
			aria-label={p.label}
			tabIndex={0}
			aria-activedescendant={p.active >= 0 && p.active < p.count ? `${domId}-${p.active}` : undefined}
			onScroll={onScroll}
			onKeyDown={onKeyDown}
		>
			{p.count === 0 ? p.empty : <div style={{ height: p.count * p.rowHeight, position: 'relative' }}>{rows}</div>}
			{p.footer}
		</div>
	)
}
