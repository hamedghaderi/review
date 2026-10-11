import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assetName, download, newerRelease } from '../src/main/update.ts'

const reply = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch
const URL_DMG = 'https://github.com/hamedghaderi/review/releases/download/v0.5.0/Review-mac-arm64.dmg'
const release = (assets: Array<unknown>) => reply({ tag_name: 'v0.5.0', assets })

test('newerRelease reports only a strictly newer release', async () => {
	assert.equal((await newerRelease('0.4.0', 'darwin', 'arm64', reply({ tag_name: 'v0.5.0' })))?.version, '0.5.0')
	assert.equal(await newerRelease('0.4.0', 'darwin', 'arm64', reply({ tag_name: 'v0.4.0' })), null)
	assert.equal(await newerRelease('0.4.0', 'darwin', 'arm64', reply({ tag_name: 'v0.3.9' })), null)
	assert.equal(await newerRelease('0.4.0', 'darwin', 'arm64', reply({ tag_name: 'nightly' })), null)
	assert.equal(await newerRelease('0.4.0', 'darwin', 'arm64', reply({}, false)), null)
	const offline = (async () => {
		throw new Error('offline')
	}) as unknown as typeof fetch
	assert.equal(await newerRelease('0.4.0', 'darwin', 'arm64', offline), null)
})

test('newerRelease picks this system’s installer, from GitHub downloads only', async () => {
	const dmg = { name: 'Review-mac-arm64.dmg', browser_download_url: URL_DMG, size: 10, digest: 'sha256:abc' }
	assert.deepEqual((await newerRelease('0.4.0', 'darwin', 'arm64', release([dmg])))?.asset, {
		name: 'Review-mac-arm64.dmg',
		url: URL_DMG,
		size: 10,
		sha256: 'abc',
	})
	assert.equal((await newerRelease('0.4.0', 'darwin', 'x64', release([dmg])))?.asset, null)
	const elsewhere = { ...dmg, browser_download_url: 'https://evil.example/Review-mac-arm64.dmg' }
	assert.equal((await newerRelease('0.4.0', 'darwin', 'arm64', release([elsewhere])))?.asset, null)
	assert.equal(assetName('win32', 'x64'), 'Review-windows-setup.exe')
	assert.equal(assetName('linux', 'x64'), 'Review-linux-x86_64.AppImage')
	assert.equal(assetName('linux', 'arm64'), null)
})

test('download keeps only a complete file with the right checksum', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'review-update-'))
	const bytes = Buffer.from('installer bytes')
	const serve = (async () => new Response(bytes)) as unknown as typeof fetch
	const sha256 = createHash('sha256').update(bytes).digest('hex')
	const asset = { name: 'x', url: URL_DMG, size: bytes.length, sha256 }

	const progress: Array<number> = []
	await download(asset, join(dir, 'ok'), (f) => progress.push(f), serve)
	assert.deepEqual(readFileSync(join(dir, 'ok')), bytes)
	assert.equal(progress.at(-1), 1)

	await assert.rejects(
		download({ ...asset, sha256: '0'.repeat(64) }, join(dir, 'bad'), () => {}, serve),
		/damaged/,
	)
	await assert.rejects(
		download({ ...asset, size: bytes.length + 5 }, join(dir, 'short'), () => {}, serve),
		/cut off/,
	)
	await assert.rejects(
		download({ ...asset, size: 3 }, join(dir, 'long'), () => {}, serve),
		/larger/,
	)
	for (const f of ['bad', 'short', 'long']) assert.ok(!existsSync(join(dir, f)) && !existsSync(join(dir, `${f}.part`)))
})
