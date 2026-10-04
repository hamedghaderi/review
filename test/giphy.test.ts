import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CredentialService, type SecretCipher } from '../src/main/ai/credentials.ts'
import { GiphyService } from '../src/main/giphy.ts'
import { gifMarkdown } from '../src/shared/gif.ts'

const KEY = 'abcdEFGH1234ijklMNOP5678'
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)])

function cipher(): SecretCipher {
	return {
		async isAsyncEncryptionAvailable() {
			return true
		},
		async encryptStringAsync(plain) {
			return Buffer.from(`ENC:${Buffer.from(plain).toString('hex')}`)
		},
		async decryptStringAsync(buf) {
			return { result: Buffer.from(buf.toString().slice(4), 'hex').toString(), shouldReEncrypt: false }
		},
		getSelectedStorageBackend: () => 'keychain',
	}
}

/** A fake GIPHY: answers the API and the media host, and records every URL the service asked for. */
function fakeGiphy(data: Array<unknown>, media: (url: string) => Response = () => new Response(GIF)) {
	const urls: Array<string> = []
	const fetch = async (url: string): Promise<Response> => {
		urls.push(url)
		if (url.startsWith('https://api.giphy.com/')) {
			if (!url.includes(`api_key=${KEY}`)) return new Response('{}', { status: 401 })
			return Response.json({ data })
		}
		return media(url)
	}
	return { fetch, urls }
}

async function service(f: ReturnType<typeof fakeGiphy>) {
	const dir = mkdtempSync(join(tmpdir(), 'review-gif-'))
	const store = new CredentialService(dir, cipher())
	await store.load()
	return { gif: new GiphyService(store, f.fetch), dir, store }
}

test('gifs: links are built from checked ids only, and every preview must really be a GIF', async () => {
	const f = fakeGiphy(
		[
			{ id: 'abc123XYZ', title: 'Party Time GIF by Someone' },
			{ id: '../../evil', title: 'path escape' },
			{ id: 'https://evil.example/x', title: 'other host' },
			{ id: 42, title: 'not a string' },
			{ id: 'notAGif99', title: 'html instead of a gif' },
		],
		(url) => (url.includes('notAGif99') ? new Response('<script>alert(1)</script>') : new Response(GIF)),
	)
	const { gif } = await service(f)
	await gif.setKey(KEY, true)
	const { results, next } = await gif.find('party')
	assert.equal(next, null) // fewer than a page
	assert.deepEqual(
		results.map((r) => [r.id, r.title, r.url]),
		[['abc123XYZ', 'Party Time', 'https://media.giphy.com/media/abc123XYZ/giphy-downsized.gif']],
	)
	assert.match(results[0].preview, /^data:image\/gif;base64,/)
	assert.ok(f.urls.every((u) => u.startsWith('https://api.giphy.com/') || u.startsWith('https://media.giphy.com/media/')))
	assert.ok(f.urls.some((u) => u.includes('q=party') && u.includes('rating=g')))
})

test('gifs: a wrong key is rejected before it is stored, and the key never appears in an error or in plain text', async () => {
	const f = fakeGiphy([])
	const { gif, dir } = await service(f)
	await assert.rejects(gif.find(''), /Add a GIPHY API key/)
	await assert.rejects(
		gif.setKey('wrongKEY1234wrongKEY', true),
		(e: Error) => /rejected the API key/.test(e.message) && !e.message.includes('wrongKEY'),
	)
	assert.equal(gif.status().key, 'none')
	await assert.rejects(gif.setKey('short', true), /16 to 64 letters and digits/)

	const offline = new GiphyService((await service(f)).store, async () => {
		throw new Error(`fetch failed for https://api.giphy.com/v1/gifs/trending?api_key=${KEY}`)
	})
	await assert.rejects(offline.setKey(KEY, true), (e: Error) => e.message === 'Could not reach GIPHY.')

	await gif.setKey(KEY, true)
	assert.equal(gif.status().key, 'saved')
	for (const name of readdirSync(dir))
		assert.ok(!readFileSync(join(dir, name), 'utf8').includes(KEY), `${name} holds the key in plain text`)
	assert.equal((await gif.removeKey()).key, 'none')
})

