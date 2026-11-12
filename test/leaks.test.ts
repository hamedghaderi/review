import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeLeaks, findLeaks, maskLeaks } from '../src/shared/leaks.ts'
import { publicRepo, screenFinding } from '../src/shared/screen.ts'
import type { Finding } from '../src/shared/types.ts'

// Random strings in the shape of real ones; none of them is a real credential.
const GITHUB = 'ghp_' + 'Q7c2Lk9vWm4Zt8RbN1xPq6Hs3Df5Gj0YaE2u'
const AWS = 'AKIA' + 'Z7Q3LKM2VW4XT8RB'
const AI = 'sk-ant-' + 'api03-Hq8Lm2Zx7Vt4Rb9Nk1Pw6Jc3Ds5Fg0Ya'

test('keys and tokens in the shapes providers use are found, wherever they sit in the text', () => {
	const text = `Remove the key: \`const token = '${GITHUB}'\` and the AWS one ${AWS}.\n\n\`\`\`\nANTHROPIC=${AI}\n\`\`\``
	assert.deepEqual(
		findLeaks(text).map((l) => [l.kind, l.what]),
		[
			['credential', 'a GitHub token'],
			['credential', 'an AWS access key'],
			['credential', 'an AI provider key'],
		],
	)
	assert.ok(findLeaks('-----BEGIN RSA PRIVATE KEY-----\nMIIE…').some((l) => l.what === 'a private key'))
	assert.equal(findLeaks('const apiKey = "Zq7Lm2Vx9Tb4Rk8N"')[0]?.what, 'a password or secret value')
})

test('fake-looking values, plain words and CI paths are not leaks', () => {
	assert.deepEqual(findLeaks('const token = "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"'), [])
	assert.deepEqual(findLeaks('password: "your_password_here"'), [])
	assert.deepEqual(findLeaks('password = "password"'), [], 'too short and not random')
	assert.deepEqual(findLeaks('const apiKey = "aaaaaaaaaaaaaaaa"'), [])
	assert.deepEqual(findLeaks('Error at /home/runner/work/app/src/a.ts:3'), [], 'a CI runner is public')
	assert.deepEqual(findLeaks('The key is read from process.env.API_KEY.'), [])
})

test('paths in someone’s home folder are found on macOS, Linux and Windows', () => {
	const text = 'Seen at /Users/alice/Sites/app/a.ts, /home/bob/app and C:\\Users\\carol\\app.'
	assert.deepEqual(
		findLeaks(text).map((l) => l.text),
		['/Users/alice/', '/home/bob/', 'C:\\Users\\carol\\'],
	)
	assert.deepEqual(findLeaks('/Users/Shared/cache'), [], 'the shared folder names nobody')
})

test('masking keeps the start of a key and drops the account from a path; the description names each once', () => {
	const text = `Token ${GITHUB} in /Users/alice/app/a.ts`
	assert.equal(maskLeaks(text), 'Token ghp_Q7… in ~/app/a.ts')
	assert.deepEqual(findLeaks(maskLeaks(text)), [], 'nothing left to find')
	assert.equal(describeLeaks(findLeaks(text)), 'a GitHub token (ghp_Q7…) and a path on someone’s computer (/Users/alice/)')
})

test('a finding quoting a key or a home path is held back from automatic reviews, code blocks included', () => {
	const f = (body: string): Finding =>
		({
			title: 'Hard-coded token in client.ts',
			body,
			evidence: 'const token = load()',
			anchor: { side: 'new', newPath: 'src/client.ts', oldPath: 'src/client.ts', fileKey: 'src/client.ts' },
		}) as unknown as Finding
	assert.deepEqual(screenFinding(f(`client.ts ships \`${GITHUB}\` to every browser.`), 'acme/web'), ['what looks like a key or token'])
	assert.deepEqual(screenFinding(f('client.ts reads /Users/alice/.config/app.json at start-up.'), 'acme/web'), [
		'a path on someone’s computer',
	])
	assert.deepEqual(screenFinding(f('client.ts no longer checks the token before use.'), 'acme/web'), [])
})

test('a finding that read MCP tools is held back on a public repository, or one whose visibility is unknown', () => {
	const f = {
		title: 'Refunds skip the audit in client.ts',
		body: 'client.ts no longer writes the audit row that ticket ENG-42 asks for.',
		evidence: 'refund(order)',
		anchor: { side: 'new', newPath: 'src/client.ts', oldPath: 'src/client.ts', fileKey: 'src/client.ts' },
		external: ['linear'],
	} as unknown as Finding
	assert.deepEqual(screenFinding(f, 'acme/web', true), ['what it read through MCP (linear) on a public repository'])
	assert.deepEqual(screenFinding(f, 'acme/web', null), ['what it read through MCP (linear) on a possibly public repository'])
	assert.deepEqual(screenFinding(f, 'acme/web', false), [], 'a private repository: only its own team reads it')
	assert.deepEqual(screenFinding(f, 'acme/web'), [], 'where visibility does not matter')
	assert.equal(publicRepo({ private: true }), false)
	assert.equal(publicRepo({ private: false }), true)
	assert.equal(publicRepo({}), null, 'not recorded: unknown')
})
