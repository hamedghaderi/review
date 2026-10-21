import { useEffect, useState } from 'react'
import { DEFAULT_THEME, parseTheme, type ThemeSettings } from '../../shared/theme.ts'

// The last colour theme, kept here too so the first frame already has it; the main process holds the real choice.
const CACHE_KEY = 'theme'

function apply(t: ThemeSettings): void {
	if (t.theme === DEFAULT_THEME.theme) delete document.documentElement.dataset.theme
	else document.documentElement.dataset.theme = t.theme
	try {
		localStorage.setItem(CACHE_KEY, t.theme)
	} catch {
		// Not cached; the next start shows the default colours until the main process answers.
	}
}

/** Applies the cached theme at once, then the stored one, and follows every later change (the View menu included). */
export function startTheme(): void {
	try {
		const cached = localStorage.getItem(CACHE_KEY)
		if (cached) apply(parseTheme({ theme: cached }))
	} catch {
		// No cache to read.
	}
	void window.review.theme().then((r) => r.ok && apply(r.value))
	window.review.onThemeChanged(apply)
}

/** Changes part of the choice (from ⌘P), keeping the rest as stored. */
export async function changeTheme(patch: Partial<ThemeSettings>): Promise<void> {
	const r = await window.review.theme()
	if (r.ok) await window.review.setTheme({ ...r.value, ...patch })
}

/** The current choice, for the Appearance settings; `set` saves it in the main process, which applies it. */
export function useTheme(): [ThemeSettings | null, (next: ThemeSettings) => void] {
	const [theme, setTheme] = useState<ThemeSettings | null>(null)
	useEffect(() => {
		void window.review.theme().then((r) => r.ok && setTheme(r.value))
		return window.review.onThemeChanged(setTheme)
	}, [])
	// Shown at once, so a second click right after builds on this choice and not on the one before it.
	const set = (next: ThemeSettings): void => {
		setTheme(next)
		void window.review.setTheme(next)
	}
	return [theme, set]
}
