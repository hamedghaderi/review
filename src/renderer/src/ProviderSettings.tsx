import { useEffect, useRef, useState } from 'react'
import type {
	AiSettingsView,
	AuthMethod,
	ConnectionStatus,
	ConnectionView,
	McpSettingsView,
	ProviderDescriptor,
	ProviderKind,
	ProviderProtocol,
	Result,
} from '../../shared/types.ts'
import { sourceLabel, sourceTitle } from './ModelPicker.tsx'
import { suggestTeam, TeamEditor } from './TeamEditor.tsx'
import { McpImport, McpServerEditor } from './McpSettings.tsx'
import { FINDING_LEVELS, type FindingLevel, type FindingLevelSettings, type ReviewTeam } from '../../shared/types.ts'
import { LEVEL_META } from '../../shared/findings.ts'

interface Props {
	settings: AiSettingsView
	initialConnectionId: string | null
	initialTeam?: 'new' | string | null
	repoId?: string | null // the open repository, for MCP servers started in its folder and its Claude Code settings
	onClose(): void
	onChange(view: AiSettingsView): void
}

const STATUS_TEXT: Record<ConnectionStatus, string> = {
	'not-connected': 'Not connected',
	connected: 'Connected',
	testing: 'Testing…',
	failed: 'Connection failed',
}

