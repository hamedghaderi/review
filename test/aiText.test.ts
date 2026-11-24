import assert from 'node:assert/strict'
import { test } from 'node:test'
import { editShare, flagText, markReplySent, MAX_AI_TEXT, recordAiText, replyFate } from '../src/main/ai/aiText.ts'
import { summarizeOutcomes } from '../src/main/ai/outcomes.ts'
import type { RepoState } from '../src/main/store.ts'
import type { AiTextRecord, ChangeExplanation, OutcomeFilter, Review } from '../src/shared/types.ts'

const NOW = new Date('2026-10-23T12:00:00Z')
const ALL: OutcomeFilter = { period: 'all', repoId: null, promptVersion: null, group: null, model: null }
const repo = (repoId: string, aiText: Array<AiTextRecord>): RepoState =>
	({ repoId, root: `/x/${repoId}`, githubRepo: `owner/${repoId}`, reviews: {}, aiRuns: {}, aiText }) as RepoState
const text = (feature: AiTextRecord['feature'], more: Partial<AiTextRecord> = {}): AiTextRecord => ({
	id: Math.random().toString(36).slice(2),
	feature,
	at: '2026-10-20T00:00:00Z',
	connectionId: 'c1',
	connectionLabel: 'Work key',
	model: 'claude-sonnet-5-5',
	...more,
})

test('ai text: how much of a draft changed, word by word, and which fate that is', () => {
	const draft = 'Yes, line 3 adds them now, so the guard is no longer needed.'
	assert.equal(editShare(draft, draft), 0)
	assert.equal(editShare(draft, `  ${draft.replace(/ /g, '\n')} `), 0, 'spacing is not an edit')
	assert.equal(replyFate(editShare(draft, draft.replace('Yes,', 'Right,'))), 'light', 'one word of 13 swapped')
	assert.equal(replyFate(editShare(draft, 'No, the guard is still needed for empty carts.')), 'rewrite')
	assert.ok(editShare('ok', 'ok, and here is a much longer reply I wrote myself') > 1, 'more added than the draft had')
	assert.equal(replyFate(0), 'as-drafted')
	assert.equal(replyFate(0.2), 'light')
	assert.equal(replyFate(0.21), 'rewrite')
})

test('ai text: a drafted reply is marked sent once; other texts and unknown ids are left alone', () => {
	const r = repo('shop', [])
	const reply = recordAiText(r, { feature: 'reply', connectionId: 'c1', connectionLabel: 'Work key', model: 'm' }, NOW)
	const conclusion = recordAiText(r, { feature: 'conclusion', connectionId: 'c1', connectionLabel: 'Work key', model: 'm' }, NOW)
	assert.equal(reply.at, NOW.toISOString())
	assert.equal(markReplySent(r, reply.id, 'Fixed in the next commit.', 'Fixed in the next commit.', NOW), true)
	assert.deepEqual(r.aiText![0].sent, { fate: 'as-drafted', share: 0, at: NOW.toISOString() })
	assert.equal(markReplySent(r, reply.id, 'Fixed in the next commit.', 'Something else entirely now.'), false, 'once')
	assert.equal(r.aiText![0].sent!.fate, 'as-drafted')
	assert.equal(markReplySent(r, conclusion.id, 'a', 'b'), false)
	assert.equal(markReplySent(r, 'nope', 'a', 'b'), false)
	assert.equal(r.aiText![1].sent, undefined)
})

test('ai text: each repository keeps its newest records only', () => {
	const r = repo('shop', [])
	for (let i = 0; i < MAX_AI_TEXT + 5; i++) recordAiText(r, { feature: 'explain', connectionId: 'c', connectionLabel: 'C', model: `m${i}` })
	assert.equal(r.aiText!.length, MAX_AI_TEXT)
	assert.equal(r.aiText![0].model, 'm5')
})

test('outcomes: AI text is counted by feature and model, with what became of drafted replies', () => {
	const shop = repo('shop', [
		text('reply', { sent: { fate: 'as-drafted', share: 0, at: '' } }),
		text('reply', { sent: { fate: 'light', share: 0.1, at: '' } }),
		text('reply', { sent: { fate: 'rewrite', share: 0.8, at: '' } }),
		text('reply'),
		text('conclusion-answer'),
		text('conclusion'),
		text('explain'),
		text('explain', { model: 'gpt-6', connectionId: 'c2', connectionLabel: 'Other' }),
		text('explain', { at: '2025-01-01T00:00:00Z' }),
	])
	const s = summarizeOutcomes([shop], ALL, NOW)
	assert.deepEqual(
		s.aiText.map((r) => [r.feature, r.label, r.detail, r.counts]),
		[
			['explain', 'claude-sonnet-5-5', 'Work key', { made: 2, asDrafted: 0, light: 0, rewrite: 0, flagged: 0 }],
			['explain', 'gpt-6', 'Other', { made: 1, asDrafted: 0, light: 0, rewrite: 0, flagged: 0 }],
			['conclusion', 'claude-sonnet-5-5', 'Work key', { made: 1, asDrafted: 0, light: 0, rewrite: 0, flagged: 0 }],
			['conclusion-answer', 'claude-sonnet-5-5', 'Work key', { made: 1, asDrafted: 0, light: 0, rewrite: 0, flagged: 0 }],
			['reply', 'claude-sonnet-5-5', 'Work key', { made: 4, asDrafted: 1, light: 1, rewrite: 1, flagged: 0 }],
		],
	)
	assert.equal(s.total.raised, 0, 'no findings')
	assert.deepEqual(s.repos, [{ id: 'shop', label: 'owner/shop' }], 'a repository with only AI text can be filtered on')
	assert.deepEqual(
		s.allModels.map((m) => m.label),
		['claude-sonnet-5-5', 'gpt-6'],
	)
})

