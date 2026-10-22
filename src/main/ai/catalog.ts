import type { EndpointPreset, ModelPrice, ProviderDescriptor, ProviderKind } from '../../shared/types.ts'

/**
 * Maintained list of models offered before discovery succeeds, or where discovery is unavailable. Entries are
 * suggestions only: they are labelled "Catalog" in the UI until the provider's model list confirms account access.
 * Prices are list prices in US dollars per million tokens at the standard tier, for prompts under the long-context
 * threshold, as published on CATALOG_UPDATED; they are shown as estimates. Update CATALOG_UPDATED when this list changes.
 */
export const CATALOG_UPDATED = '2026-10-08'

export interface CatalogModel {
	id: string
	label: string
	contextWindow: number
	maxOutputTokens: number
	price: ModelPrice | null
	efforts?: Array<string> // a CLI model that takes fewer effort levels than its CLI does; absent: all of them
}

const price = (input: number, cachedInput: number, output: number, cacheWrite: number | null = null): ModelPrice => ({
	input,
	cachedInput,
	cacheWrite,
	output,
})

export const MODEL_CATALOG: Partial<Record<ProviderKind, Array<CatalogModel>>> = {
	openai: [
		{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', contextWindow: 1_050_000, maxOutputTokens: 128_000, price: price(2, 0.1, 10, 2.5) },
		{ id: 'gpt-6-astra', label: 'GPT-6 Astra', contextWindow: 1_050_000, maxOutputTokens: 128_000, price: price(10, 1, 50, 12.5) },
		{ id: 'gpt-6-luna', label: 'GPT-6 Luna', contextWindow: 400_000, maxOutputTokens: 128_000, price: price(0.1, 0.01, 0.5, 0.125) },
	],
	anthropic: [
		{
			id: 'claude-fable-5-1',
			label: 'Claude Fable 5.1',
			contextWindow: 1_000_000,
			maxOutputTokens: 128_000,
			price: price(10, 0.25, 50, 12.5),
		},
		{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5', contextWindow: 1_000_000, maxOutputTokens: 128_000, price: price(4, 0.2, 20, 5) },
		{
			id: 'claude-sonnet-5-5',
			label: 'Claude Sonnet 5.5',
			contextWindow: 1_000_000,
			maxOutputTokens: 128_000,
			price: price(2, 0.1, 10, 2.5),
		},
		{
			id: 'claude-haiku-5-5',
			label: 'Claude Haiku 5.5',
			contextWindow: 1_000_000,
			maxOutputTokens: 128_000,
			price: price(0.1, 0.01, 0.5, 0.125),
		},
	],
	// Gemini 3.8 Flash doubles in price from 2027-01-01.
	gemini: [
		{
			id: 'gemini-3.8-flash',
			label: 'Gemini 3.8 Flash',
			contextWindow: 1_048_576,
			maxOutputTokens: 65_536,
			price: price(0.75, 0.075, 3.75),
		},
		{
			id: 'gemini-3.1-pro-preview',
			label: 'Gemini 3.1 Pro (preview)',
			contextWindow: 1_048_576,
			maxOutputTokens: 65_536,
			price: price(2, 0.2, 12),
		},
		{
			id: 'gemini-3.5-flash-lite',
			label: 'Gemini 3.5 Flash-Lite',
			contextWindow: 1_048_576,
			maxOutputTokens: 65_536,
			price: price(0.3, 0.03, 2.5),
		},
	],
	// The models Claude Code offers on a Claude plan. No price: it counts against the plan's limits, not per token.
	'claude-code': [
		{ id: 'claude-fable-5-1', label: 'Claude Fable 5.1', contextWindow: 1_000_000, maxOutputTokens: 128_000, price: null },
		{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5', contextWindow: 1_000_000, maxOutputTokens: 128_000, price: null },
		{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', contextWindow: 1_000_000, maxOutputTokens: 128_000, price: null },
		{ id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', contextWindow: 1_000_000, maxOutputTokens: 128_000, price: null },
	],
	// The models Codex offers with a ChatGPT login, from its own model list (2026-10-22). No price, as for Claude Code.
	codex: [
		{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', contextWindow: 500_000, maxOutputTokens: 128_000, price: null },
		{ id: 'gpt-6-sol', label: 'GPT-6 Sol', contextWindow: 272_000, maxOutputTokens: 128_000, price: null },
		{ id: 'gpt-6-astra', label: 'GPT-6 Astra', contextWindow: 272_000, maxOutputTokens: 128_000, price: null },
		// No "ultra": Codex accepts it for Luna without a word and runs some other effort.
		{
			id: 'gpt-6-luna',
			label: 'GPT-6 Luna',
			contextWindow: 272_000,
			maxOutputTokens: 128_000,
			price: null,
			efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
		},
	],
	fixture: [{ id: 'fixture-v1', label: 'Fixture v1', contextWindow: 200_000, maxOutputTokens: 32_000, price: price(0, 0, 0) }],
}

// What gateways add to a model's name: effort ("-high"), thinking, and context size ("-500k").
const VARIANT = /-(?:none|minimal|low|medium|high|xhigh|max|thinking|\d+k)$/

/** The model's own name, without a gateway's provider prefix or variant suffix; dots and dashes compare equal. */
function bareName(id: string): string {
	let s = id.slice(id.lastIndexOf('/') + 1).toLowerCase()
	while (VARIANT.test(s)) s = s.replace(VARIANT, '')
	return s.replace(/\./g, '-')
}

/** The catalog model a gateway's model is named after, of any provider; null when none matches exactly. */
export function catalogMatch(id: string | null): { id: string; price: ModelPrice } | null {
	if (!id) return null
	const name = bareName(id)
	for (const [kind, models] of Object.entries(MODEL_CATALOG)) {
		if (kind === 'fixture') continue
		const m = models.find((x) => x.price && bareName(x.id) === name)
		if (m) return { id: m.id, price: m.price! }
	}
	return null
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
		free: true,
	},
	{
		id: 'lmstudio',
		label: 'LM Studio (local)',
		baseUrl: 'http://localhost:1234/v1',
		protocol: 'openai-chat',
		auth: 'none',
		contextWindow: 8192,
		note: null,
		free: true,
	},
	{
		id: 'omniroute',
		label: 'OmniRoute (local)',
		baseUrl: 'http://localhost:20128/v1',
		protocol: 'openai-chat',
		auth: 'api-key',
		contextWindow: null,
		note: 'OmniRoute routes to the providers configured in its own dashboard; use an API key created there, or choose “None” if your OmniRoute does not require keys. Its model list is public, so “Test connection” confirms the gateway is reachable but not that the key is accepted. Use “Test model” to check a model end to end.',
		free: false,
	},
	{
		id: 'generic',
		label: 'Other OpenAI-compatible endpoint',
		baseUrl: 'https://',
		protocol: 'openai-chat',
		auth: 'api-key',
		contextWindow: 32_768,
		note: null,
		free: false,
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
		cli: false,
		efforts: [],
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
		cli: false,
		efforts: [],
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
		cli: false,
		efforts: [],
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
		cli: false,
		efforts: [],
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
		cli: false,
		efforts: [],
	},
	{
		kind: 'claude-code',
		label: 'Claude Code',
		description:
			'Reviews with your Claude plan through the Claude Code you have installed and signed in to. Requests count against the plan’s usage limits instead of being billed per token.',
		authMethods: ['none'],
		multiple: false,
		endpointEditable: true,
		defaultBaseUrl: 'claude',
		protocols: [{ protocol: 'claude-cli', label: 'Claude Code (claude -p)' }],
		presets: [],
		keyPlaceholder: '',
		keyHelpUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
		testExplains:
			'Test connection runs “claude auth status” to check Claude Code is installed and signed in with a Claude plan. It does not run inference; use “Test model” for that.',
		contextWindowEditable: false,
		development: false,
		cli: true,
		efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
	},
	{
		kind: 'codex',
		label: 'Codex',
		description:
			'Reviews with your ChatGPT plan through the Codex CLI you have installed and signed in to. Requests count against the plan’s usage limits instead of being billed per token.',
		authMethods: ['none'],
		multiple: false,
		endpointEditable: true,
		defaultBaseUrl: 'codex',
		protocols: [{ protocol: 'codex-cli', label: 'Codex CLI (codex exec)' }],
		presets: [],
		keyPlaceholder: '',
		keyHelpUrl: 'https://developers.openai.com/codex/cli',
		testExplains:
			'Test connection checks the Codex version and runs “codex login status” to check it is signed in with ChatGPT. It does not run inference; use “Test model” for that.',
		contextWindowEditable: false,
		development: false,
		cli: true,
		efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
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
		cli: false,
		efforts: [],
	},
]

/**
 * A CLI model with its effort as a suffix, "gpt-6-sol-high", split into the model the CLI is asked for and the effort
 * it runs at. Names without one of the CLI's levels at the end are the model itself, at the CLI's default effort.
 */
export function cliVariant(kind: ProviderKind, id: string): { model: string; effort: string | null } {
	const m = /^(.+)-([a-z]+)$/.exec(id)
	return m && descriptor(kind).efforts.includes(m[2]) ? { model: m[1], effort: m[2] } : { model: id, effort: null }
}

export function descriptor(kind: ProviderKind): ProviderDescriptor {
	const d = PROVIDERS.find((p) => p.kind === kind)
	if (!d) throw new Error(`Unknown provider ${kind}`)
	return d
}
