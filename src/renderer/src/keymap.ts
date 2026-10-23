import { useEffect, useState } from 'react'
import { formatBinding, matchesBinding, resolveKeymap, type Keymap, type KeymapOverrides } from '../../shared/keymap.ts'
import { IS_MAC } from './SymbolNav.tsx'

// The shortcuts in use: the defaults until the main process answers, then yours. Key handlers read it when a key is
// pressed, so a change applies at once without re-registering them.
let overrides: KeymapOverrides = {}
let current: Keymap = resolveKeymap({}, IS_MAC)
const listeners = new Set<() => void>()

function take(next: KeymapOverrides): void {
	overrides = next
	current = resolveKeymap(next, IS_MAC)
	for (const l of listeners) l()
}

/** Reads your shortcuts and follows every later change. */
export function startKeymap(): void {
	void window.review.keymap().then((r) => r.ok && take(r.value))
	window.review.onKeymapChanged(take)
}

/** Whether a key press is one of this action's shortcuts. */
export function isKey(e: KeyboardEvent, id: string): boolean {
	return (current[id] ?? []).some((b) => matchesBinding(e, b, IS_MAC))
}

/** The action's first shortcut as it reads on this platform ("⌘B", "Ctrl+B"); '' when it has none. */
export function keyLabel(id: string): string {
	const b = current[id]?.[0]
	return b ? formatBinding(b, IS_MAC) : ''
}

/** Re-renders when the shortcuts change, for labels that show them; returns your changes and every action's keys. */
export function useKeymap(): { overrides: KeymapOverrides; keymap: Keymap } {
	const [, bump] = useState(0)
	useEffect(() => {
		const l = (): void => bump((n) => n + 1)
		listeners.add(l)
		return () => void listeners.delete(l)
	}, [])
	return { overrides, keymap: current }
}
