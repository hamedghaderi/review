import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isReleaseMedia, ReleaseMedia } from '../src/main/releaseMedia.ts'

const IMG = 'https://github.com/user-attachments/assets/1b2c3d4e-0000-4000-8000-000000000000'
const VIDEO = 'https://github.com/user-attachments/assets/9f8e7d6c-0000-4000-8000-000000000000'

test('only files uploaded to GitHub for the releases count as release media', () => {
	assert.equal(isReleaseMedia(IMG), true)
	assert.equal(isReleaseMedia('https://github.com/hamedghaderi/review/assets/1/abc'), true)
	assert.equal(isReleaseMedia('https://user-images.githubusercontent.com/1/abc.png'), true)
	assert.equal(isReleaseMedia('http://github.com/user-attachments/assets/x'), false, 'not https')
	assert.equal(isReleaseMedia('https://github.com/someone/else/assets/1/abc'), false, 'another repository')
	assert.equal(isReleaseMedia('https://camo.githubusercontent.com/abc'), false, 'GitHub’s proxy for images from other sites')
	assert.equal(isReleaseMedia('https://evil.example/user-attachments/assets/x'), false)
	assert.equal(isReleaseMedia('https://user:pw@github.com/user-attachments/assets/x'), false)
	assert.equal(isReleaseMedia('not a url'), false)
})

test('the notes’ own images and videos are pointed at review-media; everything else is left alone', () => {
	const m = new ReleaseMedia()
	const html = [
		`<p><a href="${IMG}"><img src="${IMG}" alt="Sidebar"></a></p>`,
		`<video src="${VIDEO}?a=1&amp;b=2" controls="controls" muted></video>`,
		'<img src="https://camo.githubusercontent.com/x" alt="elsewhere">',
		`<p>Read <a href="${IMG}">the image</a> src="${IMG}"</p>`,
	].join('\n')
	const out = m.rewrite(html)
	const ids = [...out.matchAll(/review-media:\/\/media\/([0-9a-f]{32})/g)].map((x) => x[1])
	assert.equal(ids.length, 2, 'the image and the video, not the links or text')
	assert.ok(out.includes(`<a href="${IMG}">`), 'a link still goes to GitHub')
	assert.ok(out.includes('src="https://camo.githubusercontent.com/x"'), 'not ours: left for the window to show as a link')
	assert.ok(out.includes(`src="${IMG}"</p>`), 'text that looks like an attribute is not touched')
	assert.equal(new ReleaseMedia().rewrite(html), out, 'the same file gets the same id on every read')
})

test('review-media serves only known files, as images or videos, passing byte ranges through', async () => {
	const m = new ReleaseMedia()
	const id = /media\/([0-9a-f]{32})/.exec(m.rewrite(`<video src="${VIDEO}"></video>`))![1]
	const asked: Array<{ url: string; range: string | null }> = []
	let type = 'video/mp4'
	let fail = false
	const fetcher = (async (url: string, init?: RequestInit) => {
		if (fail) throw new Error('offline')
		asked.push({ url, range: new Headers(init?.headers).get('range') })
		return new Response('abc', {
			status: 206,
			headers: { 'content-type': type, 'content-range': 'bytes 0-2/10', 'set-cookie': 'x=1', 'accept-ranges': 'bytes' },
		})
	}) as unknown as typeof fetch
	const req = (path: string, range?: string) => new Request(`review-media://${path}`, { headers: range ? { Range: range } : {} })

	const res = await m.respond(req(`media/${id}`, 'bytes=0-2'), fetcher)
	assert.equal(res.status, 206)
	assert.deepEqual(asked, [{ url: VIDEO, range: 'bytes=0-2' }])
	assert.equal(res.headers.get('content-range'), 'bytes 0-2/10')
	assert.equal(res.headers.get('set-cookie'), null, 'only the headers a player needs')
	assert.equal(await res.text(), 'abc')

	assert.equal((await m.respond(req(`media/${'0'.repeat(32)}`), fetcher)).status, 404, 'not from the release notes')
	assert.equal((await m.respond(req(`other/${id}`), fetcher)).status, 404)
	assert.equal(asked.length, 1, 'refused without asking GitHub')
	type = 'text/html'
	assert.equal((await m.respond(req(`media/${id}`), fetcher)).status, 502, 'a page, not a file')
	fail = true
	assert.equal((await m.respond(req(`media/${id}`), fetcher)).status, 502)
})
