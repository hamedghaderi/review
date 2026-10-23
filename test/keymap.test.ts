import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	eventBinding,
	formatBinding,
	keyConflicts,
	matchesBinding,
	normalizeBinding,
	parseKeymap,
	resolveKeymap,
	toAccelerator,
} from '../src/shared/keymap.ts'

const press = (key: string, code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
	key,
	code,
	metaKey: false,
	ctrlKey: false,
	altKey: false,
	shiftKey: false,
	...mods,
})

test('bindings: written in one form; Ctrl is Mod outside macOS; "+" can be the key; bad ones are rejected', () => {
	assert.equal(normalizeBinding('Shift+Mod+p', true), 'Mod+Shift+p')
	assert.equal(normalizeBinding('Ctrl+p', false), 'Mod+p')
	assert.equal(normalizeBinding('Ctrl+p', true), 'Ctrl+p', 'Control is its own key on a Mac')
	assert.equal(normalizeBinding('Mod++', true), 'Mod++')
	assert.equal(normalizeBinding('/', true), '/')
	for (const bad of ['', 'Mod+', 'Hyper+p', 'Mod+Mod+p', 'Mod+P', 'Mod+pp', 'Mod+Enterr'])
		assert.equal(normalizeBinding(bad, true), null, bad)
})

test('presses: by physical key where Shift or Alt changes the character, modifiers exactly', () => {
	assert.equal(eventBinding(press('p', 'KeyP', { metaKey: true }), true), 'Mod+p')
	assert.equal(eventBinding(press('P', 'KeyP', { ctrlKey: true, shiftKey: true }), false), 'Mod+Shift+p')
	assert.equal(eventBinding(press('?', 'Slash', { shiftKey: true }), true), 'Shift+/')
	assert.equal(eventBinding(press('“', 'BracketLeft', { altKey: true }), true), 'Alt+[')
	assert.equal(eventBinding(press('ArrowLeft', 'ArrowLeft', { altKey: true }), false), 'Alt+ArrowLeft')
	assert.equal(eventBinding(press('Meta', 'MetaLeft', { metaKey: true }), true), null, 'a modifier alone')
	assert.ok(matchesBinding(press('0', 'Digit0', { metaKey: true }), 'Mod+0', true))
	assert.ok(
		!matchesBinding(press('0', 'Digit0', { metaKey: true, shiftKey: true }), 'Mod+0', true),
		'an extra modifier is another shortcut',
	)
	assert.ok(!matchesBinding(press('j', 'KeyJ', { ctrlKey: true }), 'j', true))
})

test('shown as ⌘⇧P on a Mac and Ctrl+Shift+P elsewhere; menu accelerators for Electron', () => {
	assert.equal(formatBinding('Mod+Shift+p', true), '⇧⌘P')
	assert.equal(formatBinding('Mod+Shift+p', false), 'Ctrl+Shift+P')
	assert.equal(formatBinding('Alt+ArrowLeft', false), 'Alt+←')
	assert.equal(toAccelerator('Mod+b', true), 'CmdOrCtrl+B')
	assert.equal(toAccelerator('Mod+Shift+=', false), 'CmdOrCtrl+Shift+=')
	assert.equal(toAccelerator('Alt+ArrowLeft', false), 'Alt+Left')
})

test('keymap: your changes replace an action’s defaults, unknown actions and bad bindings are dropped, clashes are found', () => {
	const changes = parseKeymap({ home: ['Shift+Mod+h', 'Mod+h', 'nonsense'], outcomes: [], gone: ['Mod+x'], quickOpen: 'Mod+k' }, true)
	assert.deepEqual(changes, { home: ['Mod+Shift+h', 'Mod+h'], outcomes: [] })
	const map = resolveKeymap(changes, true)
	assert.deepEqual(map.home, ['Mod+Shift+h', 'Mod+h'])
	assert.deepEqual(map.settings, ['Mod+,'], 'unchanged: the default')
	assert.deepEqual(resolveKeymap({}, false).back, ['Alt+ArrowLeft'], 'per-platform defaults')
	assert.equal(keyConflicts(resolveKeymap({}, true)).size, 0, 'the defaults never clash')
	assert.deepEqual([...keyConflicts(resolveKeymap({ outcomes: ['Mod+p'] }, true))], [['Mod+p', ['quickOpen', 'outcomes']]])
})
