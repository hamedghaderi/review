import assert from 'node:assert/strict'
import test from 'node:test'
import { webUrl, withoutNotes } from '../src/renderer/src/commentLinks.ts'

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

test('withoutNotes: hides the HTML comments GitHub hides, keeps the ones it shows', () => {
	assert.equal(withoutNotes('<!-- coderabbit-ai-generated:v1 -->\n\nHello').trim(), 'Hello')
	assert.equal(withoutNotes('   <!-- three spaces is still a note -->\nShown'), 'Shown')
	assert.equal(withoutNotes('<!-- a note\nover lines -->\nAfter'), 'After')
	assert.equal(withoutNotes('<!-- note --> Hello\nWorld'), ' Hello\nWorld', 'text after the note on its line stays')
	assert.equal(withoutNotes('<!--> not closed by itself\nstill -->\nAfter'), 'After')

	const kept = [
		'Use `<!--` to start a comment',
		'Before <!-- inline --> after',
		'<!-- never closed\nWorld',
		'```html\n<!-- in a fence -->\n```',
		'~~~~\n```\n<!-- still in the outer fence -->\n~~~~',
		'Write:\n\n    <!-- indented code -->\n\nlike that',
		'\t<!-- tab-indented code -->',
	]
	for (const body of kept) assert.equal(withoutNotes(body), body, body)

	assert.equal(withoutNotes('```\n<!-- code -->\n```\n<!-- note -->\nEnd'), '```\n<!-- code -->\n```\nEnd', 'notes after a fence still go')
})
