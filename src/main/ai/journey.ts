import type { BeatTone, Finding, RunBeat, RunBeatBody, Severity } from '../../shared/types.ts'

/**
 * A run's journey (issue #299): the beats the Run tab shows, recorded on the run and sent to the window as they happen.
 * Lookups are the bulk of it, so past MAX_LOOKUP_BEATS only the other beats are kept; past MAX_BEATS nothing is.
 */
export const MAX_BEATS = 2000
export const MAX_LOOKUP_BEATS = 1500

const LOOKUPS = new Set<RunBeatBody['kind']>(['read', 'search', 'list', 'tool'])

export interface Journey {
	add(memberId: string | null, body: RunBeatBody): void
}

/** Appends to `beats` (the run's own list, so a retry continues where the run left off). */
export function createJourney(beats: Array<RunBeat>, onBeat: (beat: RunBeat) => void, now: () => number = Date.now): Journey {
	let lookups = beats.filter((b) => LOOKUPS.has(b.kind)).length
	return {
		add(memberId, body) {
			if (beats.length >= MAX_BEATS) return
			if (LOOKUPS.has(body.kind) && lookups++ >= MAX_LOOKUP_BEATS) return
			const beat = { ...body, seq: (beats.at(-1)?.seq ?? -1) + 1, at: now(), memberId } as RunBeat
			beats.push(beat)
			onBeat(structuredClone(beat))
		},
	}
}

/** The beat for a lookup the reviewer made, or null for one it got wrong (refused calls are noise on the trail). */
export function lookupBeat(name: string, args: unknown, refused: boolean, label: (name: string) => string | null): RunBeatBody | null {
	if (refused) return null
	const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
	const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
	const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null)
	switch (name) {
		case 'read_file':
			return str(a.path)
				? { kind: 'read', path: str(a.path)!, version: str(a.version) ?? 'head', start: int(a.start_line), end: int(a.end_line) }
				: null
		case 'search_code':
			return str(a.text) ? { kind: 'search', text: str(a.text)! } : null
		case 'list_files':
			return { kind: 'list', path: str(a.directory) ?? '' }
		default: {
			const tool = label(name)
			return tool ? { kind: 'tool', name: tool } : null
		}
	}
}

/**
 * A raised blocking finding is a claim until the double-check tries it, so it stays neutral and its verdict colours
 * it; the rest are concerns.
 */
export function severityTone(s: Severity): BeatTone {
	return s === 'blocking' || s === 'high' ? 'pending' : 'concern'
}

/** A double-check, a near-miss check or a bot-thread check, as the state of the code it found. */
export function verdictTone(verdict: 'holds' | 'wrong' | 'problem' | 'safe' | 'unsure', error = false): BeatTone {
	if (error) return 'unsettled'
	if (verdict === 'holds' || verdict === 'problem') return 'confirmed'
	if (verdict === 'wrong' || verdict === 'safe') return 'cleared'
	return 'concern'
}

export function findingBeat(f: Finding): RunBeatBody {
	const a = f.anchor
	return {
		kind: 'finding',
		findingId: f.id,
		title: f.title,
		severity: f.severity,
		path: (a.side === 'old' ? a.oldPath : a.newPath) ?? a.fileKey,
		line: a.startLine,
		tone: severityTone(f.severity),
	}
}
