/**
 * Keyboard shortcuts: the actions that have one, their default keys, and your changes to them. The main process keeps
 * the changes (it puts the menu's shortcuts on the menu); the renderer matches key presses against the rest.
 *
 * A binding is written like "Mod+Shift+P": modifiers then one key, joined by "+". "Mod" is ⌘ on macOS and Ctrl
 * elsewhere; "Ctrl" is the Control key itself (the same as Mod outside macOS). Keys are lower-case characters ("p", "/",
 * "[") or names ("Enter", "ArrowLeft", "F5").
 */

export type KeyGroup = 'General' | 'Navigation' | 'Findings' | 'View'

export interface KeyAction {
	id: string
	label: string
	group: KeyGroup
	defaults: { mac: Array<string>; other: Array<string> }
	menu?: boolean // the menu owns it, so it works wherever focus is, even while typing
	note?: string
}

const same = (...keys: Array<string>) => ({ mac: keys, other: keys })

export const KEY_ACTIONS: ReadonlyArray<KeyAction> = [
	{ id: 'settings', label: 'Open settings', group: 'General', defaults: same('Mod+,') },
	{ id: 'quickOpen', label: 'Quick open', group: 'General', defaults: same('Mod+p'), note: 'Go to a pull request, branch or command.' },
	{ id: 'search', label: 'Focus search', group: 'General', defaults: same('/'), note: 'The search box on screen.' },
	{ id: 'sidebar', label: 'Toggle sidebar', group: 'General', defaults: same('Mod+b'), menu: true },
	{ id: 'home', label: 'Home', group: 'Navigation', defaults: same('Mod+0') },
	{ id: 'outcomes', label: 'Outcomes', group: 'Navigation', defaults: same() },
	...[1, 2, 3, 4, 5, 6, 7, 8].map((n): KeyAction => ({
		id: `repo${n}`,
		label: `Repository ${n}`,
		group: 'Navigation',
		defaults: same(`Mod+${n}`),
	})),
	{ id: 'repoLast', label: 'Last repository', group: 'Navigation', defaults: same('Mod+9') },
	{ id: 'back', label: 'Back', group: 'Navigation', defaults: { mac: ['Mod+['], other: ['Alt+ArrowLeft'] } },
	{ id: 'forward', label: 'Forward', group: 'Navigation', defaults: { mac: ['Mod+]'], other: ['Alt+ArrowRight'] } },
	{ id: 'findingNext', label: 'Next finding', group: 'Findings', defaults: same('j') },
	{ id: 'findingPrev', label: 'Previous finding', group: 'Findings', defaults: same('k') },
	{ id: 'findingAccept', label: 'Add finding to the review', group: 'Findings', defaults: same('a') },
	{ id: 'findingDismiss', label: 'Dismiss finding', group: 'Findings', defaults: same('d'), note: 'Then 1–4 picks the reason.' },
	{ id: 'zoomReset', label: 'Actual size', group: 'View', defaults: same('Mod+Shift+0'), menu: true },
	{ id: 'zoomIn', label: 'Zoom in', group: 'View', defaults: same('Mod+=', 'Mod+Shift+='), menu: true },
	{ id: 'zoomOut', label: 'Zoom out', group: 'View', defaults: same('Mod+-'), menu: true },
]

export type KeyActionId = string

/** Your changes: each changed action's whole list of bindings (empty: no shortcut). Unchanged actions are absent. */
export type KeymapOverrides = Record<KeyActionId, Array<string>>

/** Every action's bindings after your changes. */
export type Keymap = Record<KeyActionId, Array<string>>

const MODS = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const
const NAMED = new Set([
	'Enter',
	'Escape',
	'Tab',
	'Space',
	'Backspace',
	'Delete',
	'Insert',
	'Home',
	'End',
	'PageUp',
	'PageDown',
	'ArrowUp',
	'ArrowDown',
	'ArrowLeft',
	'ArrowRight',
	...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
])

/** The modifiers and key of a binding, or null when it isn't one. Outside macOS "Ctrl" is "Mod". */
export function parseBinding(b: string, mac: boolean): { mod: boolean; ctrl: boolean; alt: boolean; shift: boolean; key: string } | null {
	if (typeof b !== 'string' || !b) return null
	// The key may itself be "+" ("Mod++"), so split off the last part by hand.
	const at = b.length > 1 && b.endsWith('++') ? b.length - 1 : b.lastIndexOf('+') + 1
	const key = b.slice(at)
	const mods = at > 0 ? b.slice(0, at - 1).split('+') : []
	if (!key || !(key.length === 1 || NAMED.has(key)) || (key.length === 1 && /[A-Z]/.test(key))) return null
	if (mods.some((m) => !MODS.includes(m as (typeof MODS)[number])) || new Set(mods).size !== mods.length) return null
	const has = (m: string): boolean => mods.includes(m)
	return {
		mod: has('Mod') || (!mac && has('Ctrl')),
		ctrl: mac && has('Ctrl'),
		alt: has('Alt'),
		shift: has('Shift'),
		key,
	}
}

/** The binding in its usual form ("Mod+Shift+p"), so the same shortcut written two ways compares equal. */
export function normalizeBinding(b: string, mac: boolean): string | null {
	const p = parseBinding(b, mac)
	if (!p) return null
	return [p.mod && 'Mod', p.ctrl && 'Ctrl', p.alt && 'Alt', p.shift && 'Shift', p.key].filter(Boolean).join('+')
}

