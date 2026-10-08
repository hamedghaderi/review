import type { EndpointPreset, ProviderDescriptor, ProviderKind } from '../../shared/types.ts'

/**
 * Maintained list of models offered before discovery succeeds, or where discovery is unavailable. Entries are
 * suggestions only: they are labelled "Catalog" in the UI until the provider's model list confirms account access.
 * Update CATALOG_UPDATED when this list changes.
 */
export const CATALOG_UPDATED = '2026-10-08'

export interface CatalogModel {
	id: string
	label: string
	contextWindow: number
	maxOutputTokens: number
}

export const MODEL_CATALOG: Partial<Record<ProviderKind, Array<CatalogModel>>> = {
	openai: [
		{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', contextWindow: 1_050_000, maxOutputTokens: 128_000 },
		{ id: 'gpt-6-astra', label: 'GPT-6 Astra', contextWindow: 1_050_000, maxOutputTokens: 128_000 },
		{ id: 'gpt-6-luna', label: 'GPT-6 Luna', contextWindow: 400_000, maxOutputTokens: 128_000 },
	],
	anthropic: [
		{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5', contextWindow: 1_000_000, maxOutputTokens: 128_000 },
		{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', contextWindow: 1_000_000, maxOutputTokens: 128_000 },
		{ id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', contextWindow: 1_000_000, maxOutputTokens: 128_000 },
	],
	gemini: [
		{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', contextWindow: 1_048_576, maxOutputTokens: 65_536 },
		{ id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (preview)', contextWindow: 1_048_576, maxOutputTokens: 65_536 },
		{ id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', contextWindow: 1_048_576, maxOutputTokens: 65_536 },
	],
	fixture: [{ id: 'fixture-v1', label: 'Fixture v1', contextWindow: 200_000, maxOutputTokens: 32_000 }],
}

const LOCAL_PRESETS: Array<EndpointPreset> = [
	{
		id: 'ollama',
		label: 'Ollama (local)',
		baseUrl: 'http://localhost:11434/v1',
		protocol: 'openai-chat',
		auth: 'none',
		contextWindow: 8192,
		note: null,
	},
	{
		id: 'lmstudio',
		label: 'LM Studio (local)',
		baseUrl: 'http://localhost:1234/v1',
		protocol: 'openai-chat',
		auth: 'none',
		contextWindow: 8192,
		note: null,
	},
	{
		id: 'omniroute',
		label: 'OmniRoute (local)',
		baseUrl: 'http://localhost:20128/v1',
		protocol: 'openai-chat',
		auth: 'api-key',
		contextWindow: null,
		note: 'OmniRoute routes to the providers configured in its own dashboard; use an API key created there, or choose “None” if your OmniRoute does not require keys. Its model list is public, so “Test connection” confirms the gateway is reachable but not that the key is accepted. Use “Test model” to check a model end to end.',
	},
	{
		id: 'generic',
		label: 'Other OpenAI-compatible endpoint',
		baseUrl: 'https://',
		protocol: 'openai-chat',
		auth: 'api-key',
		contextWindow: 32_768,
		note: null,
	},
]

const LIST_MODELS = 'Test connection lists the models this key can use. It does not send any review content or run inference.'

export const PROVIDERS: Array<ProviderDescriptor> = [
	{
		kind: 'openai',
		label: 'OpenAI',
		description: 'Responses API with strict structured output.',
		authMethods: ['api-key'],
		multiple: false,
		endpointEditable: false,
		defaultBaseUrl: 'https://api.openai.com/v1',
		protocols: [{ protocol: 'openai-responses', label: 'Responses API' }],
		presets: [],
		keyPlaceholder: 'sk-…',
		keyHelpUrl: 'https://platform.openai.com/api-keys',
		testExplains: LIST_MODELS,
		contextWindowEditable: false,
		development: false,
	},
	{
		kind: 'anthropic',
		label: 'Anthropic',
		description: 'Messages API with JSON-schema output.',
		authMethods: ['api-key'],
		multiple: false,
		endpointEditable: false,
		defaultBaseUrl: 'https://api.anthropic.com',
		protocols: [{ protocol: 'anthropic-messages', label: 'Messages API' }],
		presets: [],
		keyPlaceholder: 'sk-ant-…',
		keyHelpUrl: 'https://platform.claude.com/settings/keys',
		testExplains: LIST_MODELS,
		contextWindowEditable: false,
		development: false,
	},
	{
		kind: 'gemini',
		label: 'Google Gemini',
		description: 'Gemini API generateContent with a response JSON schema.',
		authMethods: ['api-key'],
		multiple: false,
		endpointEditable: false,
		defaultBaseUrl: 'https://generativelanguage.googleapis.com',
		protocols: [{ protocol: 'gemini-generate', label: 'generateContent' }],
		presets: [],
		keyPlaceholder: 'AIza…',
		keyHelpUrl: 'https://aistudio.google.com/apikey',
		testExplains: LIST_MODELS,
		contextWindowEditable: false,
		development: false,
	},
	{
		kind: 'openrouter',
		label: 'OpenRouter',
		description: 'Chat Completions with JSON-schema output, routed only to endpoints that support it.',
		authMethods: ['api-key'],
		multiple: false,
		endpointEditable: false,
		defaultBaseUrl: 'https://openrouter.ai/api/v1',
		protocols: [{ protocol: 'openai-chat', label: 'Chat Completions' }],
		presets: [],
		keyPlaceholder: 'sk-or-…',
		keyHelpUrl: 'https://openrouter.ai/settings/keys',
		testExplains: 'Test connection checks the key with OpenRouter and loads the model list. It does not run inference.',
		contextWindowEditable: false,
		development: false,
	},
	{
		kind: 'custom',
		label: 'OpenAI-compatible',
		description: 'Local servers and gateways (Ollama, LM Studio, OmniRoute) or any OpenAI-compatible endpoint.',
		authMethods: ['none', 'api-key'],
		multiple: true,
		endpointEditable: true,
		defaultBaseUrl: null,
		protocols: [
			{ protocol: 'openai-chat', label: 'Chat Completions (/chat/completions)' },
			{ protocol: 'openai-responses', label: 'Responses (/responses)' },
		],
		presets: LOCAL_PRESETS,
		keyPlaceholder: 'API key, if the server requires one',
		keyHelpUrl: null,
		testExplains:
			'Test connection requests the /models list from this endpoint. It does not run inference; use "Test model" to send a tiny synthetic request that checks structured output.',
		contextWindowEditable: true,
		development: false,
	},
	{
		kind: 'fixture',
		label: 'Fixture provider',
		description: 'Deterministic sample findings for development and tests. Nothing leaves this computer.',
		authMethods: ['none'],
		multiple: false,
		endpointEditable: false,
		defaultBaseUrl: 'fixture://local',
		protocols: [{ protocol: 'fixture', label: 'Fixture' }],
		presets: [],
		keyPlaceholder: '',
		keyHelpUrl: null,
		testExplains: 'The fixture provider is always available.',
		contextWindowEditable: false,
		development: true,
	},
]

export function descriptor(kind: ProviderKind): ProviderDescriptor {
	const d = PROVIDERS.find((p) => p.kind === kind)
	if (!d) throw new Error(`Unknown provider ${kind}`)
	return d
}
