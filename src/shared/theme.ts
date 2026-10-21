/**
 * The app's look: light or dark (or follow the system), and a colour theme. The colours themselves are in the
 * renderer's themes.css; this is what the main process and the renderer agree on.
 */
export type Appearance = 'system' | 'light' | 'dark'
export type ThemeId =
	'review' | 'github' | 'contrast' | 'warm' | 'laravel' | 'rails' | 'vue' | 'react' | 'django' | 'svelte' | 'rust' | 'go' | 'docker'

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
	{ id: 'laravel', label: 'Laravel', description: 'Laravel’s red on warm greys.', bg: { light: '#fdfdfc', dark: '#0a0a0a' } },
	{ id: 'rails', label: 'Rails', description: 'Rails red on cream, plum in the dark.', bg: { light: '#fbf7f4', dark: '#1b1418' } },
	{ id: 'vue', label: 'Vue', description: 'Vue’s green with its slate text.', bg: { light: '#ffffff', dark: '#1a1a1a' } },
	{ id: 'react', label: 'React', description: 'React’s cyan on the react.dev greys.', bg: { light: '#ffffff', dark: '#23272f' } },
	{ id: 'django', label: 'Django', description: 'Django’s deep green.', bg: { light: '#f7faf8', dark: '#092e20' } },
	{ id: 'svelte', label: 'Svelte', description: 'Svelte’s orange on neutral greys.', bg: { light: '#ffffff', dark: '#1b1b1f' } },
	{ id: 'rust', label: 'Rust', description: 'Rust orange on paper, like the Rust book.', bg: { light: '#f6f4ef', dark: '#1d1b19' } },
	{ id: 'go', label: 'Go', description: 'Go’s gopher blue.', bg: { light: '#ffffff', dark: '#202224' } },
	{ id: 'docker', label: 'Docker', description: 'Docker blue on navy.', bg: { light: '#ffffff', dark: '#0c1424' } },
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
