/**
 * Moving between the window's panes with the keyboard (issue #218): the sidebar, the file list, the code and the side
 * panel, left to right, wrapping at the ends. Each pane is an element with `data-pane`, a name for screen readers and
 * tabIndex -1, so it can take focus and is announced by name. Hidden panes are skipped.
 */

/** Props that make an element a pane: spread them onto it. */
export function pane(name: string): { 'data-pane': string; 'aria-label': string; tabIndex: number } {
	return { 'data-pane': name, 'aria-label': name, tabIndex: -1 }
}

/** The index of the pane to move to from `at` (-1: focus is in none of them), wrapping at the ends. */
export function nextPane(count: number, at: number, dir: 1 | -1): number {
	if (count <= 0) return -1
	if (at < 0) return dir === 1 ? 0 : count - 1
	return (at + dir + count) % count
}

/** Moves focus to the next or previous visible pane; false when there is none to move to. */
export function cyclePane(dir: 1 | -1): boolean {
	const panes = [...document.querySelectorAll<HTMLElement>('[data-pane]')].filter((el) => el.getClientRects().length > 0)
	const at = panes.findIndex((el) => el.contains(document.activeElement))
	const to = panes[nextPane(panes.length, at, dir)]
	if (!to) return false
	to.focus()
	return true
}
