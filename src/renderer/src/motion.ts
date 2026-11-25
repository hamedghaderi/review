import { useSyncExternalStore } from 'react'

/**
 * Reduced motion (issue #219): follow the system, or reduce or keep motion whatever it says, from Settings ›
 * Accessibility. When motion is reduced the root gets `reduce-motion`, which stops every animation and transition in
 * the stylesheet, the AI mark rests as a plain R and scrolling jumps instead of gliding. Kept on this computer; the other
 * window follows a change through the storage event.
 */

export type MotionPref = 'system' | 'reduce' | 'full'

export const MOTION_PREFS: ReadonlyArray<MotionPref> = ['system', 'reduce', 'full']
export const MOTION_KEY = 'review.motion'
export const REDUCE_CLASS = 'reduce-motion'
const QUERY = '(prefers-reduced-motion: reduce)'

export function reducesMotion(pref: MotionPref, systemReduces: boolean): boolean {
	return pref === 'reduce' || (pref === 'system' && systemReduces)
}

export function motionPref(): MotionPref {
	try {
		const v = localStorage.getItem(MOTION_KEY) as MotionPref | null
		return v && MOTION_PREFS.includes(v) ? v : 'system'
	} catch {
		return 'system'
	}
}

let reduced = false
const listeners = new Set<() => void>()

function update(): void {
	const next = reducesMotion(motionPref(), typeof matchMedia === 'function' && matchMedia(QUERY).matches)
	if (typeof document !== 'undefined') document.documentElement.classList.toggle(REDUCE_CLASS, next)
	if (next === reduced) return
	reduced = next
	for (const l of listeners) l()
}

export function setMotionPref(pref: MotionPref): void {
	try {
		localStorage.setItem(MOTION_KEY, pref)
	} catch {
		// Not remembered; it still applies in this window until it closes.
	}
	update()
}

/** Applies the choice before the first frame, then follows the system setting and the other window's changes. */
export function startMotion(): void {
	update()
	matchMedia(QUERY).addEventListener('change', update)
	window.addEventListener('storage', (e) => {
		if (e.key === MOTION_KEY) update()
	})
}

export function useReducedMotion(): boolean {
	return useSyncExternalStore(
		(l) => {
			listeners.add(l)
			return () => listeners.delete(l)
		},
		() => reduced,
	)
}

/** For scrollIntoView: a jump when motion is reduced, else a glide. */
export function scrollBehavior(): ScrollBehavior {
	return reduced ? 'auto' : 'smooth'
}
