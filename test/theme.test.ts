import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_THEME, parseTheme, themeBackground } from '../src/shared/theme.ts'
import { migrate, STORE_VERSION } from '../src/main/store.ts'

test('theme: a stored choice is read back, anything unknown falls back to the default', () => {
	assert.deepEqual(parseTheme({ appearance: 'dark', theme: 'warm' }), { appearance: 'dark', theme: 'warm' })
	assert.deepEqual(parseTheme({ appearance: 'sepia', theme: 'warm' }), { appearance: 'system', theme: 'warm' })
	assert.deepEqual(parseTheme({ appearance: 'light', theme: 'solarized' }), { appearance: 'light', theme: 'review' })
	assert.deepEqual(parseTheme(null), DEFAULT_THEME)
	assert.deepEqual(parseTheme('dark'), DEFAULT_THEME)
})

test('theme: the window background follows the theme and light or dark, the system only when matching it', () => {
	assert.equal(themeBackground({ appearance: 'system', theme: 'github' }, true), '#0d1117')
	assert.equal(themeBackground({ appearance: 'system', theme: 'github' }, false), '#ffffff')
	assert.equal(themeBackground({ appearance: 'light', theme: 'warm' }, true), '#fbf7f0')
	assert.equal(themeBackground({ appearance: 'dark', theme: 'review' }, false), '#18191f')
})

test('theme: the store keeps the choice, cleaned, and stays without one until it is made', () => {
	const base = { version: STORE_VERSION, lastRepoId: null, repos: {} }
	assert.equal('theme' in migrate(base), false)
	assert.deepEqual(migrate({ ...base, theme: { appearance: 'dark', theme: 'nope' } }).theme, { appearance: 'dark', theme: 'review' })
})
