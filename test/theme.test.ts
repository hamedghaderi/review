import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_THEME, fontStack, nextScale, parseTheme, themeBackground } from '../src/shared/theme.ts'
import { migrate, STORE_VERSION } from '../src/main/store.ts'

test('theme: a stored choice is read back, anything unknown falls back to the default', () => {
	assert.deepEqual(parseTheme({ appearance: 'dark', theme: 'warm' }), { ...DEFAULT_THEME, appearance: 'dark', theme: 'warm' })
	assert.deepEqual(parseTheme({ appearance: 'sepia', theme: 'warm' }), { ...DEFAULT_THEME, theme: 'warm' })
	assert.deepEqual(parseTheme({ appearance: 'light', theme: 'solarized' }), { ...DEFAULT_THEME, appearance: 'light' })
	assert.deepEqual(parseTheme(null), DEFAULT_THEME)
	assert.deepEqual(parseTheme('dark'), DEFAULT_THEME)
})

test('theme: fonts and sizes are kept when valid, and font names lose anything that could break out of CSS', () => {
	const t = parseTheme({ codeFont: 'JetBrains Mono', codeSize: 14, uiFont: 'Inter', uiScale: 125 })
	assert.deepEqual([t.codeFont, t.codeSize, t.uiFont, t.uiScale], ['JetBrains Mono', 14, 'Inter', 125])
	assert.equal(parseTheme({ codeFont: 'Fira"; } body { color: red' }).codeFont, 'Fira  body  color red')
	assert.equal(parseTheme({ codeFont: '  Menlo  ' }).codeFont, 'Menlo')
	assert.equal(parseTheme({ codeFont: 'x'.repeat(100) }).codeFont.length, 64)
	for (const codeSize of [9, 21, 12.5, '14']) assert.equal(parseTheme({ codeSize }).codeSize, 12)
	for (const uiScale of [95, 200, '110']) assert.equal(parseTheme({ uiScale }).uiScale, 100)
})

test('theme: a font goes in front of the defaults', () => {
	assert.equal(fontStack('Fira Code', 'var(--mono-default)'), '"Fira Code", var(--mono-default)')
	assert.equal(fontStack('', 'var(--mono-default)'), 'var(--mono-default)')
})

test('theme: zoom steps through the interface sizes and stops at the ends', () => {
	assert.equal(nextScale(100, 1), 110)
	assert.equal(nextScale(110, 1), 125)
	assert.equal(nextScale(100, -1), 90)
	assert.equal(nextScale(150, 1), 150)
	assert.equal(nextScale(80, -1), 80)
	assert.equal(nextScale(95, 1), 110) // not a step: from 100
})

test('theme: the window background follows the theme and light or dark, the system only when matching it', () => {
	assert.equal(themeBackground({ ...DEFAULT_THEME, theme: 'github' }, true), '#0d1117')
	assert.equal(themeBackground({ ...DEFAULT_THEME, theme: 'github' }, false), '#ffffff')
	assert.equal(themeBackground({ ...DEFAULT_THEME, appearance: 'light', theme: 'warm' }, true), '#fbf7f0')
	assert.equal(themeBackground({ ...DEFAULT_THEME, appearance: 'dark' }, false), '#18191f')
})

test('theme: the store keeps the choice, cleaned, and stays without one until it is made', () => {
	const base = { version: STORE_VERSION, lastRepoId: null, repos: {} }
	assert.equal('theme' in migrate(base), false)
	// A choice saved before fonts existed gets the default fonts.
	assert.deepEqual(migrate({ ...base, theme: { appearance: 'dark', theme: 'nope' } }).theme, { ...DEFAULT_THEME, appearance: 'dark' })
})
