import { useEffect, useRef } from 'react'
import { IDENT, type Side, type SymbolHit, type SymbolKind, type SymbolLookup } from '../../shared/types.ts'

export const IS_MAC = /Mac/.test(navigator.platform)

/** ⌘ on macOS, Ctrl elsewhere (Ctrl-click is a right click on macOS). */
export function isMod(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
	return IS_MAC ? e.metaKey : e.ctrlKey
}

/** Where a name was clicked: the commit its code belongs to, and the file and line, to prefer nearby definitions. */
export interface SymbolOrigin {
	side: Side
	path: string | null
	line: number | null
}

export interface SymbolRequest {
	name: string
	side: Side
	kind: SymbolKind
	from: SymbolOrigin
	x: number
	y: number
}

/**
 * Definitions nearest the click first: the clicked file, then files sharing more of its folder. A name defined in the
 * same file is almost always the one meant, so a same-named function elsewhere doesn't win over it.
 */
export function byProximity(hits: Array<SymbolHit>, from: SymbolOrigin): Array<SymbolHit> {
	const dirs = (p: string): Array<string> => p.split('/').slice(0, -1)
	const here = from.path ? dirs(from.path) : []
	const shared = (p: string): number => {
		const d = dirs(p)
		let n = 0
		while (n < d.length && n < here.length && d[n] === here[n]) n++
		return n
	}
	const score = (h: SymbolHit): number => (h.path === from.path ? 1000 : shared(h.path))
	return [...hits].sort((a, b) => score(b) - score(a))
}

/** The identifier under a point in a `.code` cell, with its text range. */
function symbolAt(x: number, y: number): { name: string; range: Range } | null {
	const caret = document.caretRangeFromPoint(x, y)
	const node = caret?.startContainer
	if (!(node instanceof Text) || !node.parentElement?.closest('.code')) return null
	const at = caret!.startOffset
	for (const m of node.data.matchAll(IDENT)) {
		const start = m.index
		const end = start + m[0].length
		if (start > at) break
		if (at > end || /[\w$]/.test(node.data[start - 1] ?? '')) continue // not here, or the tail of a number like 0x1F
		const range = document.createRange()
		range.setStart(node, start)
		range.setEnd(node, end)
		const box = range.getBoundingClientRect()
		if (x < box.left || x > box.right || y < box.top || y > box.bottom) return null
		return { name: m[0], range }
	}
	return null
}

const LINK = 'symbol-link'

/**
 * ⌘/Ctrl-click a name in `.code` cells under `ref` to look it up (with Shift: its uses). While the key is held, the
 * name under the pointer is underlined. `originAt` says where a cell's code is (which commit, file and line), null to
 * ignore it.
 */
export function useSymbolLinks(
	ref: React.RefObject<HTMLElement | null>,
	originAt: (el: Element) => SymbolOrigin | null,
	onLookup: (r: SymbolRequest) => void,
): void {
	const latest = useRef({ originAt, onLookup })
	latest.current = { originAt, onLookup }
	useEffect(() => {
		const el = ref.current
		if (!el) return
		let pointer: { x: number; y: number } | null = null
		const clear = (): void => {
			CSS.highlights.delete(LINK)
			el.classList.remove('symbol-hover')
		}
		const show = (mod: boolean): void => {
			const s = mod && pointer ? symbolAt(pointer.x, pointer.y) : null
			if (!s || !latest.current.originAt(s.range.startContainer.parentElement!)) return clear()
			CSS.highlights.set(LINK, new Highlight(s.range))
			el.classList.add('symbol-hover')
		}
		const onMove = (e: MouseEvent): void => {
			pointer = { x: e.clientX, y: e.clientY }
			show(isMod(e))
		}
		const onLeave = (): void => {
			pointer = null
			clear()
		}
		const onKey = (e: KeyboardEvent): void => show(isMod(e))
		const onDown = (e: MouseEvent): void => {
			if (e.button !== 0 || !isMod(e)) return
			const s = symbolAt(e.clientX, e.clientY)
			const from = s && latest.current.originAt(s.range.startContainer.parentElement!)
			if (!s || !from) return
			e.preventDefault() // no text selection, so no comment draft
			clear()
			latest.current.onLookup({ name: s.name, side: from.side, kind: e.shiftKey ? 'uses' : 'definition', from, x: e.clientX, y: e.clientY })
		}
		el.addEventListener('mousemove', onMove)
		el.addEventListener('mouseleave', onLeave)
		el.addEventListener('mousedown', onDown)
		window.addEventListener('keydown', onKey)
		window.addEventListener('keyup', onKey)
		window.addEventListener('blur', clear)
		return () => {
			clear()
			el.removeEventListener('mousemove', onMove)
			el.removeEventListener('mouseleave', onLeave)
			el.removeEventListener('mousedown', onDown)
			window.removeEventListener('keydown', onKey)
			window.removeEventListener('keyup', onKey)
			window.removeEventListener('blur', clear)
		}
	}, [ref])
}

