import type { AiRun, ConsistencyReport, ConsistencyRow, ConsistencyVariant, ConsistencyVerdict, Finding } from '../../shared/types.ts'
import type { ProviderRequest } from './provider.ts'

/**
 * Does the double-check's verdict depend on how the question is asked (issue #196)? The same double-check, with the
 * same code, is sent as it is, again as it is (plain noise), with its answers in reverse order, and framed as
 * "confirm it" instead of "disprove it". A verdict that changes with the order of its answers is unreliable whichever
 * answer is right, so this measures agreement and needs no labels. Lookups are off, so every variant reads the same code.
 */

export const MAX_CONSISTENCY_FINDINGS = 8
export const VARIANTS: ReadonlyArray<ConsistencyVariant> = ['as-is', 'repeat', 'reversed', 'reframed']

// The verdict lines of the double-check's instructions (see judging in verify.ts), in the order they're written.
const VERDICT_LINES = ['- "wrong":', '- "holds":', '- "unsure":']
const FRAMES: Array<[string, string]> = [
	[
		'Your job is to find out whether it is wrong before anyone acts on it.',
		'Your job is to find out whether it is right before anyone acts on it.',
	],
	['- Try to disprove it.', '- Try to confirm it.'],
]

/** `base` as the variant asks it; null when its text isn't the double-check's as expected, so nothing is sent. */
export function variantRequest(base: ProviderRequest, v: ConsistencyVariant): ProviderRequest | null {
	if (v === 'as-is' || v === 'repeat') return base
	if (v === 'reframed') {
		if (!FRAMES.every(([from]) => base.instructions.includes(from))) return null
		return { ...base, instructions: FRAMES.reduce((text, [from, to]) => text.replace(from, to), base.instructions) }
	}
	const lines = base.instructions.split('\n')
	const at = VERDICT_LINES.map((start) => lines.findIndex((l) => l.startsWith(start)))
	if (at.some((i) => i < 0) || !base.schema) return null
	const moved = at.map((i) => lines[i]).reverse()
	at.forEach((i, k) => (lines[i] = moved[k]))
	return { ...base, instructions: lines.join('\n'), schema: { name: base.schema.name, json: reversedVerdicts(base.schema.json) } }
}

/** The JSON schema with the verdict's allowed answers listed in reverse order. */
function reversedVerdicts(json: Record<string, unknown>): Record<string, unknown> {
	const copy = structuredClone(json) as { properties?: { verdict?: { enum?: Array<unknown> } } }
	const e = copy.properties?.verdict?.enum
	if (Array.isArray(e)) e.reverse()
	return copy as Record<string, unknown>
}

export interface ConsistencyFinding {
	finding: Finding // anchored where it is now, for a gone finding
	since: string | null // a gone finding: the head of the snapshot it was raised on (see buildVerifyRequest)
	kind: ConsistencyRow['kind']
}

/**
 * The review's findings whose double-check came back without error: blocking findings of its finished runs, newest run
 * first, then gone findings checked for being fixed; at most MAX_CONSISTENCY_FINDINGS.
 */
export function consistencyFindings(runs: ReadonlyArray<AiRun>): Array<ConsistencyFinding> {
	const out: Array<ConsistencyFinding> = []
	const seen = new Set<string>()
	const finished = [...runs].reverse().filter((r) => r.status === 'completed' || r.status === 'partial')
	for (const r of finished)
		for (const f of r.findings)
			if (f.verification && !f.verification.error && !f.mergedInto && !seen.has(f.id)) {
				seen.add(f.id)
				out.push({ finding: f, since: null, kind: 'blocking' })
			}
	for (const r of finished)
		for (const g of r.history?.gone ?? [])
			if (g.check && !g.check.error && !seen.has(g.finding.id)) {
				seen.add(g.finding.id)
				out.push({ finding: { ...g.finding, anchor: g.at ?? g.finding.anchor }, since: r.history!.from.headSha, kind: 'fixed' })
			}
	return out.slice(0, MAX_CONSISTENCY_FINDINGS)
}

export function placeOf(f: Finding): string {
	const a = f.anchor
	const path = (a.side === 'old' ? a.oldPath : a.newPath) ?? a.newPath ?? a.oldPath ?? a.fileKey
	return a.startLine === null ? path : `${path}:${a.startLine}`
}

/** Each variant against "as-is", counting only findings where both answered. */
export function summarize(rows: ReadonlyArray<ConsistencyRow>): ConsistencyReport['variants'] {
	const swap = (a: ConsistencyVerdict, b: ConsistencyVerdict) => (a === 'wrong' && b === 'holds') || (a === 'holds' && b === 'wrong')
	return (['repeat', 'reversed', 'reframed'] as const).map((variant) => {
		const both = rows.filter((r) => r.verdicts['as-is'] !== 'failed' && r.verdicts[variant] !== 'failed')
		return {
			variant,
			compared: both.length,
			changed: both.filter((r) => r.verdicts[variant] !== r.verdicts['as-is']).length,
			wrongHolds: both.filter((r) => swap(r.verdicts['as-is'], r.verdicts[variant])).length,
			failed: rows.length - both.length,
		}
	})
}
