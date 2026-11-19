import assert from 'node:assert/strict'
import test from 'node:test'
import { srcsetUrls, webUrl } from '../src/renderer/src/commentLinks.ts'

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

test('the host: as written, no whitespace, % or control characters; parsed, a well-formed DNS name', () => {
	// Node's parser accepts every one of these (it decodes `%41`, drops the tab), so webUrl turning them down shows
	// both steps run. Whitespace and `%` are where Chromium and Node differ (see the Chromium test).
	for (const bad of ['-bad.example', 'bad-.example', 'a..b', '.example', 'ex"ample.com', 'exa%41mple.com', 'exa\tmple.com'])
		assert.equal(webUrl(`https://${bad}/`), null, JSON.stringify(bad))
	assert.equal(webUrl('https://l·l.cat/'), 'https://xn--ll-0ea.cat/', 'an international name checked in its ASCII form')
	assert.notEqual(webUrl('https://a.b.example./'), null, 'a trailing dot')
	assert.notEqual(webUrl('https://[2001:db8::1]/'), null)
	assert.notEqual(webUrl('https://github.com:8443/x'), null, 'a port')
	assert.equal(webUrl('https://github.com:x/'), null, 'not a port')
})

test('DNS limits: labels up to 63 characters, names up to 253', () => {
	const label = (n: number) => 'a'.repeat(n)
	assert.notEqual(webUrl(`https://${label(63)}.example/`), null)
	assert.equal(webUrl(`https://${label(64)}.example/`), null)
	const name = (total: number) => [label(63), label(63), label(63), label(total - 3 * 63 - 3)].join('.')
	assert.equal(name(253).length, 253)
	assert.notEqual(webUrl(`https://${name(253)}/`), null)
	assert.notEqual(webUrl(`https://${name(253)}./`), null, 'a trailing dot is not counted')
	assert.equal(webUrl(`https://${name(254)}/`), null)
})

test('webUrl keeps percent escapes as written, since a signed link can depend on them', () => {
	assert.equal(webUrl('https://example.com/a%2fb?sig=x%2b'), 'https://example.com/a%2fb?sig=x%2b')
	assert.equal(webUrl('https://example.com/badge%2dpassed.svg'), 'https://example.com/badge%2dpassed.svg')
	assert.equal(webUrl('https://example.com/badge%2Dpassed.svg'), 'https://example.com/badge%2Dpassed.svg')
	assert.equal(webUrl('https:///evil.example/'), null, 'no host where one is written; a parser would find one further on')
	assert.equal(webUrl('https://\\evil.example/'), null)
})

test('srcsetUrls: commas separate candidates, not the parts of an address', () => {
	assert.deepEqual(srcsetUrls('https://example.com/plots/a,b.png 2x'), ['https://example.com/plots/a,b.png'])
	assert.deepEqual(srcsetUrls('a.png 1x, b.png 2x'), ['a.png', 'b.png'])
	assert.deepEqual(srcsetUrls('a.png, b.png'), ['a.png', 'b.png'], 'commas ending an address end the candidate')
	assert.deepEqual(srcsetUrls('a.png,b.png 2x'), ['a.png,b.png'], 'no space: one address, as a browser reads it')
	assert.deepEqual(srcsetUrls('a,b.png 2x, c.png'), ['a,b.png', 'c.png'])
	assert.deepEqual(srcsetUrls(' ,, a.png 100w (x, y), b.png'), ['a.png', 'b.png'], 'a comma in parentheses is a descriptor’s')
	assert.deepEqual(srcsetUrls(''), [])
})
