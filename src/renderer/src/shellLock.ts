/**
 * The window itself never scrolls; only the panes inside it do. The page, #root and .app have no scrollbar
 * (`overflow: hidden`), but scrollIntoView() and focus() still scroll them when what they bring into view reaches past
 * the edge of the window. The whole app then shifts up, the top bar with Publish goes out of sight, and with no
 * scrollbar there is no way back short of reloading. Whenever one of them is scrolled, put it straight back.
 */
export function isShell(el: Element): boolean {
	return el === document.documentElement || el === document.body || el.id === 'root' || el.classList.contains('app')
}

export function lockShell(): void {
	window.addEventListener(
		'scroll',
		(e) => {
			// The page's own scroll is reported on the document; the others on the element that scrolled.
			const el = e.target === document ? document.scrollingElement : e.target
			if (!(el instanceof Element) || !isShell(el)) return
			if (el.scrollTop !== 0) el.scrollTop = 0
			if (el.scrollLeft !== 0) el.scrollLeft = 0
		},
		{ capture: true, passive: true },
	)
}
