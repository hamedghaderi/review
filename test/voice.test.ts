import assert from 'node:assert/strict'
import { test } from 'node:test'
import { askInstructions } from '../src/main/ai/ask.ts'
import { conclusionInstructions } from '../src/main/ai/conclusion.ts'
import { EXPLAIN_INSTRUCTIONS } from '../src/main/ai/explain.ts'

// The reviewer's voice (docs/architecture.md): every prompt that answers a developer's question puts the answer first.
test('every answer to a question starts with the answer', () => {
	const prompts = {
		'finding question': askInstructions(true),
		'finding question, no lookups': askInstructions(false),
		'code question': EXPLAIN_INSTRUCTIONS,
		conclusion: conclusionInstructions(true),
	}
	for (const [name, text] of Object.entries(prompts)) {
		assert.match(text, /starts? with the direct answer, then the reason/i, name)
		assert.match(text, /no filler/i, name)
	}
})
