import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GitHubService, type TokenStore } from '../src/main/github.ts'
import { ReviewStore } from '../src/main/store.ts'
import { notificationPrefs, soundPrefs } from '../src/main/validate.ts'
import { DEFAULT_SOUNDS, SOUND_EVENTS, storedSounds } from '../src/shared/sounds.ts'

const ALL_OFF = Object.fromEntries(SOUND_EVENTS.map((e) => [e, 'off']))

test('stored sounds: defaults for new settings, all off when the old "Play a sound" switch was off, unknown values replaced', () => {
	assert.deepEqual(storedSounds(undefined), DEFAULT_SOUNDS)
	assert.deepEqual(storedSounds(undefined, true), DEFAULT_SOUNDS)
	assert.deepEqual(storedSounds(undefined, false), ALL_OFF)
	assert.deepEqual(storedSounds({ request: 'bell', commits: 'off', answer: 'kazoo' }, false), {
		...DEFAULT_SOUNDS,
		request: 'bell',
		commits: 'off',
	})
})

test('sounds from the window must name a known sound for each event; notification settings no longer carry them', () => {
	const sounds = { ...DEFAULT_SOUNDS, runFinished: 'off' }
	assert.deepEqual(soundPrefs(sounds), sounds)
	assert.throws(() => soundPrefs({ ...DEFAULT_SOUNDS, answer: '/tmp/x.wav' }))
	assert.throws(() => soundPrefs({ ...DEFAULT_SOUNDS, request: undefined }))
	assert.deepEqual(notificationPrefs({ enabled: false, sound: true }), { enabled: false })
})

test('sounds are an app setting that survives a restart', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'sounds-'))
	const store = ReviewStore.in(dir)
	await store.load()
	assert.equal(store.read().sounds, undefined, 'absent until you change one')
	await store.update((d) => void (d.sounds = { ...DEFAULT_SOUNDS, answer: 'off' }))
	await store.flush()
	const again = ReviewStore.in(dir)
	await again.load()
	assert.deepEqual(again.read().sounds, { ...DEFAULT_SOUNDS, answer: 'off' })
})

test('"Play a sound" turned off in the old GitHub settings is remembered, so sounds start off', async () => {
	const off = mkdtempSync(join(tmpdir(), 'gh-'))
	writeFileSync(join(off, 'github-settings.json'), JSON.stringify({ version: 1, notifications: { enabled: true, sound: false } }))
	const gh = new GitHubService(tokens(), { base: 'http://127.0.0.1:9', dir: off })
	await gh.load()
	assert.equal(gh.soundsWereOff, true)
	await gh.setNotifications({ enabled: false })
	await gh.flush()
	const reread = new GitHubService(tokens(), { base: 'http://127.0.0.1:9', dir: off })
	await reread.load()
	assert.equal(reread.soundsWereOff, true, 'still known after the notification settings are saved again')

	const fresh = new GitHubService(tokens(), { base: 'http://127.0.0.1:9', dir: mkdtempSync(join(tmpdir(), 'gh-')) })
	await fresh.load()
	assert.equal(fresh.soundsWereOff, false)
})

function tokens(): TokenStore {
	return {
		save: async () => 'saved',
		read: async () => ({ state: 'none' }),
		peek: () => 'none',
		remove: async () => {},
		storageInfo: () => ({ secure: true, backend: 'test', message: null }),
	}
}
