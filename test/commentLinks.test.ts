import assert from 'node:assert/strict'
import test from 'node:test'
import { sameAddress, webHost, webUrl } from '../src/renderer/src/commentLinks.ts'

test('webUrl: only http(s) addresses a browser can open, in the form that opens', () => {
	assert.equal(webUrl('https://github.com/o/r/pull/1'), 'https://github.com/o/r/pull/1')
	assert.equal(webUrl('HTTPS://GitHub.com/x'), 'https://github.com/x', 'what the title shows is what opens')
	assert.equal(webUrl('https://reports.example.com'), 'https://reports.example.com/')
	assert.equal(webUrl('  https://github.com/x  '), 'https://github.com/x')
	assert.equal(webUrl('https://github.com\\@evil.example/'), 'https://github.com/@evil.example/', 'a backslash is a slash')
	assert.equal(webUrl('https://xn--bcher-kva.example/'), 'https://xn--bcher-kva.example/')
	assert.equal(webUrl('https://bücher.example/'), 'https://xn--bcher-kva.example/', 'international names in their xn-- form')
	assert.equal(webUrl('http://127.0.0.1:8080/x'), 'http://127.0.0.1:8080/x')
	assert.equal(webUrl('http://[::1]/x'), 'http://[::1]/x')
	assert.equal(webUrl('https://my_host.example/'), 'https://my_host.example/')

	for (const bad of [
		null,
		undefined,
		'',
		'https://',
		'http://',
		'https:// ',
		'https://exa mple.com/',
		'https://exa%20mple.com/', // what Chromium turns the line above into
		'https://-bad.example/',
		'https://bad-.example/',
		'https://a..b/',
		'http://[::1',
		'https://github.com@evil.example/',
		'https://user:secret@github.com/',
		'https:github.com/x',
		'//github.com/x',
		'/o/r/pull/1',
		'#discussion_r1',
		'javascript:alert(1)',
		'mailto:someone@example.com',
		'review-media://media/0123456789abcdef0123456789abcdef',
	])
		assert.equal(webUrl(bad), null, String(bad))
})

test('webHost: the host check itself, which Node never reaches for hosts its own parser rejects', () => {
	for (const ok of ['github.com', 'a.b.example.', 'xn--bcher-kva.example', 'my_host.example', '127.0.0.1', '[::1]', '[2001:db8::1]'])
		assert.equal(webHost(ok), true, ok)
	// `exa%20mple.com` is what Chromium makes of `https://exa mple.com`; the others are hosts no browser opens.
	for (const bad of [
		'',
		'exa%20mple.com',
		'exa mple.com',
		'-bad.example',
		'bad-.example',
		'a..b',
		'.example',
		'ex"ample.com',
		'exa<mple.com',
	])
		assert.equal(webHost(bad), false, bad)
})

test('webUrl keeps percent escapes as written; sameAddress compares them in either case', () => {
	assert.equal(webUrl('https://example.com/a%2fb?sig=x%2b'), 'https://example.com/a%2fb?sig=x%2b', 'a signed link opens as written')
	assert.equal(sameAddress('https://example.com/badge%2dpassed.svg', 'https://example.com/badge%2Dpassed.svg'), true)
	assert.equal(sameAddress('https://example.com/a.svg', 'https://example.com/b.svg'), false)
	assert.equal(sameAddress(null, 'https://example.com/a.svg'), false)
	assert.equal(sameAddress(null, null), false, 'no address is never the same file')
})

test('webUrl: the checks after parsing hold with a parser as lenient as Chromium’s', () => {
	// Chromium turns `https://exa mple.com/` into the host `exa%20mple.com` instead of failing, as Node does.
	const chromiumLike = (s: string) =>
		/exa( |%20)mple/.test(s)
			? { protocol: 'https:', username: '', password: '', hostname: 'exa%20mple.com', href: 'https://exa%20mple.com/' }
			: new URL('https://from-the-stand-in.example/')
	assert.equal(webUrl('https://github.com/x', chromiumLike), 'https://from-the-stand-in.example/', 'the stand-in is what parses')
	assert.equal(webUrl('https://exa mple.com/', chromiumLike), null)
	assert.equal(webUrl('https://exa%20mple.com/', chromiumLike), null)
})
