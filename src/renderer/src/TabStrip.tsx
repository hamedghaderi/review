import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { scrollBehavior } from './motion.ts'

/**
 * A row of tabs that stays on one line. When the panel is too narrow for all of them it scrolls sideways, and an arrow
 * shows on each side that has tabs out of sight, so none of them can sit hidden past the edge. The selected tab is
 * scrolled into view, and a mouse wheel or a click and drag scrolls the row.
 */
export function TabStrip({ active, children }: { active: string; children: ReactNode }) {
	const ref = useRef<HTMLDivElement>(null)
	const [more, setMore] = useState({ left: false, right: false })

	const measure = (): void => {
		const el = ref.current
		if (!el) return
		const max = el.scrollWidth - el.clientWidth
		const left = el.scrollLeft > 1
		const right = el.scrollLeft < max - 1
		setMore((m) => (m.left === left && m.right === right ? m : { left, right }))
	}

	// Tabs come and go and their counts change width, so measure after every render as well as on resize and scroll.
	useLayoutEffect(measure)

	useEffect(() => {
		const el = ref.current
		if (!el) return
		const ro = new ResizeObserver(measure)
		ro.observe(el)
		const onWheel = (e: WheelEvent): void => {
			if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return
			e.preventDefault()
			el.scrollLeft += e.deltaY
		}
		// Click and drag scrolls the row. A press only becomes a drag once it moves a few pixels, so a plain click still
		// picks a tab, and the click that ends a drag is swallowed so it doesn't pick the tab under the pointer.
		let drag: { id: number; x: number; scroll: number; moved: boolean } | null = null
		const onDown = (e: PointerEvent): void => {
			if (e.button !== 0 || el.scrollWidth <= el.clientWidth) return
			drag = { id: e.pointerId, x: e.clientX, scroll: el.scrollLeft, moved: false }
		}
		const onMove = (e: PointerEvent): void => {
			if (!drag || e.pointerId !== drag.id) return
			const dx = e.clientX - drag.x
			if (!drag.moved) {
				if (Math.abs(dx) < DRAG_START) return
				drag.moved = true
				el.setPointerCapture(e.pointerId)
				el.classList.add('dragging')
			}
			el.scrollLeft = drag.scroll - dx
		}
		const onUp = (e: PointerEvent): void => {
			if (!drag || e.pointerId !== drag.id) return
			if (drag.moved) {
				el.classList.remove('dragging')
				const swallow = (c: MouseEvent): void => {
					c.stopPropagation()
					c.preventDefault()
				}
				el.addEventListener('click', swallow, { capture: true, once: true })
				// No click follows when the pointer was released outside the tab it went down on.
				setTimeout(() => el.removeEventListener('click', swallow, { capture: true }), 0)
			}
			drag = null
		}
		el.addEventListener('scroll', measure, { passive: true })
		el.addEventListener('wheel', onWheel, { passive: false })
		el.addEventListener('pointerdown', onDown)
		el.addEventListener('pointermove', onMove)
		el.addEventListener('pointerup', onUp)
		el.addEventListener('pointercancel', onUp)
		return () => {
			ro.disconnect()
			el.removeEventListener('scroll', measure)
			el.removeEventListener('wheel', onWheel)
			el.removeEventListener('pointerdown', onDown)
			el.removeEventListener('pointermove', onMove)
			el.removeEventListener('pointerup', onUp)
			el.removeEventListener('pointercancel', onUp)
		}
	}, [])

	useEffect(() => {
		ref.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
	}, [active])

	/**
	 * Brings the next tab that is out of sight on that side fully into view, clear of the arrow. Positions are worked
	 * out from the tabs' layout offsets with a pixel of slack: a tab that ends a fraction of a pixel under the arrow
	 * counts as in view, or the arrow would pick the same tab on every click and never move.
	 */
	const step = (dir: 1 | -1): void => {
		const el = ref.current
		if (!el) return
		const tabs = [...el.children] as Array<HTMLElement>
		const start = el.scrollLeft
		const end = start + el.clientWidth
		const next =
			dir > 0 ? tabs.find((t) => t.offsetLeft + t.offsetWidth > end - ARROW + 1) : tabs.findLast((t) => t.offsetLeft < start + ARROW - 1)
		if (!next) return
		const left = dir > 0 ? next.offsetLeft + next.offsetWidth - el.clientWidth + ARROW : next.offsetLeft - ARROW
		el.scrollTo({ left, behavior: scrollBehavior() })
	}

	return (
		<div className="panel-title tab-strip">
			<div ref={ref} className="tabs" role="tablist">
				{children}
			</div>
			{/* Mouse-only: keyboard focus already scrolls a tab into view. */}
			{more.left && (
				<button className="tab-more left" tabIndex={-1} aria-hidden onClick={() => step(-1)} title="More tabs">
					‹
				</button>
			)}
			{more.right && (
				<button className="tab-more right" tabIndex={-1} aria-hidden onClick={() => step(1)} title="More tabs">
					›
				</button>
			)}
		</div>
	)
}

/** Width the edge arrows cover; also the scroll padding in the stylesheet, so a revealed tab clears the arrow. */
const ARROW = 24
/** How far a press moves before it drags the row rather than clicking a tab. */
const DRAG_START = 4
