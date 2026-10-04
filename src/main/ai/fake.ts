import { REVIEW_RULES } from '../../shared/types.ts'
import {
	ANSWER_SCHEMA_NAME,
	MERGE_SCHEMA_NAME,
	VERIFY_SCHEMA_NAME,
	type ModelAnswer,
	type ModelFinding,
	type ModelGroups,
	type ModelVerification,
	type ReviewOutput,
} from './schema.ts'
import {
	ProviderError,
	type DiscoveredModel,
	type ModelLimits,
	type ProviderAccount,
	type ProviderRequest,
	type ProviderResponse,
	type ReviewProvider,
} from './provider.ts'

// Scripts may return malformed output (unknown) to exercise validation. A script that returns `{ tool_calls }` makes
// lookups: the provider runs them through the request's tools and calls the script again with the results.
export type FakeScript = (
	request: ProviderRequest,
	call: number,
	lookups: Array<FakeLookup>,
) => ReviewOutput | FakeToolCalls | ProviderError | unknown | Promise<ReviewOutput | FakeToolCalls | ProviderError | unknown>

export interface FakeToolCalls {
	tool_calls: Array<{ name: string; args: unknown }>
}

export interface FakeLookup {
	name: string
	args: unknown
	text: string
	error: boolean
}

export const FIXTURE_LIMITS: ModelLimits = { contextWindow: 200_000, maxOutputTokens: 32_000 }

/**
 * Deterministic provider for development and tests. By default it reports one low-severity finding on the first
 * changed line of every excerpt, plus one finding citing an unknown excerpt (so validation rejects it), so the UI can
 * be exercised without network access.
 */
export function createFakeProvider(
	options: { script?: FakeScript; delayMs?: number; model?: string; limits?: ModelLimits } = {},
): ReviewProvider & { calls: number } {
	const provider = {
		id: 'fixture' as const,
		label: 'Fixture provider',
		protocol: 'fixture' as const,
		model: options.model ?? 'fixture-v1',
		fixture: true,
		limits: options.limits ?? FIXTURE_LIMITS,
		calls: 0,
		async review(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse> {
			const lookups: Array<FakeLookup> = []
			for (;;) {
				const call = provider.calls++
				if (options.delayMs) await abortableDelay(options.delayMs, signal)
				if (signal.aborted) throw new ProviderError('cancelled', 'Request cancelled')
				const result = await (options.script ?? defaultScript)(request, call, lookups)
				if (result instanceof ProviderError) throw result
				const wanted = result && typeof result === 'object' && 'tool_calls' in result ? (result as FakeToolCalls).tool_calls : null
				if (wanted) {
					if (!request.tools || request.tools.exhausted())
						throw new ProviderError('invalid-output', 'Fixture asked for lookups that were not offered')
					for (const t of wanted) lookups.push({ ...t, ...(await request.tools.call(t.name, t.args, signal)) })
					continue
				}
				return respond(result)
			}
			function respond(result: unknown): ProviderResponse {
				return {
					output: result,
					usage: {
						inputTokens: Math.ceil((request.instructions.length + request.input.length) / 4),
						cachedInputTokens: 0,
						outputTokens: 50,
						reasoningTokens: 0,
						totalTokens: 0,
					},
				}
			}
		},
	}
	return provider
}

export function createFakeAccount(): ProviderAccount {
	return {
		async listModels(): Promise<Array<DiscoveredModel>> {
			return [
				{
					id: 'fixture-v1',
					label: 'Fixture v1',
					contextWindow: FIXTURE_LIMITS.contextWindow,
					maxOutputTokens: FIXTURE_LIMITS.maxOutputTokens,
					structuredOutput: 'yes',
				},
			]
		},
	}
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(done, ms)
		function done(): void {
			signal.removeEventListener('abort', abort)
			resolve()
		}
		function abort(): void {
			clearTimeout(t)
			reject(new ProviderError('cancelled', 'Request cancelled'))
		}
		signal.addEventListener('abort', abort, { once: true })
	})
}

export function defaultScript(request: ProviderRequest): ReviewOutput | ModelAnswer | ModelVerification | ModelGroups {
	if (request.schema?.name === MERGE_SCHEMA_NAME) return { groups: [] }
	if (request.schema?.name === VERIFY_SCHEMA_NAME)
		return { verdict: 'unsure', reason: 'Fixture: the finding was not checked.', level: null, checked: [] }
	if (request.schema?.name === ANSWER_SCHEMA_NAME)
		return { answer: 'Fixture answer. It does not read the question or the code.', verdict: 'unsure', level: null }
	const findings: Array<ModelFinding> = []
	for (const excerpt of request.batch.excerpts) {
		const line =
			excerpt.lines.find((l) => l.kind === 'add' && l.text.trim()) ?? excerpt.lines.find((l) => l.kind === 'del' && l.text.trim())
		if (!line) continue
		const side = line.kind === 'add' ? 'new' : 'old'
		const n = (side === 'new' ? line.newNo : line.oldNo) as number
		findings.push({
			excerpt_id: excerpt.id,
			file_path: (side === 'new' ? excerpt.file.newPath : excerpt.file.oldPath) as string,
			side,
			start_line: n,
			end_line: n,
			category: 'bug',
			signature: null,
			test_pattern: null,
			severity: 'should_fix',
			title: `Fixture finding for ${side === 'new' ? 'added' : 'deleted'} line ${n}`,
			body: 'Deterministic fixture output. It marks the first changed line of each excerpt and makes no claim about the code. Dismiss it, or add it to the review to test the comment workflow.',
			reasoning: 'Fixture: marks the first changed line.',
			disproof: null,
			background: null,
			evidence: line.text.trim(),
		})
	}
	if (findings.length) findings.push({ ...findings[0], excerpt_id: 'E-unknown', title: 'Fixture finding with an invalid reference' })
	// As a team member, answer only for the assigned rules, like a real model following its assignment.
	const assigned = /Return "evaluation" entries for exactly these rules, in this order: ([^.]+)\./
		.exec(request.instructions)?.[1]
		.split(', ')
	if (assigned) {
		return {
			findings: assigned.includes('bug') ? findings : [],
			evaluation: emptyEvaluation().filter((e) => assigned.includes(e.rule)),
			unexplained_files: [],
			limitations: [],
		}
	}
	return { findings, evaluation: emptyEvaluation(), unexplained_files: [], limitations: [] }
}

export function emptyEvaluation(): ReviewOutput['evaluation'] {
	return REVIEW_RULES.map((rule) => ({ rule, near_misses: [], why: 'none observed' }))
}
