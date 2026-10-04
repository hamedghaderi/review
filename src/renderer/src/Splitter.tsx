import { useState } from 'react'

/** Persisted panel width with a drag handle. `dir` is +1 when dragging right grows the panel. */
export function usePanelWidth(key: string, initial: number, min: number, max: number) {
	const [w, setW] = useState(() => {
		const v = Number(localStorage.getItem(key))
		return v >= min && v <= max ? v : initial
	})
	const start = (dir: 1 | -1) => (e: React.PointerEvent) => {
		e.preventDefault()
		const x0 = e.clientX
		const w0 = w
		let last = w0
		const move = (ev: PointerEvent): void => {
			last = Math.min(max, Math.max(min, w0 + dir * (ev.clientX - x0)))
			setW(last)
		}
		const up = (): void => {
			window.removeEventListener('pointermove', move)
			window.removeEventListener('pointerup', up)
			document.body.classList.remove('resizing')
			localStorage.setItem(key, String(last))
		}
		document.body.classList.add('resizing')
		window.addEventListener('pointermove', move)
		window.addEventListener('pointerup', up)
	}
	return { width: w, start }
}

export function Splitter({ onPointerDown }: { onPointerDown(e: React.PointerEvent): void }) {
	return <div className="splitter" role="separator" aria-orientation="vertical" onPointerDown={onPointerDown} />
}
