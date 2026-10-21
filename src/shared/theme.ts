/**
 * The app's look: light or dark (or follow the system), and a colour theme. The colours themselves are in the
 * renderer's themes.css; this is what the main process and the renderer agree on.
 */
export type Appearance = 'system' | 'light' | 'dark'
export type ThemeId = 'review' | 'github' | 'contrast' | 'warm'

export interface ThemeSettings {
	appearance: Appearance
	theme: ThemeId
}

export const DEFAULT_THEME: ThemeSettings = { appearance: 'system', theme: 'review' }

export const APPEARANCES: ReadonlyArray<{ id: Appearance; label: string }> = [
	{ id: 'system', label: 'Match system' },
	{ id: 'light', label: 'Light' },
	{ id: 'dark', label: 'Dark' },
]

// `bg` is each theme's background, which the window shows before the page has drawn.
export const THEMES: ReadonlyArray<{ id: ThemeId; label: string; description: string; bg: { light: string; dark: string } }> = [
	{ id: 'review', label: 'Review', description: 'The default, with a violet accent.', bg: { light: '#ffffff', dark: '#18191f' } },
	{
		id: 'github',
		label: 'GitHub',
		description: 'GitHub’s colours, so a diff looks the way it does there.',
		bg: { light: '#ffffff', dark: '#0d1117' },
	},
	{
		id: 'contrast',
		label: 'High contrast',
		description: 'Black and white with strong borders, for low vision or bright rooms.',
		bg: { light: '#ffffff', dark: '#000000' },
	},
	{
		id: 'warm',
		label: 'Warm',
		description: 'Paper tones that are easier on the eyes for long reviews.',
		bg: { light: '#fbf7f0', dark: '#1f1b16' },
	},
]

/** A stored or sent value, with anything unknown replaced by the default. */
export function parseTheme(raw: unknown): ThemeSettings {
	const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof ThemeSettings, unknown>>
	return {
		appearance: APPEARANCES.some((a) => a.id === v.appearance) ? (v.appearance as Appearance) : DEFAULT_THEME.appearance,
		theme: THEMES.some((t) => t.id === v.theme) ? (v.theme as ThemeId) : DEFAULT_THEME.theme,
	}
}

export function themeBackground(s: ThemeSettings, systemDark: boolean): string {
	const t = THEMES.find((x) => x.id === s.theme) ?? THEMES[0]
	const dark = s.appearance === 'dark' || (s.appearance === 'system' && systemDark)
	return dark ? t.bg.dark : t.bg.light
}
