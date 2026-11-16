import assert from 'node:assert/strict'
import { test } from 'node:test'
import { variantRequest } from '../src/main/ai/consistency.ts'
import { buildVerifyRequest } from '../src/main/ai/verify.ts'
import type { Finding } from '../src/shared/types.ts'

const finding = {
	id: 'f',
	title: 'Rules that fail to load skip the role check',
	severity: 'blocking',
	category: 'security',
	body: 'b',
	evidence: 'e',
	anchor: {
		repoId: 'r',
		baseSha: 'b',
		headSha: 'h',
		fileKey: 'a.py',
		oldPath: 'a.py',
		newPath: 'a.py',
		side: 'new',
		startLine: 3,
		endLine: 3,
		excerpt: '',
	},
} as Finding

test('fixed check: judged by the consequence, and patches that only hide it are named as not fixes', () => {
	const fixed = buildVerifyRequest(finding, null, [], undefined, ['code'], 'abc1234567').instructions
	assert.match(fixed, /by what the finding says goes wrong, not by whether its cited lines changed/)
	assert.match(fixed, /a partial fix holds/)
	assert.match(fixed, /catching a narrower error type, or a different one, while still returning the same fallback/)
	assert.match(fixed, /guarding one caller when the finding names another/)

	const raised = buildVerifyRequest(finding, null, [], undefined, ['code']).instructions
	assert.doesNotMatch(raised, /cited lines changed|narrower error type/, 'a fresh double-check is not about fixes')
})

test('fixed check: the consistency check still finds and reverses only the verdict lines', () => {
	const base = buildVerifyRequest(finding, null, [], undefined, ['code'], 'abc1234567')
	const reversed = variantRequest(base, 'reversed')!
	const verdicts = (text: string) =>
		text
			.split('\n')
			.filter((l) => /^- "(wrong|holds|unsure)":/.test(l))
			.slice(0, 3)
	assert.deepEqual(verdicts(reversed.instructions), [...verdicts(base.instructions)].reverse())
	const note = (text: string) => text.slice(0, text.indexOf('Another reviewer reported'))
	assert.equal(note(reversed.instructions), note(base.instructions), 'the fixed note is left alone')
})
