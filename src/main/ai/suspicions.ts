import type { Finding, RunBeatBody } from '../../shared/types.ts'
import type { ValidatedBatch } from './findings.ts'
import { severityTone } from './journey.ts'
import type { ToolDefinition, ToolResult } from './lookup.ts'

/**
 * Suspicions (issue #299): while a reviewer works, it says what it suspects before it looks into it, so the Run drawer
 * can show the review as it thinks; its answer then closes each one. The tool reads nothing and costs no lookups. A
 * suspicion is never evidence: only a finding that passes validation is one, and a "cleared" one has to point at code
 * the reviewer had in front of it, or it is shown as not settled.
 */
export const MAX_SUSPICIONS = 8

export const SUSPICION_TOOL: ToolDefinition = {
	name: 'note_suspicion',
	description:
		'Say what you suspect, in one short sentence, before you look into it, so the person watching the review can follow along. Use it for a specific possible problem on a changed line, not for every line you read. It looks nothing up and does not count against your lookups. Returns an id to close in your answer.',
	parameters: {
		type: 'object',
		properties: {
			text: { type: 'string', description: 'What you suspect, e.g. "The refresh path may skip the token check."' },
			path: { type: ['string', 'null'], description: 'The changed file it is about, as shown in the excerpt header, or null.' },
			line: { type: ['integer', 'null'], description: 'The line it is about, on the side shown, or null.' },
		},
		required: ['text', 'path', 'line'],
		additionalProperties: false,
	},
}

export const SUSPICION_INSTRUCTIONS = `

# Saying what you suspect
When note_suspicion is among your tools, call it as soon as you suspect a specific problem on a changed line, before you open files or search to settle it, with one short sentence and the place. Note only what you will look into, at most ${MAX_SUSPICIONS}. It returns an id ("S1", "S2"…). Close every suspicion you noted in your answer: a finding that settles it has its "suspicion_id"; any other goes under "suspicions", as "cleared" with the path:line of the code that shows it is fine (code you were given or read), or as "near_miss" when you could not show it either way. Noting a suspicion never makes a finding more likely: report under the same rules as without it.`

/** A suspicion as noted during one request: its id there ("S1") and its name in the run's journey. */
export interface Noted {
	id: string
	key: string
	text: string
	path: string | null
	line: number | null
}

export interface Notebook {
	noted: Array<Noted>
	/** Handles one note_suspicion call: the result for the model, and the suspicion when it was noted. */
	note(args: unknown): { result: ToolResult; noted: Noted | null }
	/** The journey's name for a suspicion this request noted, from the id the model used; null for one it never got. */
	key(id: string): string | null
}

/** One request's suspicions. `prefix` keeps their names apart from every other request's in the run. */
export function createNotebook(prefix: string): Notebook {
	const noted: Array<Noted> = []
	return {
		noted,
		note(args) {
			const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
			const text = typeof a.text === 'string' ? a.text.trim().replace(/\s+/g, ' ') : ''
			if (!text) return { result: { text: '"text" must say what you suspect.', error: true }, noted: null }
			if (noted.length >= MAX_SUSPICIONS)
				return {
					result: { text: `You have noted ${MAX_SUSPICIONS} suspicions, the most for one request. Look into those first.`, error: true },
					noted: null,
				}
			const id = `S${noted.length + 1}`
			const n: Noted = {
				id,
				key: `${prefix}-${id}`,
				text: text.length > 200 ? `${text.slice(0, 199)}…` : text,
				path: typeof a.path === 'string' && a.path.trim() ? a.path.trim() : null,
				line: typeof a.line === 'number' && Number.isInteger(a.line) && a.line > 0 ? a.line : null,
			}
			noted.push(n)
			return { result: { text: `Noted as ${id}. Close it in your answer.`, error: false }, noted: n }
		},
		key: (id) => noted.find((n) => n.id === id.trim())?.key ?? null,
	}
}

/**
 * How each noted suspicion ended, for the journey. `answer` is null when the request failed; its findings carry the
 * journey's names in `suspicion`. `listed` finds the finding the run lists for one (itself, or the one it repeats), and
 * `unread` the file:line references in a text to lines the request never had.
 */
export function settleSuspicions(
	noted: ReadonlyArray<Noted>,
	answer: Pick<ValidatedBatch, 'findings' | 'suspicions'> | null,
	listed: (f: Finding) => Finding | null,
	unread: (texts: Array<string | null>) => Array<string>,
	failure: string | null = null,
): Array<Extract<RunBeatBody, { kind: 'settled' }>> {
	return noted.map((n) => {
		const at = { id: n.key, path: n.path, line: n.line, findingId: null }
		const open = (reason: string) => ({
			kind: 'settled' as const,
			...at,
			outcome: 'unsettled' as const,
			tone: 'unsettled' as const,
			reason,
		})
		if (!answer) return open(failure ?? 'The request ended before it answered.')
		const f = answer.findings.find((x) => x.suspicion === n.key)
		if (f) {
			const shown = listed(f)
			return {
				kind: 'settled',
				...at,
				outcome: 'finding',
				tone: severityTone(f.severity),
				reason: shown && shown.id !== f.id ? `Raised as “${f.title}”, the same problem as “${shown.title}”` : `Raised as “${f.title}”`,
				findingId: shown?.id ?? null,
			}
		}
		const s = answer.suspicions.find((x) => x.id === n.id)
		if (!s) return open('Not closed in the answer.')
		if (s.outcome === 'near_miss') return { kind: 'settled', ...at, outcome: 'near-miss', tone: 'concern', reason: s.reason }
		// A ✓ has to be earned: "cleared" points at code, and at code the reviewer actually had.
		if (!s.evidence) return open(`Said cleared without pointing at the code: ${s.reason}`)
		const missed = unread([s.reason, s.evidence])
		if (missed.length) return open(`Said cleared, citing ${missed.join(', ')}, which it never read: ${s.reason}`)
		return { kind: 'settled', ...at, outcome: 'cleared', tone: 'cleared', reason: `${s.reason} (${s.evidence})` }
	})
}
