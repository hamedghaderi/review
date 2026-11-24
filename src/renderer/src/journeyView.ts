import type { AiRun, BeatTone, RunBeat } from '../../shared/types.ts'

type Lookup = Extract<RunBeat, { kind: 'read' | 'search' | 'list' | 'tool' }>

/** A row of the Run tab: one beat, or a reviewer's lookups between two of its other beats, folded into one line. */
export type JourneyRow = { kind: 'beat'; beat: RunBeat } | { kind: 'lookups'; memberId: string | null; beats: Array<Lookup> }

const isLookup = (b: RunBeat): b is Lookup => b.kind === 'read' || b.kind === 'search' || b.kind === 'list' || b.kind === 'tool'

/**
 * Folds each reviewer's lookups into one row, placed where its first lookup happened, until that reviewer does
 * something else (answers a request, a verdict) or the run reaches the next stage. Reviewers work side by side, so
 * their lookups interleave: grouping by reviewer keeps each one's reading together.
 */
export function journeyRows(beats: ReadonlyArray<RunBeat>): Array<JourneyRow> {
	const rows: Array<JourneyRow> = []
	const open = new Map<string | null, Extract<JourneyRow, { kind: 'lookups' }>>()
	for (const b of beats) {
		if (isLookup(b)) {
			const row = open.get(b.memberId)
			if (row) row.beats.push(b)
			else {
				const fresh = { kind: 'lookups' as const, memberId: b.memberId, beats: [b] }
				open.set(b.memberId, fresh)
				rows.push(fresh)
			}
			continue
		}
		if (b.kind === 'stage') open.clear()
		else open.delete(b.memberId)
		rows.push({ kind: 'beat', beat: b })
	}
	return rows
}

/** "Read 3 files, searched 2 times" — or the one lookup itself when there is only one. */
export function lookupSummary(beats: ReadonlyArray<Lookup>): string {
	if (beats.length === 1) return lookupText(beats[0])
	const files = new Set(beats.flatMap((b) => (b.kind === 'read' ? [b.path] : []))).size
	const searches = beats.filter((b) => b.kind === 'search').length
	const lists = beats.filter((b) => b.kind === 'list').length
	const tools = beats.filter((b) => b.kind === 'tool').length
	const parts = [
		files ? `read ${files} file${files === 1 ? '' : 's'}` : '',
		searches ? `searched ${searches === 1 ? 'once' : `${searches} times`}` : '',
		lists ? `listed ${lists} folder${lists === 1 ? '' : 's'}` : '',
		tools ? `called ${tools} MCP tool${tools === 1 ? '' : 's'}` : '',
	].filter(Boolean)
	const text = parts.join(', ')
	return text.charAt(0).toUpperCase() + text.slice(1)
}

export function lookupText(b: Lookup): string {
	switch (b.kind) {
		case 'read': {
			const lines = b.start !== null ? `:${b.start}${b.end !== null && b.end !== b.start ? `-${b.end}` : ''}` : ''
			const version =
				b.version === 'head'
					? ''
					: ` (${b.version === 'base' ? 'before the change' : b.version === 'tip' ? 'base branch now' : 'original pull request'})`
			return `Read ${b.path}${lines}${version}`
		}
		case 'search':
			return `Searched for “${b.text}”`
		case 'list':
			return `Listed ${b.path || 'the repository root'}`
		case 'tool':
			return `Called ${b.name}`
	}
}

export const TONE_GLYPH: Record<BeatTone, string> = { cleared: '✓', confirmed: '✗', concern: '⚠', unsettled: '○', pending: '◇' }

export const TONE_LABEL: Record<BeatTone, string> = {
	cleared: 'Cleared',
	confirmed: 'Problem',
	concern: 'Concern',
	unsettled: 'Not settled',
	pending: 'Raised, not double-checked yet',
}

/** Who a beat belongs to: the member's role in a team run, nothing for the run itself or a single-model run. */
export function memberLabel(run: AiRun, memberId: string | null): string | null {
	if (!memberId) return null
	return run.team?.members.find((m) => m.id === memberId)?.role ?? null
}

/** A member's place in the team, for its colour (0-5, repeating). */
export function memberSlot(run: AiRun, memberId: string | null): number | null {
	if (!memberId || !run.team) return null
	const i = run.team.members.findIndex((m) => m.id === memberId)
	return i < 0 ? null : i % 6
}

