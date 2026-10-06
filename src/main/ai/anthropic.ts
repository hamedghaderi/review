import Anthropic, {
	APIConnectionError,
	APIConnectionTimeoutError,
	APIError,
	APIUserAbortError,
	AuthenticationError,
	BadRequestError,
	InternalServerError,
	NotFoundError,
	PermissionDeniedError,
	RateLimitError,
} from '@anthropic-ai/sdk'
import type { Message, MessageParam, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages/messages'
import type { AiUsage } from '../../shared/types.ts'
import {
	addUsage,
	clip,
	maxRounds,
	ProviderError,
	rejectsTools,
	scrub,
	type DiscoveredModel,
	type ModelLimits,
	type ProviderAccount,
	type ProviderRequest,
	type ProviderResponse,
	type ReviewProvider,
} from './provider.ts'
import { REVIEW_JSON_SCHEMA } from './schema.ts'

export interface AnthropicOptions {
	apiKey: string
	baseURL: string
	timeoutMs: number
}

const LABEL = 'Anthropic'

/** Explicit key, token and base URL so the SDK never resolves ANTHROPIC_* variables or profile files. */
function client(o: AnthropicOptions): Anthropic {
	return new Anthropic({ apiKey: o.apiKey, authToken: null, baseURL: o.baseURL, maxRetries: 0, timeout: o.timeoutMs, logLevel: 'off' })
}

export function createAnthropicAccount(o: AnthropicOptions): ProviderAccount {
	const c = client(o)
	return {
		async listModels(signal): Promise<Array<DiscoveredModel>> {
			try {
				const out: Array<DiscoveredModel> = []
				for await (const m of c.models.list({ limit: 100 }, { signal })) {
					out.push({
						id: m.id,
						label: m.display_name || m.id,
						contextWindow: m.max_input_tokens ?? null,
						maxOutputTokens: m.max_tokens ?? null,
						structuredOutput: m.capabilities ? (m.capabilities.structured_outputs?.supported ? 'yes' : 'no') : 'unknown',
					})
					if (out.length >= 500) break
				}
				return out
			} catch (e) {
				throw mapAnthropicError(e, o.apiKey)
			}
		},
	}
}

export function createAnthropicProvider(
	o: AnthropicOptions & { model: string; limits: ModelLimits; maxOutputTokens: number },
): ReviewProvider {
	const c = client(o)
	let toolsRejected: string | null = null // once the endpoint refuses tools, later requests are sent without them
	return {
		id: 'anthropic',
		label: LABEL,
		protocol: 'anthropic-messages',
		model: o.model,
		fixture: false,
		limits: o.limits,
		async review(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse> {
			const tools = request.tools
			const messages: Array<MessageParam> = [
				{
					role: 'user',
					content: request.images?.length
						? [
								{ type: 'text', text: request.input },
								...request.images.map((i) => ({
									type: 'image' as const,
									source: { type: 'base64' as const, media_type: i.mediaType, data: i.data },
								})),
							]
						: request.input,
				},
			]
			let usage: AiUsage | null = null
			for (let round = 0; ; round++) {
				const offer = tools && !toolsRejected
				const last = !offer || tools.exhausted() || round + 1 >= maxRounds(tools)
				let message: Message
				try {
					message = await c.messages.create(
						{
							model: o.model,
							max_tokens: o.maxOutputTokens,
							system: request.instructions,
							messages,
							output_config: { format: { type: 'json_schema', schema: request.schema?.json ?? REVIEW_JSON_SCHEMA } },
							// Every round resends the conversation, so the cached prefix is read back instead of paid in full.
							...(offer
								? {
										tools: tools.definitions.map((t) => ({
											name: t.name,
											description: t.description,
											input_schema: t.parameters as { type: 'object' },
										})),
										tool_choice: { type: last ? 'none' : 'auto' } as const,
										cache_control: { type: 'ephemeral' } as const,
									}
								: {}),
							stream: false,
						},
						{ signal, timeout: o.timeoutMs },
					)
				} catch (e) {
					const mapped = mapAnthropicError(e, o.apiKey, o.model)
					if (offer && rejectsTools(mapped)) {
						toolsRejected = mapped.message
						continue
					}
					throw mapped
				}
				usage = addUsage(usage, usageOf(message))
				const calls = message.content.flatMap((b) => (b.type === 'tool_use' ? [b] : []))
				if (offer && !last && message.stop_reason === 'tool_use' && calls.length) {
					// The whole reply goes back unchanged, thinking blocks included, followed by one result per call.
					messages.push({ role: 'assistant', content: message.content })
					const results: Array<ToolResultBlockParam> = []
					for (const b of calls) {
						const r = await tools.call(b.name, b.input, signal)
						results.push({ type: 'tool_result', tool_use_id: b.id, content: r.text, is_error: r.error })
					}
					messages.push({ role: 'user', content: results })
					continue
				}
				return { ...interpretMessage(message), usage, ...(tools && toolsRejected ? { toolsRejected } : {}) }
			}
		},
	}
}

function usageOf(message: Message): AiUsage | null {
	const u = message.usage
	return u
		? {
				inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
				cachedInputTokens: u.cache_read_input_tokens ?? 0,
				outputTokens: u.output_tokens ?? 0,
				reasoningTokens: 0,
				totalTokens: 0,
			}
		: null
}

export function interpretMessage(message: Message): ProviderResponse {
	const usage = usageOf(message)
	if (message.stop_reason === 'refusal') throw new ProviderError('refusal', 'The model declined to review this content')
	if (message.stop_reason === 'max_tokens')
		throw new ProviderError('incomplete', 'The response hit the output token limit before finishing')
	if (message.stop_reason === 'model_context_window_exceeded')
		throw new ProviderError('context-exceeded', "The request exceeded the model's context window")
	const text = message.content
		.filter((b) => b.type === 'text')
		.map((b) => (b.type === 'text' ? b.text : ''))
		.join('')
	if (!text.trim()) throw new ProviderError('invalid-output', 'The response contained no output text')
	try {
		return { output: JSON.parse(text), usage }
	} catch {
		throw new ProviderError('invalid-output', 'The response was not valid JSON')
	}
}

function retryAfter(error: APIError): number | null {
	const s = Number(error.headers?.get?.('retry-after'))
	return Number.isFinite(s) && s > 0 ? s * 1000 : null
}

export function mapAnthropicError(error: unknown, secret: string | null, model?: string): ProviderError {
	if (error instanceof ProviderError) return error
	const detail = (e: Error): string => clip(scrub(e.message, secret))
	if (error instanceof APIUserAbortError) return new ProviderError('cancelled', 'Request cancelled')
	if (error instanceof APIConnectionTimeoutError) return new ProviderError('timeout', `${LABEL} did not respond before the timeout`)
	if (error instanceof APIConnectionError) return new ProviderError('network', `Could not reach ${LABEL}: ${detail(error)}`)
	if (error instanceof AuthenticationError)
		return new ProviderError('auth', `${LABEL} rejected the API key (401). Replace the key in Settings → AI providers.`)
	if (error instanceof PermissionDeniedError) return new ProviderError('permission', `${LABEL} denied access (403): ${detail(error)}`)
	if (error instanceof RateLimitError) return new ProviderError('rate-limit', `${LABEL} rate limit reached (429)`, retryAfter(error))
	if (error instanceof NotFoundError)
		return new ProviderError('model-unavailable', `Model "${model ?? '?'}" is not available on ${LABEL} (404)`)
	if (error instanceof BadRequestError) {
		const m = detail(error)
		if (/prompt is too long|context window|too many tokens/i.test(m)) return new ProviderError('context-exceeded', `${LABEL}: ${m}`)
		if (/model/i.test(m) && /not found|invalid|does not support|not supported/i.test(m))
			return new ProviderError('model-unavailable', `${LABEL}: ${m}`)
		return new ProviderError('bad-request', `${LABEL} rejected the request (400): ${m}`)
	}
	if (error instanceof InternalServerError) {
		return error.status === 529
			? new ProviderError('rate-limit', `${LABEL} is overloaded (529)`)
			: new ProviderError('server', `${LABEL} server error (${error.status})`)
	}
	if (error instanceof APIError) {
		const status = error.status ?? 0
		if (status === 413) return new ProviderError('context-exceeded', `${LABEL}: request too large (413)`)
		return new ProviderError(status >= 500 ? 'server' : 'bad-request', `${LABEL} error (${status}): ${detail(error)}`)
	}
	if (error instanceof Error && error.name === 'AbortError') return new ProviderError('cancelled', 'Request cancelled')
	return new ProviderError('network', error instanceof Error ? detail(error) : `Unknown ${LABEL} error`)
}
