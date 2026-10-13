import { useState } from 'react'

/**
 * A choice kept in this browser across reviews and restarts (panel filters). Only values in `allowed` are read back,
 * so a renamed or removed option falls back to `initial`; nothing is remembered when storage is unavailable.
 */
export function useStored<T extends string>(key: string, initial: T, allowed: ReadonlyArray<T>): [T, (v: T) => void] {
	const [value, setValue] = useState<T>(() => {
		try {
			const v = localStorage.getItem(key) as T | null
			return v !== null && allowed.includes(v) ? v : initial
		} catch {
			return initial
		}
	})
	const set = (v: T): void => {
		setValue(v)
		try {
			localStorage.setItem(key, v)
		} catch {
			// Not remembered; the filter still applies now.
		}
	}
	return [value, set]
}
