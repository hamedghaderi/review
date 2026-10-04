import OpenAI, {
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
} from 'openai'
import type { ChatCompletion, ChatCompletionMessageParam } from 'openai/resources/chat/completions/completions'
import type { ResponseInputItem, Response as OpenAIResponse } from 'openai/resources/responses/responses'
import type { AiUsage, ProviderKind } from '../../shared/types.ts'
import type { ReviewTools } from './lookup.ts'
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
import { REVIEW_JSON_SCHEMA, SCHEMA_NAME } from './schema.ts'

export interface OpenAIClientOptions {
	kind: ProviderKind
	label: string
	baseURL: string
	apiKey: string | null // null = the endpoint needs no authentication
	timeoutMs: number
}

export interface OpenAIModelOptions extends OpenAIClientOptions {
	model: string
	limits: ModelLimits
	maxOutputTokens: number
	/** Chat Completions only: when the endpoint rejects json_schema, fall back to JSON mode (still schema-validated). */
	allowJsonModeFallback: boolean
}

/**
 * Every client option is explicit so the SDK never falls back to OPENAI_* environment variables. A keyless local
 * server gets no Authorization header at all.
 */
function client(o: OpenAIClientOptions): OpenAI {
	return new OpenAI({
		apiKey: o.apiKey ?? 'not-required',
		baseURL: o.baseURL,
		organization: null,
		project: null,
		webhookSecret: null,
		maxRetries: 0,
		timeout: o.timeoutMs,
		logLevel: 'off',
		defaultHeaders: {
			...(o.apiKey ? {} : { Authorization: null }),
			...(o.kind === 'openrouter' ? { 'HTTP-Referer': 'https://github.com/review-app', 'X-Title': 'Review' } : {}),
		},
	})
}

export function createOpenAIAccount(o: OpenAIClientOptions): ProviderAccount {
	const c = client(o)
	return {
		async listModels(signal): Promise<Array<DiscoveredModel>> {
			try {
				if (o.kind === 'openrouter') return await listOpenRouter(c, o, signal)
				const out: Array<DiscoveredModel> = []
				for await (const m of c.models.list({ signal })) {
					// OpenAI omits limits; some compatible gateways (e.g. OmniRoute) report them per model.
					out.push({
						id: m.id,
						label: m.id,
						contextWindow: numberField(m, 'max_input_tokens') ?? numberField(m, 'context_length'),
						maxOutputTokens: numberField(m, 'max_output_tokens'),
						structuredOutput: 'unknown',
					})
					if (out.length >= 2000) break
				}
				return out.sort((a, b) => a.id.localeCompare(b.id))
			} catch (e) {
				throw mapError(e, o.label, o.apiKey)
			}
		},
	}
}

/** OpenRouter: /models is public, so the key is checked separately with /key before listing. */
async function listOpenRouter(c: OpenAI, o: OpenAIClientOptions, signal: AbortSignal): Promise<Array<DiscoveredModel>> {
	await c.get('/key', { signal })
	const res = (await c.get('/models', { signal, query: { supported_parameters: 'structured_outputs' } })) as {
		data?: Array<Record<string, unknown>>
	}
	return (res.data ?? [])
		.map((m) => {
			const top = m.top_provider as Record<string, unknown> | undefined
			return {
				id: String(m.id),
				label: typeof m.name === 'string' ? m.name : String(m.id),
				contextWindow: numberField(m, 'context_length'),
				maxOutputTokens: top ? numberField(top, 'max_completion_tokens') : null,
				structuredOutput: 'yes' as const,
			}
		})
		.filter((m) => m.id && o)
		.sort((a, b) => a.id.localeCompare(b.id))
}

