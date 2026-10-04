import type { ProviderKind, ProviderProtocol } from '../../shared/types.ts'
import { createAnthropicAccount, createAnthropicProvider } from './anthropic.ts'
import { createFakeAccount, createFakeProvider } from './fake.ts'
import { createGeminiAccount, createGeminiProvider } from './gemini.ts'
import { createOpenAIAccount, createOpenAIChatProvider, createOpenAIResponsesProvider } from './openai.ts'
import { outputBudget, ProviderError, type ModelLimits, type ProviderAccount, type ReviewProvider } from './provider.ts'

/** Everything an adapter needs, resolved and fixed by the caller. The secret is passed in, never looked up. */
export interface ResolvedConnection {
	kind: ProviderKind
	label: string
	protocol: ProviderProtocol
	baseUrl: string
	apiKey: string | null
	timeoutMs: number
}

export interface AdapterFactory {
	account(c: ResolvedConnection): ProviderAccount
	provider(c: ResolvedConnection, model: string, limits: ModelLimits): ReviewProvider
}

function requireKey(c: ResolvedConnection): string {
	if (!c.apiKey) throw new ProviderError('auth', `${c.label} needs an API key. Add one in Settings → AI providers.`)
	return c.apiKey
}

/** Maps a connection's protocol to its SDK adapter. This is the only place that knows about concrete providers. */
export const sdkAdapters: AdapterFactory = {
	account(c) {
		switch (c.protocol) {
			case 'openai-responses':
			case 'openai-chat':
				return createOpenAIAccount({ kind: c.kind, label: c.label, baseURL: c.baseUrl, apiKey: c.apiKey, timeoutMs: c.timeoutMs })
			case 'anthropic-messages':
				return createAnthropicAccount({ apiKey: requireKey(c), baseURL: c.baseUrl, timeoutMs: c.timeoutMs })
			case 'gemini-generate':
				return createGeminiAccount({ apiKey: requireKey(c), baseURL: c.baseUrl, timeoutMs: c.timeoutMs })
			case 'fixture':
				return createFakeAccount()
		}
	},
	provider(c, model, limits) {
		const maxOutputTokens = outputBudget(limits)
		switch (c.protocol) {
			case 'openai-responses':
				return createOpenAIResponsesProvider({
					kind: c.kind,
					label: c.label,
					baseURL: c.baseUrl,
					apiKey: c.apiKey,
					timeoutMs: c.timeoutMs,
					model,
					limits,
					maxOutputTokens,
					allowJsonModeFallback: false,
				})
			case 'openai-chat':
				return createOpenAIChatProvider({
					kind: c.kind,
					label: c.label,
					baseURL: c.baseUrl,
					apiKey: c.apiKey,
					timeoutMs: c.timeoutMs,
					model,
					limits,
					maxOutputTokens,
					allowJsonModeFallback: c.kind === 'custom',
				})
			case 'anthropic-messages':
				return createAnthropicProvider({
					apiKey: requireKey(c),
					baseURL: c.baseUrl,
					timeoutMs: c.timeoutMs,
					model,
					limits,
					maxOutputTokens,
				})
			case 'gemini-generate':
				return createGeminiProvider({ apiKey: requireKey(c), baseURL: c.baseUrl, timeoutMs: c.timeoutMs, model, limits, maxOutputTokens })
			case 'fixture':
				return createFakeProvider({ delayMs: 600, model, limits })
		}
	},
}
