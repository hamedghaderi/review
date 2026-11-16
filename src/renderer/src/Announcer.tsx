import { useEffect, useRef } from 'react'
import { attachRegion } from './announce.ts'

/** The window's one live region for what the AI is doing and what it said (see announce.ts). Render it once, last. */
export function Announcer() {
	const ref = useRef<HTMLDivElement>(null)
	useEffect(() => {
		attachRegion(ref.current)
		return () => attachRegion(null)
	}, [])
	return <div ref={ref} className="sr-only" role="status" aria-live="polite" aria-atomic="true" />
}
