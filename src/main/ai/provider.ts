import type { AiUsage, ContextImageType, ModelPrice, PricedModel, ProviderKind, ProviderProtocol } from '../../shared/types.ts'
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
	price?: ModelPrice | null // what the provider's listing says the model costs (OpenRouter)
	root?: string | null // the model a gateway routes this one to, when its listing says (OmniRoute)
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
	price?: PricedModel | null // captured with the configuration; null or absent: unknown, so the cost isn't counted
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
	| 'quota' // a plan's usage limit (a CLI's subscription): retrying won't help until it resets; retryAfterMs is the wait, when known
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
const FATAL: ReadonlySet<ProviderErrorKind> = new Set(['auth', 'permission', 'bad-request', 'model-unavailable', 'unsupported', 'quota'])

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

/**
 * Parses a model's JSON answer. With structured output enforced it is the object alone, but a gateway that passes the
 * schema on without enforcing it lets some models wrap it: in a ```json fence, or after a few sentences of summary
 * written for a person. The object is then taken from a fenced block (the last one that parses), or else from the
 * first "{" to the last "}". Text around it is dropped; the schema check that follows decides whether it is an answer.
 */
export function parseJson(text: string): unknown {
	const trimmed = text.trim()
	const fenced = [...trimmed.matchAll(/```[\w-]*[ \t]*\n([\s\S]*?)\n[ \t]*```/g)].map((m) => m[1]).reverse()
	const from = trimmed.indexOf('{')
	const to = trimmed.lastIndexOf('}')
	for (const t of [trimmed, ...fenced, ...(from >= 0 && to > from ? [trimmed.slice(from, to + 1)] : [])]) {
		try {
			return JSON.parse(t)
		} catch {
			// next candidate
		}
	}
	const start = trimmed.slice(0, 60).replace(/\s+/g, ' ')
	throw new ProviderError('invalid-output', `The response was not valid JSON (it starts: "${start}${trimmed.length > 60 ? '…' : ''}")`)
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
		...(total.cacheWriteTokens !== undefined || u.cacheWriteTokens !== undefined
			? { cacheWriteTokens: (total.cacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0) }
			: {}),
		outputTokens: total.outputTokens + u.outputTokens,
		reasoningTokens: total.reasoningTokens + u.reasoningTokens,
		totalTokens: total.totalTokens + (u.totalTokens || u.inputTokens + u.outputTokens),
	}
}

export function clip(s: string, n = 300): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s
}