test('outcomes: AI text follows the period, repository and model filters, and ignores prompt version and kind', () => {
	const shop = repo('shop', [text('explain'), text('explain', { at: '2025-01-01T00:00:00Z' })])
	const api = repo('api', [text('explain', { model: 'gpt-6', connectionId: 'c2' })])
	const made = (f: Partial<OutcomeFilter>) =>
		summarizeOutcomes([shop, api], { ...ALL, ...f }, NOW).aiText.reduce((n, r) => n + r.counts.made, 0)
	assert.equal(made({}), 3)
	assert.equal(made({ period: '30d' }), 2)
	assert.equal(made({ repoId: 'shop' }), 2)
	assert.equal(made({ model: 'c2\u0000gpt-6' }), 1)
	assert.equal(made({ promptVersion: 'reviewer-2026-10-01', group: 'defect' }), 3)
})

test('ai text: "this is wrong" marks the record and the text on the review, and can be taken back', () => {
	const r = repo('shop', [])
	const by = { connectionId: 'c1', connectionLabel: 'Work key', model: 'm' }
	const old = recordAiText(r, { feature: 'explain', ...by })
	const explain = recordAiText(r, { feature: 'explain', ...by })
	const conclusion = recordAiText(r, { feature: 'conclusion', ...by })
	const answer = recordAiText(r, { feature: 'conclusion-answer', ...by })
	const reply = recordAiText(r, { feature: 'reply', ...by })
	r.reviews.rv = {
		explanation: { purpose: 'x', textId: explain.id } as ChangeExplanation,
		conclusion: {
			runId: 'run',
			omitted: [],
			messages: [
				{ id: '1', role: 'ai', text: 'c', at: '', textId: conclusion.id },
				{ id: '2', role: 'you', text: 'q', at: '' },
				{ id: '3', role: 'ai', text: 'a', at: '', textId: answer.id },
			],
		},
	} as unknown as Review
	assert.equal(flagText(r, 'rv', explain.id, { note: '  It is a refactor, not a fix.  ' }, NOW), true)
	const flag = { at: NOW.toISOString(), note: 'It is a refactor, not a fix.' }
	assert.deepEqual(r.aiText![1].flagged, flag)
	assert.deepEqual(r.reviews.rv.explanation!.flagged, flag)
	assert.equal(flagText(r, 'rv', answer.id, { note: '   ' }, NOW), true)
	assert.deepEqual(r.reviews.rv.conclusion!.messages[2].flagged, { at: NOW.toISOString(), note: null }, 'a blank note is none')
	assert.equal(r.reviews.rv.conclusion!.messages[0].flagged, undefined)
	assert.equal(flagText(r, 'rv', old.id, { note: null }, NOW), true, 'an explanation replaced since still counts')
	assert.ok(r.aiText![0].flagged)

	assert.equal(flagText(r, 'rv', explain.id, null), true)
	assert.ok(!('flagged' in r.aiText![1]) && !('flagged' in r.reviews.rv.explanation!), 'taken back')
	assert.equal(flagText(r, 'rv', reply.id, { note: null }), false, 'replies are measured by what you sent')
	assert.equal(flagText(r, 'rv', 'nope', { note: null }), false)
})

test('outcomes: flagged texts are counted per row, with the newest notes', () => {
	const flagged = (at: string, note: string | null) => ({ flagged: { at, note } })
	const shop = repo('shop', [
		text('explain', flagged('2026-10-21T00:00:00Z', 'Older note')),
		text('explain', flagged('2026-10-22T00:00:00Z', 'Newer note')),
		text('explain', flagged('2026-10-22T00:00:00Z', null)),
		text('explain'),
		text('conclusion-answer', flagged('2026-10-22T00:00:00Z', 'Wrong file')),
	])
	const s = summarizeOutcomes([shop], ALL, NOW)
	assert.deepEqual(
		s.aiText.map((r) => [r.feature, r.counts.made, r.counts.flagged, r.notes]),
		[
			['explain', 4, 3, ['Newer note', 'Older note']],
			['conclusion-answer', 1, 1, ['Wrong file']],
		],
	)
})