test('gifs: the inserted Markdown cannot break out of the image syntax', () => {
	const md = gifMarkdown({
		id: 'abc123XYZ',
		title: 'hi](javascript:alert(1)) <img src=x onerror=alert(1)>',
		preview: '',
		url: 'https://media.giphy.com/media/abc123XYZ/giphy-downsized.gif',
	})
	assert.equal(md, '![GIF: hijavascriptalert1 img srcx onerroralert1](https://media.giphy.com/media/abc123XYZ/giphy-downsized.gif)')
	assert.equal(
		gifMarkdown({ id: 'a1b2', title: '))]]', preview: '', url: 'https://media.giphy.com/media/a1b2/giphy-downsized.gif' }),
		'![GIF: GIF](https://media.giphy.com/media/a1b2/giphy-downsized.gif)',
	)
})

test('gif command: "/gif words" before the cursor opens a search; the pick replaces it on a line of its own', async () => {
	const { gifCommandAt, insertGif } = await import('../src/shared/gif.ts')
	assert.deepEqual(gifCommandAt('Looks good /gif ship it', 23), { start: 11, end: 23, query: 'ship it' })
	assert.deepEqual(gifCommandAt('/gif ', 5), { start: 0, end: 5, query: '' })
	assert.equal(gifCommandAt('/gif', 4), null) // needs the space
	assert.equal(gifCommandAt('see a/gif x', 11), null) // not after a word
	assert.equal(gifCommandAt('/gif party\nnext line', 20), null) // only on the current line
	assert.equal(gifCommandAt('@gif party', 10), null)

	const md = '![GIF: Ship It](https://media.giphy.com/media/a1b2/giphy-downsized.gif)'
	assert.deepEqual(insertGif('Looks good /gif ship it', 11, 23, md), { text: `Looks good\n${md}\n`, cursor: 11 + md.length + 1 })
	assert.deepEqual(insertGif('/gif x\nThanks', 0, 6, md), { text: `${md}\nThanks`, cursor: md.length + 1 })
})

test('gif command: typing "/" toward "/gif" suggests the command', async () => {
	const { gifSlashAt } = await import('../src/shared/gif.ts')
	assert.deepEqual(gifSlashAt('Nice /', 6), { start: 5 })
	assert.deepEqual(gifSlashAt('/gi', 3), { start: 0 })
	assert.equal(gifSlashAt('a/b', 3), null)
	assert.equal(gifSlashAt('/x', 2), null)
	assert.equal(gifSlashAt('src/', 4), null) // a path, not a command
})

test('gifs: pages continue with an offset, stop at the end or after the page limit, and reject odd offsets', async () => {
	const page = Array.from({ length: 18 }, (_, i) => ({ id: `gif${String(i).padStart(4, '0')}`, title: `G${i}` }))
	const urls: Array<string> = []
	const fetch = async (url: string): Promise<Response> => {
		urls.push(url)
		if (url.startsWith('https://api.giphy.com/')) return Response.json({ data: page, pagination: { total_count: 1000 } })
		return new Response(GIF)
	}
	const dir = mkdtempSync(join(tmpdir(), 'review-gif-'))
	const store = new CredentialService(dir, cipher())
	await store.load()
	const gif = new GiphyService(store, fetch)
	await gif.setKey(KEY, true)
	assert.equal((await gif.find('cat')).next, 18)
	assert.equal((await gif.find('cat', 18)).next, 36)
	assert.ok(urls.some((u) => u.includes('offset=18')))
	assert.equal((await gif.find('cat', 90)).next, null) // the sixth page is the last one
	await assert.rejects(gif.find('cat', 108), /Invalid GIF page/)
	await assert.rejects(gif.find('cat', 5), /Invalid GIF page/)
})
