/**
 * The moment you add or dismiss the last open finding of a run. The findings panel marks it with one sweep of colour
 * across itself, so working through a run's findings ends on something. It is that moment only: a run that arrives with
 * nothing open, switching runs, or a run that is still reporting findings plays nothing.
 */

export interface OpenTally {
	runId: string
	running: boolean
	open: number
}

/** How long the sweep takes; the panel keeps working underneath it the whole time. */
export const SWEEP_MS = 900

export function clearedLast(prev: OpenTally | null, next: OpenTally): boolean {
	return !!prev && prev.runId === next.runId && !prev.running && !next.running && prev.open > 0 && next.open === 0
}