/** "+1:05" from the run's start. */
export function elapsed(run: AiRun, at: number): string {
	const s = Math.max(0, Math.round((at - Date.parse(run.startedAt)) / 1000))
	return `+${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The run's own beats plus those that arrived live after its last update, in order and without repeats. */
export function withLive(stored: ReadonlyArray<RunBeat>, live: ReadonlyArray<RunBeat>): Array<RunBeat> {
	const last = stored.at(-1)?.seq ?? -1
	const extra = live.filter((b) => b.seq > last).sort((a, b) => a.seq - b.seq)
	const seen = new Set<number>()
	return [...stored, ...extra.filter((b) => !seen.has(b.seq) && seen.add(b.seq))]
}

/** A line of the trail through one row: the whole row, or only above or below its node. */
export interface TrailLine {
	lane: number // 0: the run's spine; 1…n: the team's members in order
	top: boolean // from the row's top edge to its node
	bottom: boolean // from its node to the bottom edge
}

/**
 * The trail drawn beside the rows (issue #299): one spine for the run, which splits into a strand per reviewer once the
 * requests are packed and joins again at the next stage. A reviewer the run does not wait for keeps its strand past the
 * join, until its last step or the run's late finish.
 */
export type TrailItem =
	| { kind: 'row'; row: JourneyRow; lane: number; lines: Array<TrailLine> }
	| { kind: 'fork'; lanes: Array<number> }
	| { kind: 'merge'; lanes: Array<number>; through: Array<number> }

export function trailLayout(run: AiRun, rows: ReadonlyArray<JourneyRow>): { items: Array<TrailItem>; lanes: number } {
	const members = run.team?.members ?? []
	const split = members.length > 1
	const laneOf = (id: string | null): number => (id ? members.findIndex((m) => m.id === id) + 1 : 0)
	const late = new Set(members.flatMap((m, i) => (m.late ? [i + 1] : [])))
	const memberOf = (row: JourneyRow): string | null => (row.kind === 'beat' ? row.beat.memberId : row.memberId)
	const isStage = (row: JourneyRow, stage?: string): boolean =>
		row.kind === 'beat' && row.beat.kind === 'stage' && (!stage || row.beat.stage === stage)
	// Where each late strand ends: its own last step.
	const lastOf = new Map<number, number>()
	rows.forEach((r, i) => lastOf.set(laneOf(memberOf(r)), i))
	// Once the late reviewers are done the run says so, and their strands join the spine there.
	const lateEnd = rows.findIndex((r) => isStage(r, 'late-finished'))
	if (lateEnd >= 0) for (const l of late) lastOf.set(l, lateEnd)

	const items: Array<TrailItem> = []
	let phase: 'spine' | 'lanes' | 'after' = 'spine'
	let strands: Array<number> = [] // member lanes drawn through the current row, besides the spine
	const all = members.map((_, i) => i + 1)
	rows.forEach((row, i) => {
		const first = i === 0
		const last = i === rows.length - 1
		if (phase === 'lanes' && isStage(row)) {
			const through = strands.filter((l) => late.has(l) && (lastOf.get(l) ?? -1) > i)
			items.push({ kind: 'merge', lanes: strands.filter((l) => !through.includes(l)), through })
			strands = through
			phase = 'after'
		} else if (phase === 'after' && strands.length && isStage(row, 'late-finished')) {
			items.push({ kind: 'merge', lanes: strands, through: [] })
			strands = []
		}
		const own = laneOf(memberOf(row))
		const lane = phase === 'lanes' ? own || 1 : strands.includes(own) ? own : 0
		const spine = phase !== 'lanes'
		const forks = phase === 'spine' && split && isStage(row, 'packed')
		const lines: Array<TrailLine> = [
			...(spine ? [{ lane: 0, top: !first, bottom: !last || forks }] : []),
			// A strand stops at the newest step while the run goes on, and a late one at its own last step.
			...strands.map((l) => ({ lane: l, top: true, bottom: !last && !(phase === 'after' && lastOf.get(l) === i) })),
		]
		items.push({ kind: 'row', row, lane, lines })
		if (forks) {
			items.push({ kind: 'fork', lanes: all })
			strands = all
			phase = 'lanes'
		}
		// A late strand with nothing more to show ends at its last node.
		if (phase === 'after') strands = strands.filter((l) => (lastOf.get(l) ?? -1) > i)
	})
	return { items, lanes: split ? members.length : 0 }
}

/** How the run's findings and checks stand now: a raised finding counts as its verdict once it has one. */
export function journeyTally(beats: ReadonlyArray<RunBeat>): Record<BeatTone, number> {
	const tally: Record<BeatTone, number> = { cleared: 0, confirmed: 0, concern: 0, unsettled: 0, pending: 0 }
	const verdicts = new Map<string, BeatTone>()
	for (const b of beats) if (b.kind === 'verdict' && b.of === 'finding' && b.findingId) verdicts.set(b.findingId, b.tone)
	for (const b of beats) {
		if (b.kind === 'finding') tally[verdicts.get(b.findingId) ?? b.tone]++
		else if (b.kind === 'verdict' && b.of !== 'finding') tally[b.tone]++
	}
	return tally
}
