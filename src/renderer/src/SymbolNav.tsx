import { useEffect, useRef } from 'react'
import { IDENT, type Side, type SymbolHit, type SymbolKind, type SymbolLookup } from '../../shared/types.ts'

export const IS_MAC = /Mac/.test(navigator.platform)

/** ⌘ on macOS, Ctrl elsewhere (Ctrl-click is a right click on macOS). */
export function isMod(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
	return IS_MAC ? e.metaKey : e.ctrlKey
}

export interface SymbolRequest {
	name: string
	side: Side
	kind: SymbolKind
	x: number
	y: number
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
 * name under the pointer is underlined. `sideAt` says which commit a cell's code belongs to, null to ignore it.
 */
export function useSymbolLinks(
	ref: React.RefObject<HTMLElement | null>,
	sideAt: (el: Element) => Side | null,
	onLookup: (r: SymbolRequest) => void,
): void {
	const latest = useRef({ sideAt, onLookup })
	latest.current = { sideAt, onLookup }
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
			if (!s || !latest.current.sideAt(s.range.startContainer.parentElement!)) return clear()
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
			const side = s && latest.current.sideAt(s.range.startContainer.parentElement!)
			if (!s || !side) return
			e.preventDefault() // no text selection, so no comment draft
			clear()
			latest.current.onLookup({ name: s.name, side, kind: e.shiftKey ? 'uses' : 'definition', x: e.clientX, y: e.clientY })
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
	const style = { left: Math.max(8, Math.min(pop.x, window.innerWidth - 440)), top: Math.min(pop.y + 14, window.innerHeight - 200) }
	const findUses = pop.kind === 'definition' && (
		<button className="btn small" onClick={() => onFindUses({ ...pop, kind: 'uses' })}>
			Find uses
		</button>
	)
	let body: React.ReactNode
	if (pop.state === 'loading') body = <p className="muted small">Searching the {commit} commit…</p>
	else if (pop.state === 'error') body = <p className="small error-text">{pop.message}</p>
	else if (!pop.value.hits.length)
		body = (
			<p className="muted small">
				No {pop.kind === 'definition' ? 'definition' : 'uses'} of <code>{pop.name}</code> found in the {commit} commit.
			</p>
		)
	else {
		const hits = pop.value.hits
		const groups = new Map<string, Array<SymbolHit>>()
		for (const h of hits) groups.set(h.path, [...(groups.get(h.path) ?? []), h])
		const outside = hits.filter((h) => !h.inDiff).length
		body = (
			<>
				{pop.kind === 'uses' && (
					<p className="muted small">
						{hits.length}
						{pop.value.truncated ? '+' : ''} in {groups.size} file{groups.size === 1 ? '' : 's'}, {outside} outside this change.
					</p>
				)}
				<div className="symbol-hits">
					{[...groups].map(([path, list]) => (
						<div key={path} className="symbol-group">
							<div className="symbol-file mono small ellipsis" title={path}>
								{path}
								{list[0].fileKey && <span className="muted"> · changed file</span>}
							</div>
							{list.map((h) => (
								<button key={h.line} className={`symbol-hit ${h.inDiff ? 'in-diff' : ''}`} onClick={() => onPick(h, pop.side)}>
									<span className="muted mono">{h.line}</span>
									<span className="mono ellipsis">{h.text}</span>
									{h.inDiff && <span className="symbol-tag">{pop.side === 'old' ? 'removed' : 'changed'}</span>}
								</button>
							))}
						</div>
					))}
				</div>
				{pop.value.truncated && <p className="muted small">More matches are not listed.</p>}
			</>
		)
	}
	return (
		<div ref={ref} className="popover symbol-pop" role="dialog" aria-label={`${what} of ${pop.name}`} style={style}>
			<div className="popover-title">
				{what} of <code>{pop.name}</code> <span className="muted small">({commit})</span>
			</div>
			{body}
			<p className="muted small">A text match: a name can be a different thing with the same name.</p>
			{findUses && <div className="popover-actions">{findUses}</div>}
		</div>
	)
}
