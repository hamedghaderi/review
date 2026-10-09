import type { AiUsage, ContextImageType, ProviderKind, ProviderProtocol } from '../../shared/types.ts'
import type { ContextBatch } from './context.ts'
import type { ReviewTools } from './lookup.ts'

export interface ProviderRequest {
	instructions: string
	input: string
	batch: ContextBatch
	/** The output contract; the review findings schema when absent. */
	schema?: { name: string; json: Record<string, unknown> }
	/** Read-only lookups the model may call before answering; the provider runs the calls and sends the results back. */
	tools?: ReviewTools
	/** Images sent after the text, in order; the text names them. */
	images?: Array<RequestImage>
}

export interface RequestImage {
	name: string
	mediaType: ContextImageType
	data: string // base64
}

export const dataUrl = (i: RequestImage): string => `data:${i.mediaType};base64,${i.data}`

export interface ProviderResponse {
	output: unknown // parsed JSON, validated by the runner against the findings schema
	usage: AiUsage | null
	jsonFallback?: boolean // true when the endpoint lacked native structured output and JSON mode was used
	toolsRejected?: string // set when the endpoint refused the lookup tools and the request was answered without them
}

export interface DiscoveredModel {
	id: string
	label: string
	contextWindow: number | null
	maxOutputTokens: number | null
	structuredOutput: 'yes' | 'no' | 'unknown'
}

/** What a provider can tell us about its limits for one model, used to size review batches. */
export interface ModelLimits {
	contextWindow: number // tokens
	maxOutputTokens: number
}

/**
 * One review request path per protocol. Implementations receive an explicit, fixed configuration (model, endpoint,
 * credential) when created and never read ambient environment variables.
 */
export interface ReviewProvider {
	id: ProviderKind
	label: string
	protocol: ProviderProtocol
	model: string
	fixture: boolean
	limits: ModelLimits
	review(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse>
}

/** Account-level operations used by settings: listing models without running inference. */
export interface ProviderAccount {
	listModels(signal: AbortSignal): Promise<Array<DiscoveredModel>>
}

export type ProviderErrorKind =
	| 'auth'
	| 'permission'
	| 'rate-limit'
	| 'timeout'
	| 'network'
	| 'server'
	| 'bad-request'
	| 'model-unavailable'
	| 'context-exceeded'
	| 'refusal'
	| 'incomplete'
	| 'invalid-output'
	| 'unsupported'
	| 'cancelled'

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set(['rate-limit', 'timeout', 'network', 'server'])
const FATAL: ReadonlySet<ProviderErrorKind> = new Set(['auth', 'permission', 'bad-request', 'model-unavailable', 'unsupported'])

export class ProviderError extends Error {
	kind: ProviderErrorKind
	retryAfterMs: number | null

	constructor(kind: ProviderErrorKind, message: string, retryAfterMs: number | null = null) {
		super(redactSecrets(message))
		this.kind = kind
		this.retryAfterMs = retryAfterMs
	}

	get retryable(): boolean {
		return RETRYABLE.has(this.kind)
	}

	/** Errors that will fail every remaining batch the same way, so the run should stop scheduling. */
	get fatal(): boolean {
		return FATAL.has(this.kind)
	}
}

/** Removes anything that looks like an API key or bearer token from text that may be stored or shown. */
export function redactSecrets(text: string): string {
	return text
		.replace(/\b(sk|sess|org|proj|sk-ant|sk-or)-[A-Za-z0-9_*\-]{6,}/g, '$1-…')
		.replace(/\bAIza[0-9A-Za-z_\-]{10,}/g, 'AIza…')
		.replace(/Bearer\s+\S+/gi, 'Bearer …')
		.replace(/([?&](key|api_key|apikey|token)=)[^&\s]+/gi, '$1…')
}

/** Removes a specific secret from text before it is stored, displayed or logged. */
export function scrub(text: string, secret: string | null): string {
	const t = secret && secret.length >= 4 ? text.split(secret).join('…') : text
	return redactSecrets(t)
}

/** Output tokens requested per review call: enough for many findings, never more than the model allows. */
export function outputBudget(limits: ModelLimits): number {
	return Math.max(1024, Math.min(limits.maxOutputTokens, 32_000, Math.floor(limits.contextWindow / 4)))
}

/**
 * Ends a lookup conversation on the last round. Claude models (directly or through gateways) reply with nothing when
 * the conversation ends on tool results and tools are switched off; asking for the answer makes them write it.
 */
export const FINAL_ANSWER = 'No more lookups. Answer now with the JSON only.'

/** Most rounds of a lookup conversation: one per call at most, plus the final answer. */
export function maxRounds(tools: ReviewTools | undefined): number {
	return tools ? 20 : 1
}

/**
 * A rejected request that names tools or function calling: the endpoint or model does not take them, so the request is
 * sent again without. Adapters class "… not supported by this model" as an unavailable model; with tools named, it is not.
 */
export function rejectsTools(error: ProviderError): boolean {
	return (
		(error.kind === 'bad-request' || error.kind === 'model-unavailable') &&
		/\btools?\b|tool_choice|function[ _-]?call|functionDeclarations|function_declarations/i.test(error.message)
	)
}

export function addUsage(total: AiUsage | null, u: AiUsage | null): AiUsage | null {
	if (!u) return total
	if (!total) return { ...u, totalTokens: u.totalTokens || u.inputTokens + u.outputTokens }
	return {
		inputTokens: total.inputTokens + u.inputTokens,
		cachedInputTokens: total.cachedInputTokens + u.cachedInputTokens,
		outputTokens: total.outputTokens + u.outputTokens,
		reasoningTokens: total.reasoningTokens + u.reasoningTokens,
		totalTokens: total.totalTokens + (u.totalTokens || u.inputTokens + u.outputTokens),
	}
}

export function clip(s: string, n = 300): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s
}
