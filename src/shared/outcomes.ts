import type { OutcomeCounts, OutcomeGroup } from './types.ts'

export const OUTCOME_GROUP_LABEL: Record<OutcomeGroup, string> = {
	defect: 'Defects',
	design: 'Design and clarity',
	uncategorised: 'Uncategorised',
}

/** Accepted and dismissed: the problems a rate can be worked out from. */
export function decidedCount(c: OutcomeCounts): number {
	return c.accepted + Object.values(c.dismissed).reduce((a, b) => a + b, 0)
}
