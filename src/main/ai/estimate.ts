import type { Comparison, PricedModel, ReviewLimits, ReviewRule, RunEstimate } from '../../shared/types.ts'
import { CHARS_PER_TOKEN, fitToModel, packContext, prepareChange, type FileSource } from './context.ts'
import { LOOKUP_RESERVE, TOOL_DEFINITIONS } from './lookup.ts'
import { outputBudget, type ModelLimits } from './provider.ts'
import { classifyRisk } from './risk.ts'
import { routeFiles } from './routing.ts'
import { MAX_VERIFIED } from './verify.ts'

/** One reviewer of the run being estimated: a model, or a team member or focused pass with its rules. */
export interface EstimateReviewer {
	role: string | null
	model: string
	rules: ReadonlyArray<ReviewRule> | null // null: every rule, every file
	limits: ModelLimits
	price: PricedModel | null
	instructionChars: number
}

// Measured on 248 finished runs: input tokens over (characters sent ÷ CHARS_PER_TOKEN), where characters sent are the
// requests' excerpts plus their instructions. Lookups resend the conversation once per round, so they spread it widely.
const INPUT_FACTOR = { plain: { low: 0.8, high: 1.05 }, lookups: { low: 1.5, high: 5.5 } }
// Related code, which the estimate doesn't search for, was 2–33% of those runs' characters (10th–90th percentile).
const RELATED = { low: 1, high: 1.5 }
// Output tokens per request in the same runs (10th and 90th percentiles).
const OUTPUT_PER_REQUEST = { plain: { low: 600, high: 1800 }, lookups: { low: 600, high: 2700 } }

/**
 * What a run would send, from its requests packed the way the run packs them, without the related code, CI results
 * and conversation the run adds (gathering those is what makes a run slow to start). A range, not a promise.
 */
export function estimateRun(
	comparison: Comparison,
	sources: Array<FileSource>,
	limits: ReviewLimits,
	reviewers: Array<EstimateReviewer>,
	carried: ReadonlySet<string> = new Set(),
): RunEstimate {
	const lookups = limits.lookups !== false
	const toolChars = lookups ? JSON.stringify(TOOL_DEFINITIONS).length : 0
	const notes: Array<string> = []
	const fits = reviewers.flatMap((r) => {
		const fitted = fitToModel(limits, r.limits, outputBudget(r.limits), r.instructionChars + toolChars, lookups ? LOOKUP_RESERVE : 0)
		if (!fitted) notes.push(`${r.role ? `${r.role}: the` : 'The'} model's context window is too small for a review request.`)
		return fitted ? [{ r, limits: fitted.limits }] : []
	})
	const empty = { low: 0, high: 0 }
	if (!fits.length) return { requests: 0, files: 0, inputTokens: empty, outputTokens: empty, cost: null, notes, over: [] }
	// As in the run: excerpts are cut once to fit the smallest reviewer, then each packs its own requests.
	const tight = fits.reduce((a, b) => (b.limits.maxBatchChars < a.limits.maxBatchChars ? b : a))
	const prepared = prepareChange(sources, tight.limits, [])
	const risk = classifyRisk(sources, null)
	const factor = lookups ? INPUT_FACTOR.lookups : INPUT_FACTOR.plain
	const perRequest = lookups ? OUTPUT_PER_REQUEST.lookups : OUTPUT_PER_REQUEST.plain
	const total = {
		requests: 0,
		input: { ...empty },
		output: { ...empty },
		low: 0,
		high: 0,
		priced: false,
		unpriced: false,
		estimated: false,
	}
	const sentFiles = new Set<string>()
	for (const { r, limits: l } of fits) {
		const routing = r.rules ? { fileKeys: routeFiles(r.rules, sources, risk, []), label: r.role } : null
		const pkg = packContext(comparison, sources, prepared, l, [], [], risk, routing, carried)
		for (const b of pkg.batches) for (const k of b.fileKeys) sentFiles.add(k)
		const n = pkg.batches.length
		const related = limits.relatedCode !== false ? RELATED : { low: 1, high: 1 }
		const sent = (share: number): number => (pkg.inputChars * share + n * (r.instructionChars + toolChars)) / CHARS_PER_TOKEN
		const tokens = sent(related.low)
		const input = { low: Math.round(tokens * factor.low), high: Math.round(sent(related.high) * factor.high) }
		const output = { low: n * perRequest.low, high: n * perRequest.high }
		total.requests += n
		total.input.low += input.low
		total.input.high += input.high
		total.output.low += output.low
		total.output.high += output.high
		if (!r.price) {
			if (n) total.unpriced = true
			continue
		}
		const p = r.price
		// Lookup rounds resend a conversation the provider has usually cached; the high end assumes it hasn't.
		const plain = Math.min(input.low, Math.round(tokens * INPUT_FACTOR.plain.low))
		total.low += (plain * p.input + (input.low - plain) * (p.cachedInput ?? p.input) + output.low * p.output) / 1_000_000
		total.high += (input.high * p.input + output.high * p.output) / 1_000_000
		total.priced = true
		total.estimated ||= p.source === 'catalog'
	}
	const over = prepared.files.filter((f) => f.state === 'skipped' || f.state === 'partial').length
	if (over)
		notes.push(`${over} file${over === 1 ? ' is' : 's are'} over the review limits and ${over === 1 ? 'is' : 'are'} not sent in full.`)
	if (limits.relatedCode !== false) notes.push('Related code is not searched for the estimate; up to half as much again is allowed for it.')
	if (lookups) notes.push('Lookups resend the conversation each time the reviewer opens a file or searches, so the range is wide.')
	if (limits.verify !== false) notes.push(`Double-checking blocking findings adds up to ${MAX_VERIFIED} requests, not counted here.`)
	if (limits.groupDuplicates) notes.push('Grouping duplicate findings adds one request, not counted here.')
	if (total.unpriced) notes.push('Some models have no price, so the cost leaves them out.')
	return {
		requests: total.requests,
		files: sentFiles.size,
		inputTokens: total.input,
		outputTokens: total.output,
		cost: total.priced ? { low: total.low, high: total.high, estimated: total.estimated, unpriced: total.unpriced } : null,
		notes,
		over: [],
	}
}
