import assert from 'node:assert/strict'
import test from 'node:test'
import { webUrl } from '../src/renderer/src/commentLinks.ts'

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

test('the host is checked as written, so Node and Chromium give the same answer', () => {
	// Node's parser accepts every one of these (it decodes `%41`, drops the tab), so webUrl turning them down shows the
	// check on the host as written runs, and that it refuses `%` and whitespace whatever a parser makes of them.
	for (const bad of ['-bad.example', 'bad-.example', 'a..b', '.example', 'ex"ample.com', 'exa%41mple.com', 'exa\tmple.com'])
		assert.equal(webUrl(`https://${bad}/`), null, JSON.stringify(bad))
	for (const ok of [
		'github.com',
		'a.b.example.',
		'xn--bcher-kva.example',
		'bücher.example',
		'my_host.example',
		'127.0.0.1',
		'[2001:db8::1]',
	])
		assert.notEqual(webUrl(`https://${ok}/`), null, ok)
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
	assert.notEqual(webUrl('https://example.com/badge%2dpassed.svg'), webUrl('https://example.com/badge%2Dpassed.svg'))
})