/** Settings → AI providers. Everything shown is derived from provider descriptors sent by the main process. */
export function ProviderSettings({ settings, initialConnectionId, initialTeam = null, repoId = null, onClose, onChange }: Props) {
	const [selectedId, setSelectedId] = useState<string | null>(initialConnectionId ?? settings.connections[0]?.id ?? null)
	const [adding, setAdding] = useState<{ kind: ProviderKind; preset: string | null } | null>(null)
	const [editingTeam, setEditingTeam] = useState<{ team: ReviewTeam; isNew: boolean } | null>(() =>
		initialTeam === 'new'
			? { team: suggestTeam(settings), isNew: true }
			: initialTeam
				? ((t) => (t ? { team: t, isNew: false } : null))(settings.teams.find((x) => x.id === initialTeam))
				: null,
	)
	const [error, setError] = useState<string | null>(null)
	const [mcp, setMcp] = useState<McpSettingsView | null>(null)
	const [mcpPane, setMcpPane] = useState<{ kind: 'server'; id: string } | { kind: 'new' } | { kind: 'import' } | null>(null)
	const dialog = useRef<HTMLDivElement>(null)

	useEffect(() => {
		void window.review.mcpSettings().then((r) => r.ok && setMcp(r.value))
		return window.review.onMcpSettingsChanged(setMcp)
	}, [])

	async function mcpRun(p: Promise<Result<McpSettingsView>>): Promise<boolean> {
		setError(null)
		const r = await p
		if (!r.ok) {
			setError(r.error.message)
			return false
		}
		setMcp(r.value)
		return true
	}
	const showMcp = (pane: typeof mcpPane): void => {
		setAdding(null)
		setEditingTeam(null)
		setMcpPane(pane)
	}
	const mcpServer = mcpPane?.kind === 'server' ? (mcp?.servers.find((x) => x.id === mcpPane.id) ?? null) : null

	useEffect(() => {
		dialog.current?.focus()
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape') onClose()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [onClose])

	const selected = settings.connections.find((c) => c.id === selectedId) ?? null

	async function run<T extends AiSettingsView>(p: Promise<Result<T>>): Promise<boolean> {
		setError(null)
		const r = await p
		if (!r.ok) {
			setError(r.error.message)
			return false
		}
		onChange(r.value)
		return true
	}

	return (
		<div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className="modal settings" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} ref={dialog}>
				<div className="modal-head">
					<h2 id="settings-title">Settings · AI providers</h2>
					<span className="spacer" />
					<button className="btn small ghost" onClick={onClose} aria-label="Close settings">
						✕
					</button>
				</div>
				{!settings.storage.secure && settings.storage.message && <div className="notice">{settings.storage.message}</div>}
				{error && (
					<button className="notice error-notice" onClick={() => setError(null)} title="Dismiss">
						{error} ✕
					</button>
				)}
				<div className="settings-body">
					<nav className="settings-nav" aria-label="Connections">
						<div className="section-title">Connections</div>
						{settings.connections.length === 0 && (
							<div className="muted small">No providers connected. Manual review works without one.</div>
						)}
						{settings.connections.map((c) => (
							<button
								key={c.id}
								className={`conn-item ${c.id === selectedId && !adding && !editingTeam && !mcpPane ? 'on' : ''}`}
								onClick={() => {
									setAdding(null)
									setEditingTeam(null)
									setMcpPane(null)
									setSelectedId(c.id)
								}}
							>
								<span className={`dot ${c.status}`} aria-hidden />
								<span className="ellipsis">{c.label}</span>
								<span className="muted small nowrap">{STATUS_TEXT[c.status]}</span>
							</button>
						))}
						<div className="section-title add-title">Add provider</div>
						{settings.providers.flatMap((p) => {
							const exists = !p.multiple && settings.connections.some((c) => c.kind === p.kind)
							// Providers with presets (e.g. local servers) get one entry per preset, so each is findable by name.
							const entries = p.presets.length
								? p.presets.map((x) => ({ preset: x.id as string | null, label: x.label, title: x.note ?? p.description }))
								: [{ preset: null, label: p.label, title: p.description }]
							return entries.map((e) => (
								<button
									key={`${p.kind}:${e.preset ?? ''}`}
									className={`conn-item ${adding?.kind === p.kind && adding.preset === e.preset ? 'on' : ''}`}
									disabled={exists}
									onClick={() => {
										setEditingTeam(null)
										setMcpPane(null)
										setAdding({ kind: p.kind, preset: e.preset })
									}}
									title={exists ? 'Already connected' : e.title}
								>
									<span className="ellipsis">+ {e.label}</span>
									{p.development && <span className="pill warn">Dev</span>}
								</button>
							))
						})}
						<div className="section-title add-title">Review teams</div>
						{settings.teams.map((t) => (
							<button
								key={t.id}
								className={`conn-item ${editingTeam?.team.id === t.id ? 'on' : ''}`}
								onClick={() => {
									setAdding(null)
									setMcpPane(null)
									setEditingTeam({ team: t, isNew: false })
								}}
								title={t.issues.map((i) => i.message).join('\n') || undefined}
							>
								<span className={`dot ${t.issues.length ? 'failed' : 'connected'}`} aria-hidden />
								<span className="ellipsis">{t.name}</span>
								<span className="muted small nowrap">
									{t.members.length} reviewer{t.members.length === 1 ? '' : 's'}
								</span>
							</button>
						))}
						<button
							className={`conn-item ${editingTeam?.isNew ? 'on' : ''}`}
							disabled={!settings.connections.some((c) => c.status === 'connected' || c.kind === 'fixture')}
							title="Split the review rules between several models"
							onClick={() => {
								setAdding(null)
								setMcpPane(null)
								setEditingTeam({ team: suggestTeam(settings), isNew: true })
							}}
						>
							<span className="ellipsis">+ New review team</span>
						</button>
						<div className="section-title add-title">MCP servers</div>
						{mcp?.servers.map((x) => (
							<button
								key={x.id}
								className={`conn-item ${mcpPane?.kind === 'server' && mcpPane.id === x.id ? 'on' : ''}`}
								onClick={() => showMcp({ kind: 'server', id: x.id })}
								title={x.lastTest?.message}
							>
								<span className={`dot ${!x.enabled ? '' : x.lastTest ? (x.lastTest.ok ? 'connected' : 'failed') : ''}`} aria-hidden />
								<span className="ellipsis">{x.name}</span>
								<span className="muted small nowrap">
									{!x.enabled ? 'Off' : x.tools ? `${x.tools.filter((t) => t.allowed).length} tools` : 'Not tested'}
								</span>
							</button>
						))}
						<button
							className={`conn-item ${mcpPane?.kind === 'new' ? 'on' : ''}`}
							onClick={() => showMcp({ kind: 'new' })}
							title="Give reviewers tools from an MCP server"
						>
							<span className="ellipsis">+ Add MCP server</span>
						</button>
						<button className={`conn-item ${mcpPane?.kind === 'import' ? 'on' : ''}`} onClick={() => showMcp({ kind: 'import' })}>
							<span className="ellipsis">+ Import from Claude Code</span>
						</button>
					</nav>
					<section className="settings-main">
						{mcpPane?.kind === 'import' ? (
							<McpImport repoId={repoId} run={mcpRun} onDone={() => setMcpPane(null)} />
						) : mcpPane && (mcpPane.kind === 'new' || mcpServer) ? (
							<McpServerEditor
								key={mcpServer?.id ?? 'new'}
								server={mcpServer}
								repoId={repoId}
								lookups={settings.limits.lookups !== false}
								secure={mcp?.secureStorage ?? false}
								run={mcpRun}
								onSaved={(id) => setMcpPane({ kind: 'server', id })}
								onRemoved={() => setMcpPane(null)}
								onCancel={() => setMcpPane(null)}
							/>
						) : editingTeam ? (
							<TeamEditor
								key={editingTeam.team.id}
								settings={settings}
								team={editingTeam.team}
								isNew={editingTeam.isNew}
								onCancel={() => setEditingTeam(null)}
								onSave={async (t) => {
									const ok = await run(window.review.saveTeam(t))
									if (ok) {
										if (editingTeam.isNew) await run(window.review.selectTeam(t.id))
										setEditingTeam({ team: t, isNew: false })
									}
									return ok
								}}
								onRemove={async () => {
									if (!window.confirm(`Delete ${editingTeam.team.name}?`)) return
									if (await run(window.review.removeTeam(editingTeam.team.id))) setEditingTeam(null)
								}}
							/>
						) : adding ? (
							<AddConnection
								key={`${adding.kind}:${adding.preset ?? ''}`}
								provider={settings.providers.find((p) => p.kind === adding.kind)!}
								initialPreset={adding.preset}
								onCancel={() => setAdding(null)}
								onCreate={async (input) => {
									const r = await window.review.createConnection(input)
									if (!r.ok) {
										setError(r.error.message)
										return
									}
									onChange(r.value)
									const created = r.value.connections.find((c) => !settings.connections.some((o) => o.id === c.id))
									setAdding(null)
									setSelectedId(created?.id ?? null)
								}}
							/>
						) : selected ? (
							<ConnectionDetail
								key={selected.id}
								connection={selected}
								provider={settings.providers.find((p) => p.kind === selected.kind)}
								settings={settings}
								run={run}
								onRemoved={() => setSelectedId(null)}
							/>
						) : (
							<div className="muted pad">Choose a provider on the left to connect it.</div>
						)}
					</section>
				</div>
				<FindingLevels settings={settings} run={run} />
				<Limits settings={settings} run={run} />
			</div>
		</div>
	)
}

function AddConnection({
	provider,
	initialPreset,
	onCancel,
	onCreate,
}: {
	provider: ProviderDescriptor
	initialPreset: string | null
	onCancel(): void
	onCreate(input: {
		kind: ProviderKind
		label?: string
		preset?: string | null
		baseUrl?: string
		protocol?: ProviderProtocol
		auth?: AuthMethod
		contextWindow?: number | null
	}): Promise<void>
}) {
	const [preset, setPreset] = useState(initialPreset ?? provider.presets[0]?.id ?? null)
	const p = provider.presets.find((x) => x.id === preset)
	const [label, setLabel] = useState(p?.label ?? provider.label)
	const [baseUrl, setBaseUrl] = useState(p?.baseUrl ?? provider.defaultBaseUrl ?? '')
	const [protocol, setProtocol] = useState<ProviderProtocol>(p?.protocol ?? provider.protocols[0].protocol)
	const [auth, setAuth] = useState<AuthMethod>(p?.auth ?? provider.authMethods[0])
	const [contextWindow, setContextWindow] = useState<string>(p?.contextWindow ? String(p.contextWindow) : '')
	const [busy, setBusy] = useState(false)

	function applyPreset(id: string): void {
		const x = provider.presets.find((q) => q.id === id)
		setPreset(id)
		if (!x) return
		setLabel(x.label)
		setBaseUrl(x.baseUrl)
		setProtocol(x.protocol)
		setAuth(x.auth)
		setContextWindow(x.contextWindow ? String(x.contextWindow) : '')
	}

	return (
		<form
			className="form"
			onSubmit={async (e) => {
				e.preventDefault()
				setBusy(true)
				await onCreate({
					kind: provider.kind,
					label,
					preset,
					...(provider.endpointEditable ? { baseUrl } : {}),
					protocol,
					auth,
					...(provider.contextWindowEditable ? { contextWindow: contextWindow ? Number(contextWindow) : null } : {}),
				})
				setBusy(false)
			}}
		>
			<h3>Connect {provider.label}</h3>
			<p className="muted small">{provider.description}</p>
			{provider.presets.length > 0 && (
				<label className="field">
					<span>Preset</span>
					<select value={preset ?? ''} onChange={(e) => applyPreset(e.target.value)}>
						{provider.presets.map((x) => (
							<option key={x.id} value={x.id}>
								{x.label}
							</option>
						))}
					</select>
				</label>
			)}
			{p?.note && <p className="notice small">{p.note}</p>}
			<EndpointFields
				provider={provider}
				label={label}
				setLabel={setLabel}
				baseUrl={baseUrl}
				setBaseUrl={setBaseUrl}
				protocol={protocol}
				setProtocol={setProtocol}
				auth={auth}
				setAuth={setAuth}
				contextWindow={contextWindow}
				setContextWindow={setContextWindow}
			/>
			<div className="form-actions">
				<button type="button" className="btn small ghost" onClick={onCancel}>
					Cancel
				</button>
				<button type="submit" className="btn small primary" disabled={busy}>
					Add connection
				</button>
			</div>
			<p className="muted small">
				{auth === 'api-key' ? 'You will enter the API key in the next step.' : 'No API key will be sent to this endpoint.'}
			</p>
		</form>
	)
}

interface EndpointProps {
	provider: ProviderDescriptor
	label: string
	setLabel(v: string): void
	baseUrl: string
	setBaseUrl(v: string): void
	protocol: ProviderProtocol
	setProtocol(v: ProviderProtocol): void
	auth: AuthMethod
	setAuth(v: AuthMethod): void
	contextWindow: string
	setContextWindow(v: string): void
}

function EndpointFields(p: EndpointProps) {
	return (
		<>
			<label className="field">
				<span>Name</span>
				<input value={p.label} onChange={(e) => p.setLabel(e.target.value)} maxLength={80} />
			</label>
			{p.provider.endpointEditable && (
				<label className="field">
					<span>Endpoint</span>
					<input
						className="mono"
						value={p.baseUrl}
						onChange={(e) => p.setBaseUrl(e.target.value)}
						placeholder="http://localhost:11434/v1"
						spellCheck={false}
					/>
				</label>
			)}
			{p.provider.protocols.length > 1 && (
				<label className="field">
					<span>API</span>
					<select value={p.protocol} onChange={(e) => p.setProtocol(e.target.value as ProviderProtocol)}>
						{p.provider.protocols.map((x) => (
							<option key={x.protocol} value={x.protocol}>
								{x.label}
							</option>
						))}
					</select>
				</label>
			)}
			{p.provider.authMethods.length > 1 && (
				<label className="field">
					<span>Authentication</span>
					<select value={p.auth} onChange={(e) => p.setAuth(e.target.value as AuthMethod)}>
						{p.provider.authMethods.map((a) => (
							<option key={a} value={a}>
								{a === 'none' ? 'None (local server)' : 'API key'}
							</option>
						))}
					</select>
				</label>
			)}
			{p.provider.contextWindowEditable && (
				<label className="field">
					<span>Context window</span>
					<input
						type="number"
						min={1024}
						step={1024}
						value={p.contextWindow}
						onChange={(e) => p.setContextWindow(e.target.value)}
						placeholder="blank = use what the endpoint reports"
						aria-describedby="ctx-help"
					/>
					<small id="ctx-help" className="muted">
						Tokens the server actually accepts (for Ollama, the model’s num_ctx). Leave blank if the endpoint reports limits per model.
						Review requests are sized to fit.
					</small>
				</label>
			)}
		</>
	)
}

function ConnectionDetail({
	connection: c,
	provider,
	settings,
	run,
	onRemoved,
}: {
	connection: ConnectionView
	provider: ProviderDescriptor | undefined
	settings: AiSettingsView
	run(p: Promise<Result<AiSettingsView>>): Promise<boolean>
	onRemoved(): void
}) {
	const [key, setKey] = useState('')
	const [persist, setPersist] = useState(settings.storage.secure)
	const [editing, setEditing] = useState(false)
	const [label, setLabel] = useState(c.label)
	const [baseUrl, setBaseUrl] = useState(c.baseUrl)
	const [protocol, setProtocol] = useState(c.protocol)
	const [auth, setAuth] = useState(c.auth)
	const [contextWindow, setContextWindow] = useState(c.contextWindow ? String(c.contextWindow) : '')
	const [manual, setManual] = useState('')
	const [probing, setProbing] = useState<string | null>(null)
	const [modelQuery, setModelQuery] = useState('')
	const presetNote = provider?.presets.find((x) => x.id === c.preset)?.note ?? null
	if (!provider) return null
	const needsKey = c.auth === 'api-key'
	const endpointChanges = baseUrl !== c.baseUrl || protocol !== c.protocol || auth !== c.auth
	const models = c.models.filter(
		(m) => !modelQuery || m.id.toLowerCase().includes(modelQuery.toLowerCase()) || m.label.toLowerCase().includes(modelQuery.toLowerCase()),
	)

	return (
		<div className="form">
			<div className="detail-head">
				<h3 className="ellipsis">{c.label}</h3>
				<span className={`status-pill ${c.status}`}>{STATUS_TEXT[c.status]}</span>
			</div>
			<div className="muted small mono ellipsis" title={c.baseUrl}>
				{provider.label} · {provider.protocols.find((x) => x.protocol === c.protocol)?.label} · {c.baseUrl}
			</div>
			{c.statusDetail && c.status !== 'failed' && <div className="small muted">{c.statusDetail}</div>}
			{presetNote && <div className="notice small">{presetNote}</div>}

			{needsKey && (
				<form
					className="key-form"
					onSubmit={async (e) => {
						e.preventDefault()
						const ok = await run(window.review.setCredential(c.id, key, persist))
						setKey('') // never keep the key in renderer state after submitting
						if (ok) await run(window.review.testConnection(c.id))
					}}
				>
					<label className="field">
						<span>API key</span>
						<div className="key-row">
							<input
								type="password"
								autoComplete="off"
								spellCheck={false}
								value={key}
								onChange={(e) => setKey(e.target.value)}
								placeholder={
									c.credential === 'saved'
										? 'Saved — enter a new key to replace it'
										: c.credential === 'session'
											? 'Set for this session — enter to replace'
											: provider.keyPlaceholder
								}
								aria-describedby="key-help"
							/>
							<button type="submit" className="btn small primary" disabled={key.trim().length < 8}>
								{c.credential === 'none' || c.credential === 'unreadable' ? 'Save and test' : 'Replace and test'}
							</button>
						</div>
					</label>
					<div id="key-help" className="muted small">
						{c.credential === 'saved' && 'A key is saved in the system keychain. It is never shown again.'}
						{c.credential === 'session' && 'A key is held in memory for this session only; it is forgotten when the app quits.'}
						{c.credential === 'none' && 'No key saved.'}
						{c.credential === 'unreadable' && 'The saved key could not be read. Enter it again.'}{' '}
						{provider.keyHelpUrl && (
							<a href={provider.keyHelpUrl} target="_blank" rel="noreferrer">
								Get a key
							</a>
						)}
					</div>
					<label className="check">
						<input type="checkbox" checked={persist} disabled={!settings.storage.secure} onChange={(e) => setPersist(e.target.checked)} />
						{settings.storage.secure ? 'Save in the system keychain' : 'Session only (secure storage unavailable)'}
					</label>
				</form>
			)}

			<div className="row-actions">
				<button
					className="btn small"
					onClick={() => void run(window.review.testConnection(c.id))}
					disabled={c.status === 'testing' || (needsKey && c.credential !== 'saved' && c.credential !== 'session')}
				>
					{c.status === 'testing' ? 'Testing…' : 'Test connection'}
				</button>
				<span className="muted small">{provider.testExplains}</span>
			</div>
			{c.lastTest && (
				<div className={`small ${c.lastTest.ok ? 'ok-text' : 'error-text'}`}>
					{c.lastTest.message} <span className="muted">({new Date(c.lastTest.at).toLocaleString()})</span>
				</div>
			)}

			<div className="section-title">Models</div>
			<div className="muted small">
				{c.modelsFetchedAt
					? `Listed by the provider ${new Date(c.modelsFetchedAt).toLocaleString()}.`
					: `Catalog entries (updated ${settings.catalogUpdated}) are suggestions until the connection is tested.`}{' '}
				“Test model” sends one small synthetic request (no repository content) to confirm structured output.
			</div>
			{c.models.length > 8 && (
				<input
					className="search"
					type="search"
					placeholder="Search models"
					value={modelQuery}
					onChange={(e) => setModelQuery(e.target.value)}
				/>
			)}
			<div className="model-list" role="list">
				{models.length === 0 && <div className="muted small">No models yet. Test the connection or add a model ID below.</div>}
				{models.map((m) => (
					<div key={m.id} className="model-row" role="listitem">
						<label className="radio" title="Default model for this connection">
							<input
								type="radio"
								name={`default-${c.id}`}
								checked={c.defaultModel === m.id}
								onChange={() => void run(window.review.updateConnection(c.id, { defaultModel: m.id }))}
							/>
						</label>
						<span className="model-name">
							<span className="ellipsis">{m.label}</span>
							{m.label !== m.id && <span className="muted mono small ellipsis">{m.id}</span>}
						</span>
						<span className="spacer" />
						{m.contextWindow && <span className="muted small nowrap">{Math.round(m.contextWindow / 1000)}k ctx</span>}
						<span className={`src-tag ${m.probe ? (m.probe.ok ? 'ok' : 'bad') : m.source}`} title={sourceTitle(m)}>
							{m.probe && !m.probe.ok ? 'Failed test' : sourceLabel(m)}
						</span>
						<button
							className="btn small ghost"
							disabled={probing !== null || c.status === 'testing' || (needsKey && c.credential !== 'saved' && c.credential !== 'session')}
							onClick={async () => {
								setProbing(m.id)
								await run(window.review.probeModel(c.id, m.id))
								setProbing(null)
							}}
						>
							{probing === m.id ? 'Testing…' : 'Test model'}
						</button>
						{m.source === 'manual' && (
							<button
								className="btn small ghost danger"
								onClick={() => void run(window.review.removeModel(c.id, m.id))}
								aria-label={`Remove ${m.id}`}
							>
								Remove
							</button>
						)}
					</div>
				))}
			</div>
			<form
				className="key-row"
				onSubmit={async (e) => {
					e.preventDefault()
					if (await run(window.review.addModel(c.id, manual.trim()))) setManual('')
				}}
			>
				<input
					className="mono"
					value={manual}
					onChange={(e) => setManual(e.target.value)}
					placeholder="Add a model ID manually"
					spellCheck={false}
					aria-label="Model ID"
				/>
				<button type="submit" className="btn small" disabled={!manual.trim()}>
					Add model
				</button>
			</form>

			<details className="edit-details" open={editing} onToggle={(e) => setEditing((e.target as HTMLDetailsElement).open)}>
				<summary>Connection settings</summary>
				<EndpointFields
					provider={provider}
					label={label}
					setLabel={setLabel}
					baseUrl={baseUrl}
					setBaseUrl={setBaseUrl}
					protocol={protocol}
					setProtocol={setProtocol}
					auth={auth}
					setAuth={setAuth}
					contextWindow={contextWindow}
					setContextWindow={setContextWindow}
				/>
				{endpointChanges && needsKey && (
					<div className="notice">
						Changing the endpoint, API or authentication removes the saved key. You will need to enter it again for the new endpoint.
					</div>
				)}
				<div className="form-actions">
					<button
						className="btn small"
						onClick={async () => {
							if (
								endpointChanges &&
								c.credential !== 'not-required' &&
								c.credential !== 'none' &&
								!window.confirm('This removes the saved key for this connection. Continue?')
							)
								return
							await run(
								window.review.updateConnection(c.id, {
									label,
									...(provider.endpointEditable ? { baseUrl } : {}),
									...(provider.protocols.length > 1 ? { protocol } : {}),
									...(provider.authMethods.length > 1 ? { auth } : {}),
									...(provider.contextWindowEditable ? { contextWindow: contextWindow ? Number(contextWindow) : null } : {}),
								}),
							)
						}}
					>
						Save settings
					</button>
				</div>
			</details>

			<div className="danger-zone">
				<button
					className="btn small ghost danger"
					onClick={async () => {
						if (!window.confirm(`Disconnect ${c.label}? The saved key is deleted. Past AI reviews stay readable.`)) return
						if (await run(window.review.removeConnection(c.id))) onRemoved()
					}}
				>
					Disconnect {c.label}
				</button>
			</div>
		</div>
	)
}

function FindingLevels({ settings, run }: { settings: AiSettingsView; run(p: Promise<Result<AiSettingsView>>): Promise<boolean> }) {
	const { enabled, autoAdd } = settings.levels
	const save = (next: FindingLevelSettings): void => void run(window.review.setFindingLevels(next))
	const toggle = (list: Array<FindingLevel>, l: FindingLevel, on: boolean): Array<FindingLevel> =>
		FINDING_LEVELS.filter((x) => (x === l ? on : list.includes(x)))
	return (
		<details className="limits">
			<summary>Finding levels</summary>
			<table className="level-table">
				<thead>
					<tr>
						<th>Level</th>
						<th className="level-toggle">Reviewer uses it</th>
						<th className="level-toggle">Add to code when a run finishes</th>
					</tr>
				</thead>
				<tbody>
					{FINDING_LEVELS.map((l) => {
						const meta = LEVEL_META[l]
						const on = enabled.includes(l)
						return (
							<tr key={l} className={on ? '' : 'off'}>
								<td>
									<div className="level-name">
										<span className={`sev ${l}`}>{meta.label}</span>
										<span className="level-hint">{meta.hint}</span>
									</div>
								</td>
								<td className="level-toggle">
									<input
										type="checkbox"
										aria-label={`Reviewer uses ${meta.label}`}
										checked={on}
										disabled={on && enabled.length === 1}
										title={on && enabled.length === 1 ? 'At least one level must stay on' : undefined}
										onChange={(e) => {
											const next = toggle(enabled, l, e.target.checked)
											save({ enabled: next, autoAdd: autoAdd.filter((x) => next.includes(x)) })
										}}
									/>
								</td>
								<td className="level-toggle">
									<input
										type="checkbox"
										aria-label={`Add ${meta.label} findings to the code`}
										checked={on && autoAdd.includes(l)}
										disabled={!on}
										onChange={(e) => save({ enabled, autoAdd: toggle(autoAdd, l, e.target.checked) })}
									/>
								</td>
							</tr>
						)
					})}
				</tbody>
			</table>
			<div className="muted small">
				The reviewer is only told about the levels that are on, and findings at a level that is off are listed as rejected. Findings added
				to the code become your comments: nothing is posted until you publish, and you can edit or delete them first. Changes apply to the
				next run.
			</div>
		</details>
	)
}

function Limits({ settings, run }: { settings: AiSettingsView; run(p: Promise<Result<AiSettingsView>>): Promise<boolean> }) {
	const [v, setV] = useState(settings.limits)
	const changed =
		v.contextLines !== settings.limits.contextLines ||
		v.maxBatchChars !== settings.limits.maxBatchChars ||
		v.maxRunChars !== settings.limits.maxRunChars ||
		v.relatedCode !== settings.limits.relatedCode ||
		v.lookups !== settings.limits.lookups ||
		v.verify !== settings.limits.verify ||
		v.groupDuplicates !== settings.limits.groupDuplicates
	return (
		<details className="limits">
			<summary>Review input limits</summary>
			<div className="limits-row">
				<label className="field">
					<span>Context lines</span>
					<input
						type="number"
						min={0}
						max={500}
						value={v.contextLines}
						onChange={(e) => setV({ ...v, contextLines: Number(e.target.value) })}
					/>
				</label>
				<label className="field">
					<span>Characters per request</span>
					<input
						type="number"
						min={8000}
						step={1000}
						value={v.maxBatchChars}
						onChange={(e) => setV({ ...v, maxBatchChars: Number(e.target.value) })}
					/>
				</label>
				<label className="field">
					<span>Characters per run</span>
					<input
						type="number"
						min={8000}
						step={10000}
						value={v.maxRunChars}
						onChange={(e) => setV({ ...v, maxRunChars: Number(e.target.value) })}
					/>
				</label>
				<button className="btn small" disabled={!changed} onClick={() => void run(window.review.setReviewLimits(v))}>
					Save limits
				</button>
			</div>
			<label className="option">
				<input type="checkbox" checked={v.relatedCode} onChange={(e) => setV({ ...v, relatedCode: e.target.checked })} />
				<span>
					<span>Include related code</span>
					<span className="muted">Also send code from other files that defines or uses the names the change touches.</span>
				</span>
			</label>
			<label className="option">
				<input type="checkbox" checked={v.lookups} onChange={(e) => setV({ ...v, lookups: e.target.checked })} />
				<span>
					<span>Let the reviewer look things up</span>
					<span className="muted">
						The model can open files and search the reviewed commits when it needs more. Slower, uses more tokens.
					</span>
				</span>
			</label>
			<label className="option">
				<input type="checkbox" checked={v.verify} onChange={(e) => setV({ ...v, verify: e.target.checked })} />
				<span>
					<span>Double-check blocking findings</span>
					<span className="muted">
						After the review, each blocking finding gets a second request that tries to prove it wrong. One more request per blocking
						finding, at most 8 per run.
					</span>
				</span>
			</label>
			<label className="option">
				<input type="checkbox" checked={v.groupDuplicates} onChange={(e) => setV({ ...v, groupDuplicates: e.target.checked })} />
				<span>
					<span>Group duplicate findings</span>
					<span className="muted">
						After the review, ask the model which findings are the same problem at different places, and show them as one. One more request
						per run.
					</span>
				</span>
			</label>
			<div className="muted small limits-note">
				Requests shrink automatically to fit the model. Anything over a limit is listed as skipped.
			</div>
		</details>
	)
}