function numberField(o: object, key: string): number | null {
	const v = (o as Record<string, unknown>)[key]
	return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

export function createOpenAIResponsesProvider(o: OpenAIModelOptions): ReviewProvider {
	const c = client(o)
	let toolsRejected: string | null = null // once the endpoint refuses tools, later requests are sent without them
	return {
		id: o.kind,
		label: o.label,
		protocol: 'openai-responses',
		model: o.model,
		fixture: false,
		limits: o.limits,
		async review(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse> {
			const tools = request.tools
			const input: Array<ResponseInputItem> = [{ role: 'user', content: request.input }]
			let usage: AiUsage | null = null
			for (let round = 0; ; round++) {
				const offer = tools && !toolsRejected
				const last = !offer || tools.exhausted() || round + 1 >= maxRounds(tools)
				let response: OpenAIResponse
				try {
					response = await c.responses.create(
						{
							model: o.model,
							instructions: request.instructions,
							input,
							text: {
								format: {
									type: 'json_schema',
									name: request.schema?.name ?? SCHEMA_NAME,
									strict: true,
									schema: request.schema?.json ?? REVIEW_JSON_SCHEMA,
								},
							},
							...(offer
								? {
										tools: tools.definitions.map((t) => ({
											type: 'function' as const,
											name: t.name,
											description: t.description,
											parameters: t.parameters,
											strict: t.strict !== false,
										})),
										tool_choice: last ? ('none' as const) : ('auto' as const),
									}
								: {}),
							max_output_tokens: o.maxOutputTokens,
							store: false,
						},
						{ signal },
					)
				} catch (error) {
					const mapped = mapError(error, o.label, o.apiKey, o.model)
					if (offer && rejectsTools(mapped)) {
						toolsRejected = mapped.message
						continue
					}
					throw mapped
				}
				usage = addUsage(usage, responsesUsage(response))
				const calls = response.output.flatMap((item) => (item.type === 'function_call' ? [item] : []))
				if (offer && !last && response.status === 'completed' && calls.length) {
					// Nothing is stored server-side (store: false), so the calls go back as full items without their ids, which
					// would refer to stored state. Reasoning items cannot be sent back without it and are left out.
					for (const call of calls) {
						const { id: _id, ...item } = call
						input.push(item)
					}
					for (const call of calls) {
						const r = await tools.call(call.name, parseArgs(call.arguments), signal)
						input.push({ type: 'function_call_output', call_id: call.call_id, output: r.error ? `Error: ${r.text}` : r.text })
					}
					continue
				}
				return { ...interpretResponse(response), usage, ...(tools && toolsRejected ? { toolsRejected } : {}) }
			}
		},
	}
}

export function interpretResponse(response: OpenAIResponse): ProviderResponse {
	const usage = responsesUsage(response)
	if (response.status === 'failed')
		throw new ProviderError('server', `The model run failed: ${clip(response.error?.message ?? 'no details')}`)
	if (response.status === 'cancelled') throw new ProviderError('cancelled', 'The response was cancelled')
	const message = response.output.find((item) => item.type === 'message')
	const parts = message && 'content' in message ? message.content : []
	const refusal = parts.find((p) => p.type === 'refusal')
	if (refusal && refusal.type === 'refusal')
		throw new ProviderError('refusal', `The model declined to review this content: ${clip(refusal.refusal)}`)
	if (response.status === 'incomplete') {
		const reason = response.incomplete_details?.reason ?? 'unknown'
		throw new ProviderError(
			'incomplete',
			reason === 'max_output_tokens'
				? 'The response hit the output token limit before finishing (lower the per-request input limit)'
				: `The response is incomplete (${reason})`,
		)
	}
	const text = parts.find((p) => p.type === 'output_text')
	if (!text || text.type !== 'output_text' || !text.text) throw new ProviderError('invalid-output', 'The response contained no output text')
	return { output: parseJson(text.text), usage }
}

function responsesUsage(response: OpenAIResponse): AiUsage | null {
	const u = response.usage
	if (!u) return null
	return {
		inputTokens: u.input_tokens,
		cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0,
		outputTokens: u.output_tokens,
		reasoningTokens: u.output_tokens_details?.reasoning_tokens ?? 0,
		totalTokens: u.total_tokens,
	}
}

/**
 * Chat Completions with `response_format: json_schema` (OpenRouter, Ollama, LM Studio, other compatible servers).
 * If the endpoint rejects json_schema and the fallback is allowed, retries once with JSON mode plus the schema in the
 * prompt; that output goes through the same runtime validation.
 */
export function createOpenAIChatProvider(o: OpenAIModelOptions): ReviewProvider {
	const c = client(o)
	let jsonMode = false
	let toolsRejected: string | null = null // once the endpoint refuses tools, later requests are sent without them
	return {
		id: o.kind,
		label: o.label,
		protocol: 'openai-chat',
		model: o.model,
		fixture: false,
		limits: o.limits,
		async review(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse> {
			const tools = request.tools
			const messages = (useJsonMode: boolean): Array<ChatCompletionMessageParam> => [
				{
					role: 'system',
					content: useJsonMode
						? `${request.instructions}\n\nRespond with a single JSON object that matches this JSON Schema exactly, and nothing else:\n${JSON.stringify(request.schema?.json ?? REVIEW_JSON_SCHEMA)}`
						: request.instructions,
				},
				{ role: 'user', content: request.input },
			]
			const turns: Array<ChatCompletionMessageParam> = [] // assistant tool calls and their results, in order
			const send = async (useJsonMode: boolean, offer: ReviewTools | undefined, last: boolean): Promise<ChatCompletion> =>
				c.chat.completions.create(
					{
						model: o.model,
						messages: [...messages(useJsonMode), ...turns],
						response_format: useJsonMode
							? { type: 'json_object' }
							: {
									type: 'json_schema',
									json_schema: {
										name: request.schema?.name ?? SCHEMA_NAME,
										strict: true,
										schema: request.schema?.json ?? REVIEW_JSON_SCHEMA,
									},
								},
						...(offer
							? {
									tools: offer.definitions.map((t) => ({
										type: 'function' as const,
										function: { name: t.name, description: t.description, parameters: t.parameters },
									})),
									tool_choice: last ? ('none' as const) : ('auto' as const),
								}
							: {}),
						max_tokens: o.maxOutputTokens,
						stream: false,
						...(o.kind === 'openrouter' ? { provider: { require_parameters: true } } : {}),
					} as Parameters<typeof c.chat.completions.create>[0] & { stream: false },
					{ signal },
				)
			let usage: AiUsage | null = null
			for (let round = 0; ; round++) {
				const offer = tools && !toolsRejected ? tools : undefined
				const last = !offer || offer.exhausted() || round + 1 >= maxRounds(tools)
				let completion: ChatCompletion
				try {
					completion = await send(jsonMode, offer, last)
				} catch (error) {
					const mapped = mapError(error, o.label, o.apiKey, o.model)
					if (offer && rejectsTools(mapped)) {
						toolsRejected = mapped.message
						continue
					}
					if (
						!jsonMode &&
						o.allowJsonModeFallback &&
						mapped.kind === 'bad-request' &&
						/response_format|json_schema|schema/i.test(mapped.message)
					) {
						jsonMode = true
						try {
							completion = await send(true, offer, last)
						} catch (e2) {
							throw mapError(e2, o.label, o.apiKey, o.model)
						}
					} else throw mapped
				}
				usage = addUsage(usage, chatUsage(completion))
				const message = completion.choices?.[0]?.message
				const calls = (message?.tool_calls ?? []).flatMap((t) => (t.type === 'function' ? [t] : []))
				if (offer && !last && calls.length) {
					turns.push({ role: 'assistant', content: message?.content ?? null, tool_calls: calls })
					for (const call of calls) {
						const r = await offer.call(call.function.name, parseArgs(call.function.arguments), signal)
						turns.push({ role: 'tool', tool_call_id: call.id, content: r.error ? `Error: ${r.text}` : r.text })
					}
					continue
				}
				const result = { ...interpretChat(completion), usage, ...(tools && toolsRejected ? { toolsRejected } : {}) }
				return jsonMode ? { ...result, jsonFallback: true } : result
			}
		},
	}
}

/** Tool arguments arrive as a JSON string; anything unreadable becomes no arguments, which the tool reports as invalid. */
function parseArgs(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return {}
	}
}

export function interpretChat(completion: ChatCompletion): ProviderResponse {
	const usage = chatUsage(completion)
	const choice = completion.choices?.[0]
	if (!choice) throw new ProviderError('invalid-output', 'The response contained no choices')
	const message = choice.message
	if (message?.refusal) throw new ProviderError('refusal', `The model declined to review this content: ${clip(message.refusal)}`)
	if (choice.finish_reason === 'length') throw new ProviderError('incomplete', 'The response hit the output token limit before finishing')
	if (choice.finish_reason === 'content_filter') throw new ProviderError('refusal', 'The response was stopped by a content filter')
	const text = typeof message?.content === 'string' ? message.content : ''
	if (!text.trim()) throw new ProviderError('invalid-output', 'The response contained no output text')
	return { output: parseJson(text), usage }
}

function chatUsage(completion: ChatCompletion): AiUsage | null {
	const u = completion.usage
	// Gateways that route to Anthropic (OmniRoute, LiteLLM…) may leave cached prompt tokens out of prompt_tokens and
	// report them beside it. Count them, or a cached prompt looks truncated and a valid answer gets discarded.
	const details = (u?.prompt_tokens_details ?? {}) as Record<string, unknown>
	const extra = ['cache_creation_tokens', 'cache_creation_input_tokens', 'cache_read_tokens', 'cache_read_input_tokens']
		.map((k) => (typeof details[k] === 'number' ? (details[k] as number) : 0))
		.reduce((a, b) => a + b, 0)
	const cached = u?.prompt_tokens_details?.cached_tokens ?? 0
	const prompt = u?.prompt_tokens ?? 0
	return u
		? {
				// Some gateways include cached tokens in prompt_tokens, others don't; take whichever total is larger.
				inputTokens: Math.max(prompt, prompt + extra, cached),
				cachedInputTokens: cached,
				outputTokens: u.completion_tokens ?? 0,
				reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
				totalTokens: u.total_tokens ?? 0,
			}
		: null
}

/** Parses model JSON. Tolerates a single fenced block (common with JSON-mode fallbacks), nothing more. */
export function parseJson(text: string): unknown {
	const trimmed = text.trim()
	const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed)
	try {
		return JSON.parse(fenced ? fenced[1] : trimmed)
	} catch {
		throw new ProviderError('invalid-output', 'The response was not valid JSON')
	}
}

function retryAfter(error: APIError): number | null {
	const h = error.headers
	const ms = Number(h?.get?.('retry-after-ms'))
	if (Number.isFinite(ms) && ms > 0) return ms
	const s = Number(h?.get?.('retry-after'))
	return Number.isFinite(s) && s > 0 ? s * 1000 : null
}

/** Maps SDK errors to the app's categories. `label` names the provider; `secret` is scrubbed from any message. */
export function mapError(error: unknown, label = 'OpenAI', secret: string | null = null, model?: string): ProviderError {
	if (error instanceof ProviderError) return error
	const detail = (e: Error): string => clip(scrub(e.message, secret))
	if (error instanceof APIUserAbortError) return new ProviderError('cancelled', 'Request cancelled')
	if (error instanceof APIConnectionTimeoutError) return new ProviderError('timeout', `${label} did not respond before the timeout`)
	if (error instanceof APIConnectionError) return new ProviderError('network', `Could not reach ${label}: ${detail(error)}`)
	if (error instanceof AuthenticationError)
		return new ProviderError('auth', `${label} rejected the API key (401). Replace the key in Settings → AI providers.`)
	if (error instanceof PermissionDeniedError) return new ProviderError('permission', `${label} denied access (403): ${detail(error)}`)
	if (error instanceof RateLimitError) {
		return error.code === 'insufficient_quota'
			? new ProviderError('permission', `The ${label} account has no remaining quota (429 insufficient_quota).`)
			: new ProviderError('rate-limit', `${label} rate limit reached (429)`, retryAfter(error))
	}
	if (error instanceof NotFoundError) {
		return new ProviderError(
			'model-unavailable',
			model
				? `Model "${model}" is not available on ${label} (404): ${detail(error)}`
				: `${label} endpoint not found (404): ${detail(error)}`,
		)
	}
	if (error instanceof BadRequestError) {
		const m = detail(error)
		if (/model.*(not found|does not exist|not available|unknown|invalid)|no such model|not a valid model/i.test(m)) {
			return new ProviderError('model-unavailable', `Model "${model ?? '?'}" is not available on ${label}: ${m}`)
		}
		if (/context|maximum.*tokens|too long|too many tokens/i.test(m))
			return new ProviderError('context-exceeded', `${label}: the request exceeds the model's context window: ${m}`)
		return new ProviderError('bad-request', `${label} rejected the request (400): ${m}`)
	}
	if (error instanceof InternalServerError) return new ProviderError('server', `${label} server error (${error.status})`)
	if (error instanceof APIError) {
		const status = error.status ?? 0
		if (status === 402) return new ProviderError('permission', `${label}: insufficient credits (402): ${detail(error)}`)
		if (status === 408) return new ProviderError('timeout', `${label} timed out (408)`)
		if (status === 413) return new ProviderError('context-exceeded', `${label}: request too large (413)`)
		if (status === 422) return new ProviderError('bad-request', `${label} rejected the request (422): ${detail(error)}`)
		return new ProviderError(status >= 500 ? 'server' : 'bad-request', `${label} error (${status}): ${detail(error)}`)
	}
	if (error instanceof Error && error.name === 'AbortError') return new ProviderError('cancelled', 'Request cancelled')
	return new ProviderError('network', error instanceof Error ? detail(error) : `Unknown ${label} error`)
}
