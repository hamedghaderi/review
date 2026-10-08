import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
	AiSettingsView,
	AuthMethod,
	ConnectionPatch,
	ConnectionStatus,
	ConnectionView,
	CredentialState,
	FindingLevelSettings,
	ModelProbe,
	ModelSelection,
	ModelSource,
	ModelView,
	NewConnectionInput,
	ProviderKind,
	ProviderProtocol,
	ReviewerChoice,
	ReviewLimits,
	ReviewRule,
	ReviewTeam,
	ReviewTeamView,
} from '../../shared/types.ts'
import { AppFail } from '../git.ts'
import { JsonStore } from '../store.ts'
import type { AdapterFactory, ResolvedConnection } from './adapters.ts'
import { CATALOG_UPDATED, descriptor, MODEL_CATALOG, PROVIDERS } from './catalog.ts'
import type { CredentialService } from './credentials.ts'
import { DEFAULT_LEVELS, PROMPT_VERSION, REVIEWER_INSTRUCTIONS } from './prompt.ts'
import { ProviderError, type DiscoveredModel, type ModelLimits, type ReviewProvider } from './provider.ts'
import { validateBatchOutput } from './findings.ts'
import { REVIEW_RULES } from '../../shared/types.ts'

export const DEFAULT_LIMITS: ReviewLimits = {
	contextLines: 20,
	maxBatchChars: 160_000,
	maxRunChars: 2_000_000,
	relatedCode: true,
	lookups: true,
	verify: true,
	groupDuplicates: false,
}
export const DEFAULT_LEVEL_SETTINGS: FindingLevelSettings = { enabled: DEFAULT_LEVELS, autoAdd: ['blocking', 'should_fix', 'question'] }
const REQUEST_TIMEOUT_MS = 180_000
const TEST_TIMEOUT_MS = 20_000
const FALLBACK_LIMITS: ModelLimits = { contextWindow: 32_768, maxOutputTokens: 8192 }

interface StoredModel {
	id: string
	label: string
	source: ModelSource
	contextWindow: number | null
	maxOutputTokens: number | null
	structuredOutput: 'yes' | 'no' | 'unknown'
	probe: ModelProbe | null
}

interface StoredConnection {
	id: string
	kind: ProviderKind
	label: string
	protocol: ProviderProtocol
	baseUrl: string
	auth: AuthMethod
	preset: string | null
	contextWindow: number | null
	defaultModel: string | null
	// Increments whenever the endpoint, protocol or auth method changes; test results and model lists are only
	// valid for the revision they were produced for.
	revision: number
	lastTest: { ok: boolean; at: string; message: string; revision: number } | null
	models: Array<StoredModel> // discovered + manual; catalog entries are merged in for display
	modelsFetchedAt: string | null
	createdAt: string
}

interface SettingsFile {
	version: 1
	connections: Array<StoredConnection>
	selection: ModelSelection | null
	limits: ReviewLimits
	levels: FindingLevelSettings
	teams: Array<ReviewTeam>
	teamId: string | null // selected team; takes precedence over `selection` for runs
}

export interface RunConfig {
	provider: ReviewProvider
	connectionId: string
	connectionLabel: string
	endpoint: string
	limits: ReviewLimits
	levels?: FindingLevelSettings['enabled']
}

/**
 * Nonsecret AI provider settings and connection lifecycle. Secrets live in CredentialService; this class never
 * returns them, it only hands them to an adapter when building a client.
 */
export class ConnectionService {
	private file: JsonStore<SettingsFile>
	private credentials: CredentialService
	private adapters: AdapterFactory
	private testing = new Set<string>()
	private refreshing = new Set<string>()
	private listeners = new Set<(view: AiSettingsView) => void>()
	private removalListeners = new Set<(connectionId: string) => void>()
	private showDevelopment: boolean

	constructor(dir: string, credentials: CredentialService, adapters: AdapterFactory, options: { showDevelopment: boolean }) {
		this.file = new JsonStore<SettingsFile>(join(dir, 'ai-settings.json'), emptySettings, migrateSettings)
		this.credentials = credentials
		this.adapters = adapters
		this.showDevelopment = options.showDevelopment
	}