// Physical keys, for presses where Shift or Alt changes the character (Shift+/ is "?", Alt+[ is "“" on a Mac).
const CODE_KEYS: Record<string, string> = {
	Slash: '/',
	Backslash: '\\',
	BracketLeft: '[',
	BracketRight: ']',
	Comma: ',',
	Period: '.',
	Semicolon: ';',
	Quote: "'",
	Backquote: '`',
	Minus: '-',
	Equal: '=',
	Space: 'Space',
}

interface KeyLike {
	key: string
	code: string
	metaKey: boolean
	ctrlKey: boolean
	altKey: boolean
	shiftKey: boolean
}

/** The key of a press, as bindings write it; null for a modifier on its own. */
function pressedKey(e: KeyLike): string | null {
	if (['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn', 'OS'].includes(e.key)) return null
	const letter = /^Key([A-Z])$/.exec(e.code)
	if (letter) return letter[1].toLowerCase()
	const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code)
	if (digit) return digit[1]
	if ((e.shiftKey || e.altKey) && CODE_KEYS[e.code]) return CODE_KEYS[e.code]
	if (e.key === ' ') return 'Space'
	if (NAMED.has(e.key)) return e.key
	return e.key.length === 1 ? e.key.toLowerCase() : null
}

/** The binding a key press makes, for recording a new shortcut; null while only modifiers are held. */
export function eventBinding(e: KeyLike, mac: boolean): string | null {
	const key = pressedKey(e)
	if (!key) return null
	const mod = mac ? e.metaKey : e.ctrlKey
	const ctrl = mac && e.ctrlKey
	return [mod && 'Mod', ctrl && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+')
}

/** Whether a key press is this binding, modifiers exactly. */
export function matchesBinding(e: KeyLike, binding: string, mac: boolean): boolean {
	const made = eventBinding(e, mac)
	return made !== null && made === normalizeBinding(binding, mac)
}

const SYMBOLS: Record<string, string> = {
	Enter: '↵',
	Escape: 'Esc',
	Tab: '⇥',
	Space: 'Space',
	Backspace: '⌫',
	Delete: '⌦',
	ArrowUp: '↑',
	ArrowDown: '↓',
	ArrowLeft: '←',
	ArrowRight: '→',
	PageUp: 'PgUp',
	PageDown: 'PgDn',
}

/** How a binding reads: "⌘⇧P" on macOS, "Ctrl+Shift+P" elsewhere. */
export function formatBinding(b: string, mac: boolean): string {
	const p = parseBinding(b, mac)
	if (!p) return b
	const key = SYMBOLS[p.key] ?? (p.key.length === 1 ? p.key.toUpperCase() : p.key)
	if (mac) return `${p.ctrl ? '⌃' : ''}${p.alt ? '⌥' : ''}${p.shift ? '⇧' : ''}${p.mod ? '⌘' : ''}${key}`
	return [p.mod && 'Ctrl', p.alt && 'Alt', p.shift && 'Shift', key].filter(Boolean).join('+')
}

const ACCELERATOR_KEYS: Record<string, string> = {
	ArrowUp: 'Up',
	ArrowDown: 'Down',
	ArrowLeft: 'Left',
	ArrowRight: 'Right',
	Escape: 'Esc',
	'+': 'Plus',
}

/** The binding as an Electron menu accelerator ("CmdOrCtrl+Shift+P"). */
export function toAccelerator(b: string, mac: boolean): string | null {
	const p = parseBinding(b, mac)
	if (!p) return null
	const key = ACCELERATOR_KEYS[p.key] ?? (p.key.length === 1 ? p.key.toUpperCase() : p.key)
	return [p.mod && 'CmdOrCtrl', p.ctrl && 'Ctrl', p.alt && 'Alt', p.shift && 'Shift', key].filter(Boolean).join('+')
}

/** Stored changes, keeping only known actions and valid, distinct bindings. */
export function parseKeymap(raw: unknown, mac: boolean): KeymapOverrides {
	const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
	const out: KeymapOverrides = {}
	for (const a of KEY_ACTIONS) {
		const list = v[a.id]
		if (!Array.isArray(list)) continue
		const keys = list.map((b) => normalizeBinding(b as string, mac)).filter((b): b is string => !!b)
		out[a.id] = [...new Set(keys)]
	}
	return out
}

export function defaultsFor(a: KeyAction, mac: boolean): Array<string> {
	return (mac ? a.defaults.mac : a.defaults.other).map((b) => normalizeBinding(b, mac)!)
}

/** Every action's bindings: yours where you changed them, the defaults otherwise. */
export function resolveKeymap(overrides: KeymapOverrides, mac: boolean): Keymap {
	const out: Keymap = {}
	for (const a of KEY_ACTIONS) out[a.id] = overrides[a.id] ?? defaultsFor(a, mac)
	return out
}

/** For each binding used by more than one action, those actions. */
export function keyConflicts(keymap: Keymap): Map<string, Array<KeyActionId>> {
	const by = new Map<string, Array<KeyActionId>>()
	for (const a of KEY_ACTIONS) for (const b of keymap[a.id] ?? []) by.set(b, [...(by.get(b) ?? []), a.id])
	return new Map([...by].filter(([, ids]) => ids.length > 1))
}
