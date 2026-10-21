import { useEffect, useRef, useState } from 'react'
import { DEFAULT_THEME, fontStack, parseTheme, type ThemeSettings } from '../../shared/theme.ts'

// The last choice, kept here too so the first frame already has it; the main process holds the real one.
const CACHE_KEY = 'theme'

function apply(t: ThemeSettings): void {
	const root = document.documentElement
	if (t.theme === DEFAULT_THEME.theme) delete root.dataset.theme
	else root.dataset.theme = t.theme
	root.style.setProperty('--mono', fontStack(t.codeFont, 'var(--mono-default)'))
	root.style.setProperty('--sans', fontStack(t.uiFont, 'var(--sans-default)'))
	root.style.setProperty('--code-size', `${t.codeSize}px`)
	root.style.setProperty('--code-line', `${Math.round((t.codeSize * 5) / 3)}px`) // 20px at the default 12px
	try {
		localStorage.setItem(CACHE_KEY, JSON.stringify(t))
	} catch {
		// Not cached; the next start shows the default colours until the main process answers.
	}
}

/** Applies the cached theme at once, then the stored one, and follows every later change (the View menu included). */
export function startTheme(): void {
	try {
		const cached = localStorage.getItem(CACHE_KEY)
		if (cached) apply(parseTheme(cached.startsWith('{') ? JSON.parse(cached) : { theme: cached }))
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

/** The current choice, for the Appearance settings; `update` saves a change in the main process, which applies it. */
export function useTheme(): [ThemeSettings | null, (patch: Partial<ThemeSettings>) => void] {
	const [theme, setTheme] = useState<ThemeSettings | null>(null)
	// The latest choice, so changes made close together (two font fields saving at once) each build on the one before.
	const latest = useRef<ThemeSettings | null>(null)
	useEffect(() => {
		const take = (t: ThemeSettings): void => {
			latest.current = t
			setTheme(t)
		}
		void window.review.theme().then((r) => r.ok && take(r.value))
		return window.review.onThemeChanged(take)
	}, [])
	const update = (patch: Partial<ThemeSettings>): void => {
		if (!latest.current) return
		const next = { ...latest.current, ...patch }
		latest.current = next
		setTheme(next)
		void window.review.setTheme(next)
	}
	return [theme, update]
}