	async load(): Promise<void> {
		await this.file.load()
	}

	onChange(listener: (view: AiSettingsView) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	onRemoved(listener: (connectionId: string) => void): () => void {
		this.removalListeners.add(listener)
		return () => this.removalListeners.delete(listener)
	}

	view(): AiSettingsView {
		const d = this.file.read()
		const connections = d.connections.map((c) => this.connectionView(c))
		return {
			providers: PROVIDERS.filter((p) => !p.development || this.showDevelopment || d.connections.some((c) => c.kind === p.kind)),
			connections,
			selection: this.validSelection(d.selection, connections),
			selectionIssue: this.selectionIssue(d.selection, connections),
			teams: d.teams.map((t) => this.teamView(t, connections)),
			reviewer:
				d.teamId && d.teams.some((t) => t.id === d.teamId)
					? { kind: 'team', teamId: d.teamId }
					: d.selection
						? { kind: 'model', selection: d.selection }
						: null,
			storage: this.credentials.storageInfo(),
			limits: d.limits,
			levels: d.levels,
			promptVersion: PROMPT_VERSION,
			catalogUpdated: CATALOG_UPDATED,
		}
	}

	async create(input: NewConnectionInput): Promise<ConnectionView> {
		const desc = descriptor(input.kind)
		if (desc.development && !this.showDevelopment)
			throw new AppFail('invalid-input', 'That provider is only available in development builds.')
		const d = this.file.read()
		if (!desc.multiple && d.connections.some((c) => c.kind === input.kind)) {
			throw new AppFail('invalid-input', `${desc.label} is already connected. Use it from the list, or disconnect it first.`)
		}
		const preset = input.preset ? desc.presets.find((p) => p.id === input.preset) : undefined
		if (input.preset && !preset) throw new AppFail('invalid-input', 'Unknown preset.')
		const protocol = input.protocol ?? preset?.protocol ?? desc.protocols[0].protocol
		if (!desc.protocols.some((p) => p.protocol === protocol))
			throw new AppFail('invalid-input', 'That protocol is not available for this provider.')
		const auth = input.auth ?? preset?.auth ?? desc.authMethods[0]
		if (!desc.authMethods.includes(auth))
			throw new AppFail('invalid-input', 'That authentication method is not available for this provider.')
		const baseUrl = desc.endpointEditable ? normaliseUrl(input.baseUrl ?? preset?.baseUrl ?? '') : (desc.defaultBaseUrl as string)
		const conn: StoredConnection = {
			id: randomUUID(),
			kind: input.kind,
			label: (input.label?.trim() || preset?.label || desc.label).slice(0, 80),
			protocol,
			baseUrl,
			auth,
			preset: preset?.id ?? null,
			contextWindow: desc.contextWindowEditable ? (input.contextWindow ?? preset?.contextWindow ?? null) : null,
			defaultModel: null,
			revision: 1,
			lastTest: null,
			models: [],
			modelsFetchedAt: null,
			createdAt: new Date().toISOString(),
		}
		await this.file.update((f) => {
			f.connections.push(conn)
		})
		this.emit()
		return this.connectionView(conn)
	}

	async update(id: string, patch: ConnectionPatch): Promise<void> {
		const conn = this.get(id)
		const desc = descriptor(conn.kind)
		let endpointChanged = false
		const next = { ...conn }
		if (patch.label !== undefined) next.label = patch.label.trim().slice(0, 80) || desc.label
		if (patch.baseUrl !== undefined) {
			if (!desc.endpointEditable) throw new AppFail('invalid-input', 'This provider’s endpoint cannot be changed.')
			const url = normaliseUrl(patch.baseUrl)
			if (url !== conn.baseUrl) {
				next.baseUrl = url
				next.preset = null
				endpointChanged = true
			}
		}
		if (patch.protocol !== undefined && patch.protocol !== conn.protocol) {
			if (!desc.protocols.some((p) => p.protocol === patch.protocol)) throw new AppFail('invalid-input', 'That protocol is not available.')
			next.protocol = patch.protocol
			endpointChanged = true
		}
		if (patch.auth !== undefined && patch.auth !== conn.auth) {
			if (!desc.authMethods.includes(patch.auth)) throw new AppFail('invalid-input', 'That authentication method is not available.')
			next.auth = patch.auth
			endpointChanged = true
		}
		if (patch.contextWindow !== undefined) {
			if (!desc.contextWindowEditable) throw new AppFail('invalid-input', 'The context window is reported by this provider.')
			next.contextWindow = patch.contextWindow
		}
		if (patch.defaultModel !== undefined) next.defaultModel = patch.defaultModel
		if (endpointChanged) {
			// A new endpoint must not inherit trust: drop the stored key, the test result and the discovered models.
			next.revision = conn.revision + 1
			next.lastTest = null
			next.models = next.models.filter((m) => m.source === 'manual').map((m) => ({ ...m, probe: null }))
			next.modelsFetchedAt = null
			await this.credentials.remove(id)
			this.notifyRemoved(id) // cancels runs that were using the old endpoint
		}
		await this.file.update((f) => {
			const i = f.connections.findIndex((c) => c.id === id)
			if (i >= 0) f.connections[i] = next
		})
		this.emit()
	}

	async remove(id: string): Promise<void> {
		this.get(id)
		this.notifyRemoved(id)
		await this.credentials.remove(id)
		await this.file.update((f) => {
			f.connections = f.connections.filter((c) => c.id !== id)
			if (f.selection?.connectionId === id) f.selection = null
		})
		this.emit()
	}

	/** Replaces the credential. The previous test result no longer applies to the new key. */
	async setCredential(id: string, secret: string, persist: boolean): Promise<void> {
		const conn = this.get(id)
		if (conn.auth !== 'api-key') throw new AppFail('invalid-input', 'This connection is set up without authentication.')
		await this.credentials.save(id, secret, endpointKey(conn), persist).catch((e: Error) => {
			throw new AppFail('store-failed', e.message)
		})
		this.notifyRemoved(id) // a run that captured the previous key keeps it; new runs use the new one
		await this.file.update((f) => {
			const c = f.connections.find((x) => x.id === id)
			if (!c) return
			c.lastTest = null
			c.models = c.models.filter((m) => m.source === 'manual').map((m) => ({ ...m, probe: null }))
			c.modelsFetchedAt = null
		})
		this.emit()
	}

	/** Verifies the endpoint and credential by listing models. Never runs inference. */
	async test(id: string): Promise<void> {
		const conn = this.get(id)
		if (this.testing.has(id)) return
		this.testing.add(id)
		this.emit()
		const revision = conn.revision
		let result: { ok: boolean; message: string; models: Array<DiscoveredModel> | null }
		try {
			const { listed, usable } = await this.listModels(conn)
			result = {
				ok: true,
				message: listed
					? `Connected. ${listed} model${listed === 1 ? '' : 's'} available${usable.length !== listed ? ` (${listed - usable.length} without structured output hidden)` : ''}.`
					: 'Connected, but the endpoint reported no models. Add a model ID manually.',
				models: usable,
			}
		} catch (e) {
			result = { ok: false, message: e instanceof ProviderError ? e.message : e instanceof Error ? e.message : String(e), models: null }
		} finally {
			this.testing.delete(id)
		}
		await this.file.update((f) => {
			const c = f.connections.find((x) => x.id === id)
			if (!c || c.revision !== revision) return // endpoint changed while testing; this result is stale
			const at = new Date().toISOString()
			c.lastTest = { ok: result.ok, at, message: result.message, revision }
			if (result.models) storeDiscovered(c, result.models, at)
		})
		this.emit()
	}

	/**
	 * Quietly re-lists models for connections that last tested OK, when their list is older than `maxAgeMs`, so models
	 * added on the provider (e.g. in a gateway's dashboard) appear without pressing "Test connection". A failed refresh
	 * keeps the previous list and status: a gateway that is briefly down must not mark the connection as failed.
	 */
	async refreshModels(maxAgeMs: number): Promise<void> {
		const now = Date.now()
		const due = this.file
			.read()
			.connections.filter(
				(c) =>
					c.lastTest?.ok === true &&
					c.lastTest.revision === c.revision &&
					!this.testing.has(c.id) &&
					!this.refreshing.has(c.id) &&
					(!c.modelsFetchedAt || now - Date.parse(c.modelsFetchedAt) >= maxAgeMs),
			)
		await Promise.all(due.map((c) => this.refreshOne(c)))
	}

	private async refreshOne(conn: StoredConnection): Promise<void> {
		this.refreshing.add(conn.id)
		let usable: Array<DiscoveredModel>
		try {
			usable = (await this.listModels(conn)).usable
		} catch {
			return
		} finally {
			this.refreshing.delete(conn.id)
		}
		await this.file.update((f) => {
			const c = f.connections.find((x) => x.id === conn.id)
			if (c && c.revision === conn.revision && c.lastTest?.ok === true) storeDiscovered(c, usable, new Date().toISOString())
		})
		this.emit()
	}

	private async listModels(conn: StoredConnection): Promise<{ listed: number; usable: Array<DiscoveredModel> }> {
		const resolved = await this.resolve(conn, TEST_TIMEOUT_MS)
		const models = await this.adapters.account(resolved).listModels(AbortSignal.timeout(TEST_TIMEOUT_MS + 2000))
		const usable = conn.kind === 'custom' || conn.kind === 'openrouter' ? models : models.filter((m) => m.structuredOutput !== 'no')
		return { listed: models.length, usable }
	}

	async addModel(id: string, modelId: string): Promise<void> {
		const conn = this.get(id)
		if (!/^[\w.:/@+\-]{1,200}$/.test(modelId)) throw new AppFail('invalid-input', 'Model IDs may contain letters, digits and . : / @ + - _')
		if (conn.models.some((m) => m.id === modelId)) return
		await this.file.update((f) => {
			const c = f.connections.find((x) => x.id === id)
			c?.models.push({
				id: modelId,
				label: modelId,
				source: 'manual',
				contextWindow: null,
				maxOutputTokens: null,
				structuredOutput: 'unknown',
				probe: null,
			})
		})
		this.emit()
	}

	async removeModel(id: string, modelId: string): Promise<void> {
		await this.file.update((f) => {
			const c = f.connections.find((x) => x.id === id)
			if (!c) return
			c.models = c.models.filter((m) => !(m.id === modelId && m.source === 'manual'))
			if (c.defaultModel === modelId) c.defaultModel = null
			if (f.selection?.connectionId === id && f.selection.modelId === modelId) f.selection = null
		})
		this.emit()
	}

	/**
	 * Explicit inference probe: one minimal synthetic request (no repository content) that checks the model answers
	 * in the findings schema. Costs a few tokens.
	 */
	async probeModel(id: string, modelId: string): Promise<void> {
		const conn = this.get(id)
		const revision = conn.revision
		let probe: ModelProbe
		try {
			const provider = await this.buildProvider(conn, modelId, TEST_TIMEOUT_MS * 3)
			const response = await provider.review(
				{ instructions: REVIEWER_INSTRUCTIONS, input: PROBE_INPUT, batch: PROBE_BATCH },
				AbortSignal.timeout(TEST_TIMEOUT_MS * 3 + 2000),
			)
			validateBatchOutput(response.output, PROBE_BATCH, PROBE_COMPARISON, 'probe')
			probe = {
				ok: true,
				at: new Date().toISOString(),
				message: response.jsonFallback
					? 'Answered in the findings schema using JSON mode (the endpoint does not support native structured output).'
					: 'Answered in the findings schema.',
			}
		} catch (e) {
			const message = e instanceof ProviderError ? e.message : e instanceof Error ? `Invalid output: ${e.message}` : String(e)
			probe = { ok: false, at: new Date().toISOString(), message }
		}
		await this.file.update((f) => {
			const c = f.connections.find((x) => x.id === id)
			if (!c || c.revision !== revision) return
			let m = c.models.find((x) => x.id === modelId)
			if (!m) {
				const cat = MODEL_CATALOG[c.kind]?.find((x) => x.id === modelId)
				m = {
					id: modelId,
					label: cat?.label ?? modelId,
					source: cat ? 'catalog' : 'manual',
					contextWindow: cat?.contextWindow ?? null,
					maxOutputTokens: cat?.maxOutputTokens ?? null,
					structuredOutput: 'unknown',
					probe: null,
				}
				c.models.push(m)
			}
			m.probe = probe
		})
		this.emit()
	}

	async select(selection: ModelSelection): Promise<void> {
		const conn = this.get(selection.connectionId)
		const view = this.connectionView(conn)
		if (!view.models.some((m) => m.id === selection.modelId))
			throw new AppFail('invalid-input', 'That model is not offered by this connection.')
		await this.file.update((f) => {
			f.selection = selection
			f.teamId = null // picking one model switches away from a team
			const c = f.connections.find((x) => x.id === selection.connectionId)
			if (c) c.defaultModel = selection.modelId
		})
		this.emit()
	}

	async saveTeam(team: ReviewTeam): Promise<void> {
		for (const m of team.members) {
			const c = this.get(m.connectionId)
			if (!this.connectionView(c).models.some((x) => x.id === m.modelId))
				throw new AppFail('invalid-input', `${m.role}: model "${m.modelId}" is not offered by ${c.label}.`)
		}
		await this.file.update((f) => {
			const i = f.teams.findIndex((t) => t.id === team.id)
			if (i >= 0) f.teams[i] = team
			else f.teams.push(team)
		})
		this.emit()
	}

	async removeTeam(id: string): Promise<void> {
		await this.file.update((f) => {
			f.teams = f.teams.filter((t) => t.id !== id)
			if (f.teamId === id) f.teamId = null
		})
		this.emit()
	}

	async selectTeam(id: string): Promise<void> {
		if (!this.file.read().teams.some((t) => t.id === id)) throw new AppFail('not-found', 'That review team no longer exists.')
		await this.file.update((f) => {
			f.teamId = id
		})
		this.emit()
	}

	team(id: string): ReviewTeam {
		const t = this.file.read().teams.find((x) => x.id === id)
		if (!t) throw new AppFail('not-found', 'That review team no longer exists.')
		return t
	}

	/** The remembered choice must match what the renderer asks to run, so a stale window can't start the wrong reviewer. */
	checkChoice(choice: ReviewerChoice): void {
		const d = this.file.read()
		if (choice.kind === 'team' && !d.teams.some((t) => t.id === choice.teamId))
			throw new AppFail('not-found', 'That review team no longer exists.')
	}

	private teamView(t: ReviewTeam, connections: Array<ConnectionView>): ReviewTeamView {
		const issues: ReviewTeamView['issues'] = []
		for (const m of t.members) {
			const c = connections.find((x) => x.id === m.connectionId)
			if (!c) issues.push({ memberId: m.id, message: `${m.role}: its provider was disconnected.` })
			else if (!c.models.some((x) => x.id === m.modelId))
				issues.push({ memberId: m.id, message: `${m.role}: “${m.modelId}” is no longer offered by ${c.label}.` })
			else if (c.status !== 'connected' && c.status !== 'testing' && c.kind !== 'fixture')
				issues.push({ memberId: m.id, message: `${m.role}: ${c.label} is not connected.` })
		}
		const owned = new Set(t.members.flatMap((m) => m.rules))
		const missing = REVIEW_RULES.filter((r) => !owned.has(r))
		if (missing.length)
			issues.push({
				memberId: null,
				message: `No member checks ${missing.length} rule${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`,
			})
		return { ...t, issues }
	}

	async setLevels(levels: FindingLevelSettings): Promise<void> {
		await this.file.update((f) => {
			f.levels = levels
		})
		this.emit()
	}

	async setLimits(limits: ReviewLimits): Promise<void> {
		await this.file.update((f) => {
			f.limits = limits
		})
		this.emit()
	}

	/**
	 * Builds the fixed configuration for one review run: the adapter, the credential and the model limits are
	 * captured now and never re-read during the run.
	 */
	async runConfig(selection: ModelSelection): Promise<RunConfig> {
		const conn = this.get(selection.connectionId)
		const view = this.connectionView(conn)
		if (view.status !== 'connected' && conn.kind !== 'fixture') {
			throw new AppFail(
				'ai-unavailable',
				`${conn.label} is not connected${view.statusDetail ? `: ${view.statusDetail}` : ''}. Open Settings → AI providers.`,
			)
		}
		if (!view.models.some((m) => m.id === selection.modelId)) {
			throw new AppFail('ai-unavailable', `Model "${selection.modelId}" is not offered by ${conn.label}. Choose another model.`)
		}
		const provider = await this.buildProvider(conn, selection.modelId, REQUEST_TIMEOUT_MS)
		return {
			provider,
			connectionId: conn.id,
			connectionLabel: conn.label,
			endpoint: conn.baseUrl,
			limits: this.file.read().limits,
			levels: this.file.read().levels.enabled,
		}
	}

	flush(): Promise<unknown> {
		return this.file.flush()
	}

	private async buildProvider(conn: StoredConnection, modelId: string, timeoutMs: number): Promise<ReviewProvider> {
		const resolved = await this.resolve(conn, timeoutMs)
		return this.adapters.provider(resolved, modelId, this.modelLimits(conn, modelId))
	}

	private async resolve(conn: StoredConnection, timeoutMs: number): Promise<ResolvedConnection> {
		let apiKey: string | null = null
		if (conn.auth === 'api-key') {
			const read = await this.credentials.read(conn.id, endpointKey(conn))
			if (read.state === 'saved' || read.state === 'session') apiKey = read.secret
			else if (read.state === 'unreadable') throw new ProviderError('auth', read.reason)
			else if (read.state === 'endpoint-changed')
				throw new ProviderError('auth', 'The endpoint changed since the key was entered. Enter the key again for the new endpoint.')
			else throw new ProviderError('auth', `${conn.label} needs an API key. Add one in Settings → AI providers.`)
		}
		return { kind: conn.kind, label: conn.label, protocol: conn.protocol, baseUrl: conn.baseUrl, apiKey, timeoutMs }
	}

	private modelLimits(conn: StoredConnection, modelId: string): ModelLimits {
		const stored = conn.models.find((m) => m.id === modelId)
		const cat = MODEL_CATALOG[conn.kind]?.find((m) => m.id === modelId)
		const contextWindow = conn.contextWindow ?? stored?.contextWindow ?? cat?.contextWindow ?? FALLBACK_LIMITS.contextWindow
		const maxOutputTokens =
			stored?.maxOutputTokens ?? cat?.maxOutputTokens ?? Math.min(FALLBACK_LIMITS.maxOutputTokens, Math.floor(contextWindow / 4))
		return { contextWindow, maxOutputTokens }
	}

	private get(id: string): StoredConnection {
		const c = this.file.read().connections.find((x) => x.id === id)
		if (!c) throw new AppFail('not-found', 'That AI provider connection no longer exists.')
		return c
	}

	private connectionView(c: StoredConnection): ConnectionView {
		const desc = descriptor(c.kind)
		const peek = c.auth === 'api-key' ? this.credentials.peek(c.id, endpointKey(c)) : null
		const credential: CredentialState =
			c.auth === 'none' ? 'not-required' : peek === 'endpoint-changed' ? 'none' : (peek as CredentialState)
		const hasCredential = credential === 'saved' || credential === 'session' || credential === 'not-required'
		const test = c.lastTest && c.lastTest.revision === c.revision ? c.lastTest : null
		let status: ConnectionStatus
		let statusDetail: string | null = null
		if (this.testing.has(c.id)) status = 'testing'
		else if (c.kind === 'fixture') status = 'connected'
		else if (!hasCredential) {
			status = 'not-connected'
			statusDetail = c.auth === 'api-key' ? 'No API key saved' : null
		} else if (!test) {
			status = 'not-connected'
			statusDetail = 'Not tested yet. Saving a key does not verify it.'
		} else if (test.ok) status = 'connected'
		else {
			status = 'failed'
			statusDetail = test.message
		}
		return {
			id: c.id,
			kind: c.kind,
			label: c.label,
			providerLabel: desc.label,
			protocol: c.protocol,
			baseUrl: c.baseUrl,
			auth: c.auth,
			preset: c.preset,
			contextWindow: c.contextWindow,
			defaultModel: c.defaultModel,
			status,
			statusDetail,
			credential,
			lastTest: test && { ok: test.ok, at: test.at, message: test.message },
			models: this.models(c, test?.ok === true),
			modelsFetchedAt: c.modelsFetchedAt,
		}
	}

	/** Discovered and manual models, plus catalog entries not confirmed by discovery. */
	private models(c: StoredConnection, verified: boolean): Array<ModelView> {
		const out: Array<ModelView> = c.models.map((m) => ({ ...m }))
		const discovered = c.models.some((m) => m.source === 'discovered')
		for (const cat of MODEL_CATALOG[c.kind] ?? []) {
			if (out.some((m) => m.id === cat.id)) continue
			// Once discovery has run, catalog entries missing from the account's list are not offered.
			if (discovered && verified) continue
			out.push({
				id: cat.id,
				label: cat.label,
				source: 'catalog',
				contextWindow: cat.contextWindow,
				maxOutputTokens: cat.maxOutputTokens,
				structuredOutput: 'unknown',
				probe: null,
			})
		}
		return out
	}

	private validSelection(sel: ModelSelection | null, connections: Array<ConnectionView>): ModelSelection | null {
		if (!sel) return null
		const c = connections.find((x) => x.id === sel.connectionId)
		return c && c.models.some((m) => m.id === sel.modelId) ? sel : null
	}

	private selectionIssue(sel: ModelSelection | null, connections: Array<ConnectionView>): string | null {
		if (!sel) return null
		const c = connections.find((x) => x.id === sel.connectionId)
		if (!c) return 'The previously selected provider was disconnected. Choose a model.'
		if (!c.models.some((m) => m.id === sel.modelId)) return `“${sel.modelId}” is no longer offered by ${c.label}. Choose another model.`
		if (c.status === 'failed') return `${c.label}: ${c.statusDetail ?? 'connection failed'}`
		if (c.status === 'not-connected') return `${c.label} is not connected${c.statusDetail ? ` (${c.statusDetail})` : ''}.`
		return null
	}

	private notifyRemoved(id: string): void {
		for (const l of this.removalListeners) l(id)
	}

	private emit(): void {
		const v = this.view()
		for (const l of this.listeners) l(v)
	}
}

/** Credentials are bound to the exact endpoint, protocol and auth method they were entered for. */
function endpointKey(c: StoredConnection): string {
	return `${c.protocol} ${c.baseUrl}`
}

/** Replaces the discovered models, keeping manual entries the provider does not list and each model's probe result. */
function storeDiscovered(c: StoredConnection, discovered: Array<DiscoveredModel>, at: string): void {
	const manual = c.models.filter((m) => m.source === 'manual' && !discovered.some((d) => d.id === m.id))
	const probes = new Map(c.models.map((m) => [m.id, m.probe]))
	c.models = [...discovered.map((m): StoredModel => ({ ...m, source: 'discovered', probe: probes.get(m.id) ?? null })), ...manual]
	c.modelsFetchedAt = at
}

export function normaliseUrl(raw: string): string {
	let url: URL
	try {
		url = new URL(raw.trim())
	} catch {
		throw new AppFail('invalid-input', 'Enter a full endpoint URL, for example http://localhost:11434/v1')
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AppFail('invalid-input', 'The endpoint must use http or https.')
	if (url.username || url.password) throw new AppFail('invalid-input', 'Put credentials in the API key field, not in the URL.')
	if (url.search || url.hash) throw new AppFail('invalid-input', 'The endpoint URL must not contain a query string or fragment.')
	const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) || url.hostname.endsWith('.local')
	if (url.protocol === 'http:' && !local && !isPrivateIp(url.hostname)) {
		throw new AppFail(
			'invalid-input',
			'Remote endpoints must use https. Plain http is only allowed for localhost and private network addresses.',
		)
	}
	return url.toString().replace(/\/+$/, '')
}

function isPrivateIp(host: string): boolean {
	return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d{1,3}\.\d{1,3}(\.\d{1,3})?$/.test(host)
}

function emptySettings(): SettingsFile {
	return { version: 1, connections: [], selection: null, limits: DEFAULT_LIMITS, levels: DEFAULT_LEVEL_SETTINGS, teams: [], teamId: null }
}

/**
 * Rules added after a team was saved go to the member that checks callers and structure (closest in kind: both need
 * the code around the change), else the first member, so a saved team keeps working instead of reporting "no member
 * checks …" until it is edited.
 */
function adoptNewRules(saved: ReviewTeam): ReviewTeam {
	if (!saved.members?.length) return saved
	// Residue signature 7 became "test-value" (reviewer-2026-10-02.2): whoever checked it checks the new rule.
	const t = {
		...saved,
		members: saved.members.map((m) => ({
			...m,
			rules: (m.rules as Array<string>).map((r) => (r === 'residue-7' ? 'test-value' : r)) as Array<ReviewRule>,
		})),
	}
	const owned = new Set(t.members.flatMap((m) => m.rules))
	const missing = LATER_RULES.filter((r) => !owned.has(r))
	if (!missing.length) return t
	const heir =
		t.members.find((m) => m.rules.includes('breaking-change')) ?? t.members.find((m) => m.rules.includes('file-split')) ?? t.members[0]
	return { ...t, members: t.members.map((m) => (m === heir ? { ...m, rules: [...m.rules, ...missing] } : m)) }
}
const LATER_RULES: Array<ReviewRule> = ['convention', 'test-value'] // added in reviewer-2026-10-01.6 and -10-02.2

export function migrateSettings(raw: unknown): SettingsFile {
	const d = raw as Partial<SettingsFile> | null
	if (!d || d.version !== 1 || !Array.isArray(d.connections)) throw new Error('Unsupported settings file')
	return {
		version: 1,
		connections: d.connections,
		selection: d.selection ?? null,
		limits: { ...DEFAULT_LIMITS, ...(d.limits ?? {}) },
		levels: d.levels?.enabled?.length ? d.levels : DEFAULT_LEVEL_SETTINGS,
		teams: Array.isArray(d.teams) ? d.teams.map(adoptNewRules) : [],
		teamId: typeof d.teamId === 'string' ? d.teamId : null,
	}
}

// A tiny synthetic review used by "Test model". Contains no repository content.
const PROBE_FILE = {
	key: 'probe.ts',
	status: 'modified' as const,
	oldPath: 'probe.ts',
	newPath: 'probe.ts',
	additions: 1,
	deletions: 1,
	binary: false,
	similarity: null,
}
const PROBE_BATCH = {
	index: 0,
	references: [],
	facts: [],
	fileKeys: ['probe.ts'],
	overview: '',
	chars: 0,
	excerpts: [
		{
			id: 'E1',
			file: PROBE_FILE,
			lines: [
				{ kind: 'ctx' as const, oldNo: 1, newNo: 1, text: 'export function total(items) {' },
				{ kind: 'del' as const, oldNo: 2, newNo: null, text: '  return items.reduce((a, b) => a + b, 0)' },
				{ kind: 'add' as const, oldNo: null, newNo: 2, text: '  return items.reduce((a, b) => a + b)' },
				{ kind: 'ctx' as const, oldNo: 3, newNo: 3, text: '}' },
			],
			old: { start: 1, end: 3 },
			new: { start: 1, end: 3 },
			anchorable: { old: new Set([1, 2, 3]), new: new Set([1, 2, 3]) },
			text: '',
		},
	],
}
const PROBE_INPUT = [
	'# Connection check',
	'This is a synthetic request to check that you can answer in the required JSON format. It is not a real review.',
	'# Manifest of supplied excerpts (the only valid excerpt_id values)',
	'- E1: old path probe.ts, new path probe.ts; old 1-3; new 1-3',
	'',
	'=== BEGIN E1 ===',
	'file status: modified',
	'old path: probe.ts',
	'new path: probe.ts',
	'columns: OLD_LINE NEW_LINE MARK | source',
	'     1      1   | export function total(items) {',
	'     2      . - |   return items.reduce((a, b) => a + b, 0)',
	'     .      2 + |   return items.reduce((a, b) => a + b)',
	'     3      3   | }',
	'=== END E1 ===',
].join('\n')
const PROBE_COMPARISON = {
	id: `${'0'.repeat(40)}..${'1'.repeat(40)}`,
	repoId: 'probe',
	baseRef: 'probe',
	baseTipSha: '0'.repeat(40),
	baseSha: '0'.repeat(40),
	headSha: '1'.repeat(40),
	headRef: null,
	target: null,
	pr: null,
	files: [PROBE_FILE],
}
