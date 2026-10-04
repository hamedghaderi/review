import { ApiError, FunctionCallingConfigMode, GoogleGenAI, type Content, type GenerateContentResponse } from '@google/genai'
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

export interface GeminiOptions {
	apiKey: string
	baseURL: string
	timeoutMs: number
}

const LABEL = 'Google Gemini'

/** Gemini API (not Vertex): explicit key, base URL and `vertexai: false`, so GOOGLE_* variables are not consulted. */
function client(o: GeminiOptions): GoogleGenAI {
	return new GoogleGenAI({
		apiKey: o.apiKey,
		vertexai: false,
		httpOptions: { baseUrl: o.baseURL, timeout: o.timeoutMs, retryOptions: { attempts: 1 } },
	})
}

export function createGeminiAccount(o: GeminiOptions): ProviderAccount {
	const c = client(o)
	return {
		async listModels(signal): Promise<Array<DiscoveredModel>> {
			try {
				const out: Array<DiscoveredModel> = []
				const pager = await c.models.list({ config: { pageSize: 100, abortSignal: signal } })
				for await (const m of pager) {
					if (!m.name || !(m.supportedActions ?? []).includes('generateContent')) continue
					const id = m.name.replace(/^models\//, '')
					out.push({
						id,
						label: m.displayName || id,
						contextWindow: m.inputTokenLimit ?? null,
						maxOutputTokens: m.outputTokenLimit ?? null,
						structuredOutput: 'unknown',
					})
					if (out.length >= 500) break
				}
				return out.sort((a, b) => a.id.localeCompare(b.id))
			} catch (e) {
				throw mapGeminiError(e, o.apiKey)
			}
		},
	}
}

export function createGeminiProvider(o: GeminiOptions & { model: string; limits: ModelLimits; maxOutputTokens: number }): ReviewProvider {
	const c = client(o)
	let toolsRejected: string | null = null // once the model refuses tools (e.g. with JSON output), later requests are sent without them
	return {
		id: 'gemini',
		label: LABEL,
		protocol: 'gemini-generate',
		model: o.model,
		fixture: false,
		limits: o.limits,
		async review(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse> {
			const tools = request.tools
			const contents: Array<Content> = [{ role: 'user', parts: [{ text: request.input }] }]
			let usage: AiUsage | null = null
			for (let round = 0; ; round++) {
				const offer = tools && !toolsRejected
				const last = !offer || tools.exhausted() || round + 1 >= maxRounds(tools)
				let response: GenerateContentResponse
				try {
					response = await c.models.generateContent({
						model: o.model,
						contents,
						config: {
							systemInstruction: request.instructions,
							responseMimeType: 'application/json',
							responseJsonSchema: request.schema?.json ?? REVIEW_JSON_SCHEMA,
							maxOutputTokens: o.maxOutputTokens,
							abortSignal: signal,
							...(offer
								? {
										tools: [
											{
												functionDeclarations: tools.definitions.map((t) => ({
													name: t.name,
													description: t.description,
													parametersJsonSchema: t.parameters,
												})),
											},
										],
										toolConfig: {
											functionCallingConfig: { mode: last ? FunctionCallingConfigMode.NONE : FunctionCallingConfigMode.AUTO },
										},
									}
								: {}),
						},
					})
				} catch (e) {
					if (signal.aborted) throw new ProviderError('cancelled', 'Request cancelled')
					const mapped = mapGeminiError(e, o.apiKey, o.model)
					if (offer && rejectsTools(mapped)) {
						toolsRejected = mapped.message
						continue
					}
					throw mapped
				}
				usage = addUsage(usage, geminiUsage(response))
				const calls = response.functionCalls ?? []
				const content = response.candidates?.[0]?.content
				if (offer && !last && calls.length && content) {
					// The model's turn goes back unchanged (it carries thought signatures), followed by one response per call.
					contents.push(content)
					const parts = []
					for (const call of calls) {
						const r = await tools.call(call.name ?? '', call.args ?? {}, signal)
						parts.push({ functionResponse: { id: call.id, name: call.name, response: r.error ? { error: r.text } : { output: r.text } } })
					}
					contents.push({ role: 'user', parts })
					continue
				}
				return { ...interpretGemini(response), usage, ...(tools && toolsRejected ? { toolsRejected } : {}) }
			}
		},
	}
}

function geminiUsage(response: GenerateContentResponse): AiUsage | null {
	const u = response.usageMetadata
	return u
		? {
				inputTokens: u.promptTokenCount ?? 0,
				cachedInputTokens: u.cachedContentTokenCount ?? 0,
				outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
				reasoningTokens: u.thoughtsTokenCount ?? 0,
				totalTokens: u.totalTokenCount ?? 0,
			}
		: null
}

export function interpretGemini(response: GenerateContentResponse): ProviderResponse {
	const usage = geminiUsage(response)
	const blocked = response.promptFeedback?.blockReason
	if (blocked) throw new ProviderError('refusal', `Gemini blocked the request (${blocked})`)
	const candidate = response.candidates?.[0]
	if (!candidate) throw new ProviderError('invalid-output', 'The response contained no candidates')
	const reason = candidate.finishReason
	if (reason === 'MAX_TOKENS') throw new ProviderError('incomplete', 'The response hit the output token limit before finishing')
	if (reason && reason !== 'STOP') throw new ProviderError('refusal', `Gemini stopped the response (${reason})`)
	const text = (candidate.content?.parts ?? [])
		.filter((p) => !p.thought && typeof p.text === 'string')
		.map((p) => p.text)
		.join('')
	if (!text.trim()) throw new ProviderError('invalid-output', 'The response contained no output text')
	try {
		return { output: JSON.parse(text), usage }
	} catch {
		throw new ProviderError('invalid-output', 'The response was not valid JSON')
	}
}

export function mapGeminiError(error: unknown, secret: string | null, model?: string): ProviderError {
	if (error instanceof ProviderError) return error
	const detail = (e: Error): string => clip(scrub(e.message, secret))
	if (error instanceof Error && error.name === 'AbortError') return new ProviderError('cancelled', 'Request cancelled')
	if (error instanceof ApiError) {
		const m = detail(error)
		const s = error.status
		if (s === 400 && /API key not valid|API_KEY_INVALID/i.test(m))
			return new ProviderError('auth', `${LABEL} rejected the API key. Replace the key in Settings → AI providers.`)
		if (s === 401) return new ProviderError('auth', `${LABEL} rejected the API key (401). Replace the key in Settings → AI providers.`)
		if (s === 403) return new ProviderError('permission', `${LABEL} denied access (403): ${m}`)
		if (s === 404) return new ProviderError('model-unavailable', `Model "${model ?? '?'}" is not available on ${LABEL} (404)`)
		if (s === 429)
			return new ProviderError(
				/quota|billing/i.test(m) && /exceeded your current quota/i.test(m) ? 'permission' : 'rate-limit',
				`${LABEL}: ${m}`,
			)
		if (s === 400 && /token count|exceeds the maximum number of tokens|too long/i.test(m))
			return new ProviderError('context-exceeded', `${LABEL}: ${m}`)
		if (s === 408 || s === 504) return new ProviderError('timeout', `${LABEL} timed out (${s})`)
		if (s >= 500) return new ProviderError('server', `${LABEL} server error (${s})`)
		return new ProviderError('bad-request', `${LABEL} rejected the request (${s}): ${m}`)
	}
	if (error instanceof Error && /timed? ?out|timeout/i.test(error.message))
		return new ProviderError('timeout', `${LABEL} did not respond before the timeout`)
	return new ProviderError('network', error instanceof Error ? `Could not reach ${LABEL}: ${detail(error)}` : `Unknown ${LABEL} error`)
}