const POP_WIDTH = 520

export type SymbolPop = SymbolRequest &
	({ state: 'loading' } | { state: 'error'; message: string } | { state: 'done'; value: SymbolLookup })

interface PopoverProps {
	pop: SymbolPop
	onPick(hit: SymbolHit, side: Side): void
	onFindUses(r: SymbolRequest): void
	onClose(): void
}

/** Lookup results next to the click: definitions as a list, uses grouped by file with the lines this change touched marked. */
export function SymbolPopover({ pop, onPick, onFindUses, onClose }: PopoverProps) {
	const ref = useRef<HTMLDivElement>(null)
	useEffect(() => {
		const onDown = (e: MouseEvent): void => {
			if (!ref.current?.contains(e.target as Node) && !isMod(e)) onClose() // a ⌘/Ctrl-click starts the next lookup
		}
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === 'Escape') onClose()
		}
		window.addEventListener('mousedown', onDown)
		window.addEventListener('keydown', onKey)
		return () => {
			window.removeEventListener('mousedown', onDown)
			window.removeEventListener('keydown', onKey)
		}
	}, [onClose])
	useEffect(() => {
		ref.current?.querySelector<HTMLButtonElement>('button')?.focus()
	}, [pop.state])

	const commit = pop.side === 'old' ? 'base' : 'head'
	const what = pop.kind === 'definition' ? 'Definitions' : 'Uses'
	const width = Math.min(POP_WIDTH, window.innerWidth - 16)
	const style = {
		width,
		left: Math.max(8, Math.min(pop.x, window.innerWidth - width - 8)),
		top: Math.min(pop.y + 14, window.innerHeight - 220),
	}
	let meta = `Searching the ${commit} commit…`
	let body: React.ReactNode = null
	if (pop.state === 'error') {
		meta = `${commit} commit`
		body = <p className="symbol-state small error-text">{pop.message}</p>
	} else if (pop.state === 'done' && !pop.value.hits.length) {
		meta = `${commit} commit`
		body = (
			<p className="symbol-state muted small">
				No {pop.kind === 'definition' ? 'definition' : 'uses'} of <code>{pop.name}</code> found.
			</p>
		)
	} else if (pop.state === 'done') {
		const hits = pop.value.hits
		const groups = new Map<string, Array<SymbolHit>>()
		for (const h of hits) groups.set(h.path, [...(groups.get(h.path) ?? []), h])
		const outside = hits.filter((h) => !h.inDiff).length
		const count = `${hits.length}${pop.value.truncated ? '+' : ''}`
		const files = `${groups.size} file${groups.size === 1 ? '' : 's'}`
		meta =
			pop.kind === 'definition'
				? `${count} matches in ${files} · ${commit} commit`
				: `${count} in ${files} · ${outside ? `${outside} outside this change` : 'all in this change'} · ${commit} commit`
		body = (
			<div className="symbol-hits">
				{[...groups].map(([path, list]) => {
					const cut = path.lastIndexOf('/') + 1
					return (
						<div key={path} className="symbol-group">
							<div className="symbol-file small" title={path}>
								<span className="ellipsis">
									<span className="muted">{path.slice(0, cut)}</span>
									<strong>{path.slice(cut)}</strong>
								</span>
								{list[0].fileKey && <span className="symbol-chip">in this change</span>}
							</div>
							{list.map((h) => (
								<button key={h.line} className="symbol-hit" title={h.text} onClick={() => onPick(h, pop.side)}>
									<span className="symbol-ln">{h.line}</span>
									<span className="ellipsis">{h.text}</span>
									{h.inDiff && <span className="symbol-tag">{pop.side === 'old' ? 'removed' : 'changed'}</span>}
								</button>
							))}
						</div>
					)
				})}
				{pop.value.truncated && <p className="symbol-state muted small">More matches are not listed.</p>}
			</div>
		)
	}
	return (
		<div ref={ref} className="popover symbol-pop" role="dialog" aria-label={`${what} of ${pop.name}`} style={style}>
			<div className="symbol-head">
				<div className="popover-title ellipsis">
					{what} of <code>{pop.name}</code>
				</div>
				<div className="muted small">{meta}</div>
			</div>
			{body}
			<div className="symbol-foot">
				<span className="muted small">Matched by name, so a match can be a different thing with the same name.</span>
				{pop.kind === 'definition' && (
					<button className="btn small" onClick={() => onFindUses({ ...pop, kind: 'uses' })}>
						Find uses
					</button>
				)}
			</div>
		</div>
	)
}
