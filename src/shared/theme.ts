/**
 * The app's look: light or dark (or follow the system), a colour theme, and fonts. The colours themselves are in the
 * renderer's themes.css; this is what the main process and the renderer agree on.
 */
export type Appearance = 'system' | 'light' | 'dark'
export type ThemeId =
	| 'review'
	| 'github'
	| 'contrast'
	| 'warm'
	| 'laravel'
	| 'rails'
	| 'vue'
	| 'react'
	| 'django'
	| 'svelte'
	| 'rust'
	| 'go'
	| 'docker'
	| 'material'

export interface ThemeSettings {
	appearance: Appearance
	theme: ThemeId
	codeFont: string // a font family name for code; '' for the default monospace fonts
	codeSize: number // px, for code in diffs and files
	uiFont: string // a font family name for everything else; '' for the system font
	uiScale: number // percent: the whole window's zoom, which View › Zoom changes too
}

export const DEFAULT_THEME: ThemeSettings = { appearance: 'system', theme: 'review', codeFont: '', codeSize: 12, uiFont: '', uiScale: 100 }

export const CODE_SIZES = { min: 10, max: 20 }
// The same steps as browser zoom, so View › Zoom In and Out move through these.
export const UI_SCALES: ReadonlyArray<number> = [80, 90, 100, 110, 125, 150]

// Suggestions only: any installed font can be typed in. A font that isn't installed falls back to the defaults.
export const CODE_FONTS: ReadonlyArray<string> = [
	'SF Mono',
	'Menlo',
	'JetBrains Mono',
	'Fira Code',
	'Cascadia Code',
	'Source Code Pro',
	'IBM Plex Mono',
	'Consolas',
]
export const UI_FONTS: ReadonlyArray<string> = ['Inter', 'Helvetica Neue', 'Segoe UI', 'Roboto', 'IBM Plex Sans', 'Open Sans']

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
	{
		id: 'material',
		label: 'Material',
		description: 'The Material Theme editor colours: teal on blue-grey, Lighter in light mode.',
		bg: { light: '#fafafa', dark: '#263238' },
	},
]

/** A stored or sent value, with anything unknown replaced by the default. */
export function parseTheme(raw: unknown): ThemeSettings {
	const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof ThemeSettings, unknown>>
	return {
		appearance: APPEARANCES.some((a) => a.id === v.appearance) ? (v.appearance as Appearance) : DEFAULT_THEME.appearance,
		theme: THEMES.some((t) => t.id === v.theme) ? (v.theme as ThemeId) : DEFAULT_THEME.theme,
		codeFont: fontName(v.codeFont),
		codeSize:
			typeof v.codeSize === 'number' && Number.isInteger(v.codeSize) && v.codeSize >= CODE_SIZES.min && v.codeSize <= CODE_SIZES.max
				? v.codeSize
				: DEFAULT_THEME.codeSize,
		uiFont: fontName(v.uiFont),
		uiScale: typeof v.uiScale === 'number' && UI_SCALES.includes(v.uiScale) ? v.uiScale : DEFAULT_THEME.uiScale,
	}
}

// A family name goes into CSS, so only letters, digits, spaces and a few marks are kept.
function fontName(raw: unknown): string {
	return typeof raw === 'string'
		? raw
				.replace(/[^\p{L}\p{N} ._-]/gu, '')
				.trim()
				.slice(0, 64)
		: ''
}

/** A CSS font-family list: the chosen font first, then the defaults for whatever it doesn't have. */
export function fontStack(name: string, fallback: string): string {
	return name ? `"${name}", ${fallback}` : fallback
}

/** The next step of the interface size for View › Zoom In or Out, staying at the ends. */
export function nextScale(current: number, dir: 1 | -1): number {
	const i = UI_SCALES.indexOf(current)
	const at = i === -1 ? UI_SCALES.indexOf(DEFAULT_THEME.uiScale) : i
	return UI_SCALES[Math.max(0, Math.min(UI_SCALES.length - 1, at + dir))]
}

export function themeBackground(s: ThemeSettings, systemDark: boolean): string {
	const t = THEMES.find((x) => x.id === s.theme) ?? THEMES[0]
	const dark = s.appearance === 'dark' || (s.appearance === 'system' && systemDark)
	return dark ? t.bg.dark : t.bg.light
}
