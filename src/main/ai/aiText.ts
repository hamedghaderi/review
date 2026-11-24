import { randomUUID } from 'node:crypto'
import type { AiTextRecord, ReplyFate } from '../../shared/types.ts'
import type { RepoState } from '../store.ts'

/**
 * What the AI writes besides findings (issue #289): one record per explanation, conclusion, answer and drafted reply,
 * so Outcomes can count them by model. Only who made it and when is kept, never the text. For a drafted reply, what
 * became of it: sent as drafted, lightly edited or rewritten; a draft that is never sent stays unmarked.
 */

export const MAX_AI_TEXT = 2000 // per repository; the oldest go first
export const LIGHT_EDIT = 0.2 // up to this share of the draft's words changed is a light edit
const MAX_WORDS = 1500 // compared per text; a longer draft is compared on its first words

export function recordAiText(repo: RepoState, r: Omit<AiTextRecord, 'id' | 'at' | 'sent'>, now = new Date()): AiTextRecord {
	const rec: AiTextRecord = { id: randomUUID(), at: now.toISOString(), ...r }
	const list = (repo.aiText ??= [])
	list.push(rec)
	if (list.length > MAX_AI_TEXT) list.splice(0, list.length - MAX_AI_TEXT)
	return rec
}

const words = (s: string): Array<string> => s.split(/\s+/).filter(Boolean).slice(0, MAX_WORDS)

/**
 * How much of a draft changed before it was sent: words removed from it plus words added, as a share of its words
 * (word by word, in order). 0 is sent as drafted; it can pass 1 when more was added than the draft had.
 */
export function editShare(draft: string, sent: string): number {
	const a = words(draft)
	const b = words(sent)
	if (!a.length) return b.length ? 1 : 0
	// Longest common subsequence of words, one row at a time.
	let prev = new Array<number>(b.length + 1).fill(0)
	for (const w of a) {
		const row = new Array<number>(b.length + 1).fill(0)
		for (let j = 1; j <= b.length; j++) row[j] = w === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1])
		prev = row
	}
	const kept = prev[b.length]
	return (a.length - kept + (b.length - kept)) / a.length
}

export function replyFate(share: number): ReplyFate {
	return share === 0 ? 'as-drafted' : share <= LIGHT_EDIT ? 'light' : 'rewrite'
}

/** Marks a drafted reply as sent, once; false when there is no such unsent draft. */
export function markReplySent(repo: RepoState, id: string, draft: string, sent: string, now = new Date()): boolean {
	const rec = repo.aiText?.find((r) => r.id === id)
	if (!rec || rec.feature !== 'reply' || rec.sent) return false
	const share = editShare(draft, sent)
	rec.sent = { fate: replyFate(share), share: Math.round(share * 100) / 100, at: now.toISOString() }
	return true
}
