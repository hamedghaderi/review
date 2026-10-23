import { Fragment, useEffect, useMemo, useState } from 'react'
import {
	defaultsFor,
	eventBinding,
	formatBinding,
	keyConflicts,
	KEY_ACTIONS,
	type KeyAction,
	type KeyGroup,
	type KeymapOverrides,
} from '../../shared/keymap.ts'
import { useKeymap } from './keymap.ts'
import { IS_MAC } from './SymbolNav.tsx'

const GROUPS: ReadonlyArray<KeyGroup> = ['General', 'Navigation', 'Findings', 'View']

/**
 * Settings › Keymap: every action that has a shortcut, with yours or the default. "Add" records the next key press;
 * a shortcut two actions share is marked on both. Changes apply at once, the menu's included.
 */
export function KeymapSettings() {
	const { overrides, keymap } = useKeymap()
	const [query, setQuery] = useState('')
	const [recording, setRecording] = useState<string | null>(null) // the action a new shortcut is being recorded for
	const conflicts = useMemo(() => keyConflicts(keymap), [keymap])
	const label = (id: string): string => KEY_ACTIONS.find((a) => a.id === id)?.label ?? id

	const save = (next: KeymapOverrides): void => void window.review.setKeymap(next)
	const setKeys = (a: KeyAction, keys: Array<string>): void => {
		const next = { ...overrides }
		const defaults = defaultsFor(a, IS_MAC)
		if (keys.length === defaults.length && keys.every((k, i) => k === defaults[i])) delete next[a.id]
		else next[a.id] = keys
		save(next)
	}

	// While recording, the next key press is the shortcut: it never reaches the rest of the app, and Escape cancels.
	useEffect(() => {
		if (!recording) return
		const action = KEY_ACTIONS.find((a) => a.id === recording)!
		void window.review.keymapRecording(true)
		const onKey = (e: KeyboardEvent): void => {
			e.preventDefault()
			e.stopImmediatePropagation()
			if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) return setRecording(null)
			const b = eventBinding(e, IS_MAC)
			if (!b) return // only modifiers so far
			const keys = keymap[action.id] ?? []
			if (!keys.includes(b)) setKeys(action, [...keys, b])
			setRecording(null)
		}
		const cancel = (): void => setRecording(null)
		window.addEventListener('keydown', onKey, true)
		window.addEventListener('blur', cancel)
		return () => {
			window.removeEventListener('keydown', onKey, true)
			window.removeEventListener('blur', cancel)
			void window.review.keymapRecording(false)
		}
	}, [recording]) // eslint-disable-line react-hooks/exhaustive-deps

	const q = query.trim().toLowerCase()
	const shown = KEY_ACTIONS.filter(
		(a) =>
			!q ||
			a.label.toLowerCase().includes(q) ||
			a.group.toLowerCase().includes(q) ||
			(keymap[a.id] ?? []).some((b) => formatBinding(b, IS_MAC).toLowerCase().includes(q)),
	)
	const changed = Object.keys(overrides).length > 0

	return (
		<div className="form keymap">
			<div className="keymap-head">
				<input
					type="search"
					className="keymap-search"
					placeholder="Search actions or shortcuts"
					aria-label="Search actions or shortcuts"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				<button className="btn small" disabled={!changed} onClick={() => save({})} title="Every action back to its default shortcut">
					Restore defaults
				</button>
			</div>
			<p className="muted small">
				Shortcuts without {IS_MAC ? '⌘, ⌃ or ⌥' : 'Ctrl or Alt'} don’t fire while you type. Keys inside text boxes and the quick open list (
				{IS_MAC ? '⌘↵' : 'Ctrl+Enter'} to send, Esc to close) stay as they are.
			</p>
			{shown.length === 0 && <p className="muted small">No action or shortcut matches “{query.trim()}”.</p>}
			<table className="keymap-table">
				<tbody>
					{GROUPS.map((g) => {
						const rows = shown.filter((a) => a.group === g)
						if (!rows.length) return null
						return (
							<Fragment key={g}>
								<tr>
									<th colSpan={3} className="keymap-group">
										{g}
									</th>
								</tr>
								{rows.map((a) => {
									const keys = keymap[a.id] ?? []
									const clashes = keys.flatMap((b) => (conflicts.get(b) ?? []).filter((id) => id !== a.id).map((id) => ({ b, id })))
									return (
										<tr key={a.id} className={clashes.length ? 'clash' : undefined}>
											<td className="keymap-action">
												<span>{a.label}</span>
												{a.note && <span className="muted small block">{a.note}</span>}
												{clashes.map((c) => (
													<span key={`${c.b}:${c.id}`} className="warn-text small block">
														{formatBinding(c.b, IS_MAC)} is also {label(c.id)}
													</span>
												))}
											</td>
											<td className="keymap-keys">
												{keys.map((b) => (
													<span key={b} className={`key-chip${conflicts.has(b) ? ' clash' : ''}`}>
														<kbd>{formatBinding(b, IS_MAC)}</kbd>
														<button
															className="key-remove"
															aria-label={`Remove ${formatBinding(b, IS_MAC)} from ${a.label}`}
															title="Remove"
															onClick={() =>
																setKeys(
																	a,
																	keys.filter((x) => x !== b),
																)
															}
														>
															×
														</button>
													</span>
												))}
												{recording === a.id ? (
													<span className="key-chip recording" role="status">
														Press keys… <span className="muted">Esc to cancel</span>
													</span>
												) : (
													<button
														className="btn small ghost"
														onClick={() => setRecording(a.id)}
														aria-label={`Add a shortcut for ${a.label}`}
													>
														+ Add
													</button>
												)}
												{!keys.length && recording !== a.id && <span className="muted small">None</span>}
											</td>
											<td className="keymap-reset">
												{a.id in overrides && (
													<button className="link small" onClick={() => setKeys(a, defaultsFor(a, IS_MAC))}>
														Reset
													</button>
												)}
											</td>
										</tr>
									)
								})}
							</Fragment>
						)
					})}
				</tbody>
			</table>
		</div>
	)
}
