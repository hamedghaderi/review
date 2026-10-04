import { useEffect, useState } from 'react'
import type { McpImportCandidate, McpServerInput, McpServerView, McpSettingsView, McpTransport, Result } from '../../shared/types.ts'

type Run = (p: Promise<Result<McpSettingsView>>) => Promise<boolean>

const TRANSPORTS: Array<{ id: McpTransport; label: string; hint: string }> = [
	{ id: 'stdio', label: 'Command', hint: 'The app starts the server on this computer, like `claude mcp add name -- npx …`.' },
	{ id: 'http', label: 'HTTP', hint: 'A remote server at a URL (Streamable HTTP).' },
	{ id: 'sse', label: 'SSE', hint: 'A remote server using the older Server-Sent Events transport.' },
]

/** "KEY=value" lines; blank lines and lines without "=" are ignored. */
function parsePairs(text: string, sep: '=' | ':'): Record<string, string> {
	const out: Record<string, string> = {}
	for (const raw of text.split('\n')) {
		const line = raw.trim()
		const i = line.indexOf(sep)
		if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
	}
	return out
}

/** Splits "npx -y @scope/server --flag" into a command and arguments, honoring simple quotes. */
function splitCommand(line: string): Array<string> {
	return (line.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((p) => p.replace(/^(["'])(.*)\1$/, '$2'))
}

export function McpServerEditor({
	server,
	repoId,
	lookups,
	secure,
	run,
	onSaved,
	onRemoved,
	onCancel,
}: {
	server: McpServerView | null
	repoId: string | null
	lookups: boolean
	secure: boolean
	run: Run
	onSaved(id: string): void
	onRemoved(): void
	onCancel(): void
}) {
	const [name, setName] = useState(server?.name ?? '')
	const [transport, setTransport] = useState<McpTransport>(server?.transport ?? 'stdio')
	const [command, setCommand] = useState(server ? [server.command, ...server.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ') : '')
	const [url, setUrl] = useState(server?.url ?? '')
	const [enabled, setEnabled] = useState(server?.enabled ?? true)
	// Secret values are never sent back, so editing them means replacing them all.
	const [envText, setEnvText] = useState<string | null>(server ? null : '')
	const [headerText, setHeaderText] = useState<string | null>(server ? null : '')
	const [testing, setTesting] = useState(false)
	const [toolQuery, setToolQuery] = useState('')

	const parts = splitCommand(command)
	const input: McpServerInput = {
		name: name.trim(),
		transport,
		command: transport === 'stdio' ? (parts[0] ?? '') : '',
		args: transport === 'stdio' ? parts.slice(1) : [],
		url: transport === 'stdio' ? '' : url.trim(),
		env: transport === 'stdio' && envText !== null ? parsePairs(envText, '=') : null,
		headers: transport !== 'stdio' && headerText !== null ? parsePairs(headerText, ':') : null,
		enabled,
	}
	const valid = !!input.name && (transport === 'stdio' ? !!input.command : !!input.url)
	const dirty =
		!server ||
		input.name !== server.name ||
		transport !== server.transport ||
		input.command !== server.command ||
		input.args.join('\0') !== server.args.join('\0') ||
		input.url !== server.url ||
		enabled !== server.enabled ||
		input.env !== null ||
		input.headers !== null

	async function save(): Promise<string | null> {
		const r = await window.review.mcpSave(server?.id ?? null, input)
		if (!(await run(Promise.resolve(r)))) return null
		const id = server?.id ?? (r.ok ? r.value.servers.find((s) => s.name === input.name)?.id : undefined) ?? null
		setEnvText(null)
		setHeaderText(null)
		return id
	}

	async function test(id: string): Promise<void> {
		setTesting(true)
		await run(window.review.mcpTest(id, repoId))
		setTesting(false)
	}

	const tools = server?.tools ?? null
	const shownTools = tools?.filter((t) => !toolQuery || `${t.name} ${t.description}`.toLowerCase().includes(toolQuery.toLowerCase())) ?? []
	const setAllowed = (names: Array<string> | null) => server && void run(window.review.mcpSetTools(server.id, names))
	const secretKeys = transport === 'stdio' ? (server?.envKeys ?? []) : (server?.headerKeys ?? [])
	const secretText = transport === 'stdio' ? envText : headerText
	const setSecretText = transport === 'stdio' ? setEnvText : setHeaderText

	return (
		<div className="form">
			<div className="detail-head">
				<h3 className="ellipsis">{server ? server.name : 'Add MCP server'}</h3>
				{server?.lastTest && (
					<span className={`status-pill ${server.lastTest.ok ? 'connected' : 'failed'}`}>
						{server.lastTest.ok ? 'Connected' : 'Failed'}
					</span>
				)}
			</div>
			<p className="muted small">
				Reviewers can call this server’s tools while they review, for context the repository can’t give: the ticket behind a change, library
				docs, error reports. Only tools that look read-only are offered unless you pick others below.
				{server?.origin && ` Imported from ${server.origin}.`}
			</p>
			{!lookups && (
				<div className="notice small">MCP tools are offered together with lookups, which are turned off under Limits below.</div>
			)}

			<label className="field">
				<span>Name</span>
				<input value={name} onChange={(e) => setName(e.target.value)} placeholder="jira" spellCheck={false} maxLength={40} />
			</label>

			<div className="field">
				<span>Connection</span>
				<div className="seg" role="radiogroup" aria-label="Transport">
					{TRANSPORTS.map((t) => (
						<button
							key={t.id}
							role="radio"
							aria-checked={transport === t.id}
							className={transport === t.id ? 'on' : ''}
							onClick={() => setTransport(t.id)}
						>
							{t.label}
						</button>
					))}
				</div>
				<div className="muted small">{TRANSPORTS.find((t) => t.id === transport)!.hint}</div>
			</div>

			{transport === 'stdio' ? (
				<label className="field">
					<span>Command</span>
					<input
						className="mono"
						value={command}
						onChange={(e) => setCommand(e.target.value)}
						placeholder="npx -y @modelcontextprotocol/server-github"
						spellCheck={false}
					/>
					<span className="muted small field-note">Runs in the open repository’s folder, with your login shell’s PATH.</span>
				</label>
			) : (
				<label className="field">
					<span>URL</span>
					<input
						className="mono"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						placeholder="https://mcp.example.com/mcp"
						spellCheck={false}
					/>
				</label>
			)}

			<div className="field">
				<span>{transport === 'stdio' ? 'Environment variables' : 'Headers'}</span>
				{secretText === null ? (
					<div className="key-row">
						<span className="muted small mono ellipsis">
							{secretKeys.length ? secretKeys.map((k) => `${k}${transport === 'stdio' ? '=' : ': '}••••`).join('   ') : 'None'}
						</span>
						<button className="btn small" onClick={() => setSecretText('')}>
							{secretKeys.length ? 'Replace…' : 'Add…'}
						</button>
					</div>
				) : (
					<textarea
						className="mono secret-text"
						rows={3}
						value={secretText}
						onChange={(e) => setSecretText(e.target.value)}
						placeholder={transport === 'stdio' ? 'GITHUB_TOKEN=ghp_…\nJIRA_URL=https://…' : 'Authorization: Bearer …'}
						spellCheck={false}
						autoComplete="off"
					/>
				)}
				<span className="muted small field-note">
					One per line.{' '}
					{secure ? 'Saved in the system keychain and never shown again.' : 'Kept for this session only: secure storage is not available.'}{' '}
					<code>{'${VAR}'}</code> refers to a variable from your shell.
					{server?.secretsState === 'unreadable' && ' The saved values could not be read; enter them again.'}
				</span>
			</div>

			<label className="option">
				<input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
				<span>Offer this server’s tools to reviewers</span>
			</label>

			<div className="form-actions">
				<button
					className="btn primary small"
					disabled={!valid || !dirty || testing}
					onClick={async () => {
						const id = await save()
						if (id) {
							onSaved(id)
							await test(id)
						}
					}}
				>
					{server ? 'Save and test' : 'Add and test'}
				</button>
				{server && (
					<button
						className="btn small"
						disabled={testing || dirty}
						onClick={() => void test(server.id)}
						title={dirty ? 'Save your changes first' : undefined}
					>
						{testing ? 'Connecting…' : 'Test connection'}
					</button>
				)}
				<span className="spacer" />
				{server ? (
					<button
						className="btn small ghost danger"
						onClick={async () => {
							if (window.confirm(`Remove the MCP server ${server.name}?`) && (await run(window.review.mcpRemove(server.id)))) onRemoved()
						}}
					>
						Remove
					</button>
				) : (
					<button className="btn small ghost" onClick={onCancel}>
						Cancel
					</button>
				)}
			</div>
			{server?.lastTest && (
				<div className={`small ${server.lastTest.ok ? 'muted' : 'error-text'}`}>
					{server.lastTest.message} · {new Date(server.lastTest.at).toLocaleString()}
				</div>
			)}

			{tools && (
				<div className="mcp-tools">
					<div className="mcp-tools-head">
						<h4>Tools</h4>
						<span className="muted small">
							{tools.filter((t) => t.allowed).length} of {tools.length} offered
							{server?.customTools ? ' · picked by you' : ' · read-only ones'}
						</span>
						<span className="spacer" />
						{server?.customTools && (
							<button className="btn small ghost" onClick={() => setAllowed(null)} title="Offer only the tools that look read-only">
								Reset to read-only
							</button>
						)}
					</div>
					{tools.length > 8 && (
						<input
							className="search"
							type="search"
							placeholder="Filter tools"
							value={toolQuery}
							onChange={(e) => setToolQuery(e.target.value)}
						/>
					)}
					<div className="mcp-tool-list">
						{shownTools.map((t) => (
							<label key={t.name} className="mcp-tool">
								<input
									type="checkbox"
									checked={t.allowed}
									onChange={(e) => {
										const now = tools.filter((x) => (x.name === t.name ? e.target.checked : x.allowed)).map((x) => x.name)
										setAllowed(now)
									}}
								/>
								<span className="mcp-tool-text">
									<span className="mono">{t.name}</span>
									{t.readOnly === true && <span className="pill small-pill">read-only</span>}
									{t.readOnly === false && <span className="pill small-pill warn">can change things</span>}
									{t.description && <span className="muted small mcp-tool-desc">{t.description}</span>}
								</span>
							</label>
						))}
					</div>
					{tools.some((t) => t.allowed && t.readOnly === false) && (
						<div className="notice small">
							Some offered tools say they can change things. The reviewer is told to only read, but a model can still call them.
						</div>
					)}
				</div>
			)}
		</div>
	)
}

export function McpImport({ repoId, run, onDone }: { repoId: string | null; run: Run; onDone(): void }) {
	const [found, setFound] = useState<Array<McpImportCandidate> | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [picked, setPicked] = useState<Set<string>>(new Set())

	useEffect(() => {
		void window.review.mcpClaudeCandidates(repoId).then((r) => {
			if (!r.ok) return setError(r.error.message)
			setFound(r.value)
			setPicked(new Set(r.value.filter((c) => !c.imported).map((c) => c.key)))
		})
	}, [repoId])

	const SCOPE: Record<McpImportCandidate['scope'], string> = {
		user: 'User',
		local: 'This repository (local)',
		project: 'This repository (.mcp.json)',
	}

	return (
		<div className="form">
			<div className="detail-head">
				<h3>Import from Claude Code</h3>
			</div>
			<p className="muted small">
				Servers you added with <code>claude mcp add</code>: user scope from <code>~/.claude.json</code>
				{repoId ? (
					<>
						, plus this repository’s local scope and its <code>.mcp.json</code>
					</>
				) : (
					' (open a repository to also see its project servers)'
				)}
				. Environment variables and headers are copied into the system keychain.
			</p>
			{error && <div className="error-text small">{error}</div>}
			{found === null && !error && <div className="muted small">Reading Claude Code’s settings…</div>}
			{found?.length === 0 && <div className="muted small">No MCP servers were found in Claude Code’s settings.</div>}
			{found && found.length > 0 && (
				<div className="mcp-tool-list">
					{found.map((c) => (
						<label key={c.key} className={`mcp-tool ${c.imported ? 'off' : ''}`}>
							<input
								type="checkbox"
								disabled={c.imported}
								checked={!c.imported && picked.has(c.key)}
								onChange={(e) => {
									const next = new Set(picked)
									if (e.target.checked) next.add(c.key)
									else next.delete(c.key)
									setPicked(next)
								}}
							/>
							<span className="mcp-tool-text">
								<b>{c.name}</b>
								<span className="pill small-pill">{SCOPE[c.scope]}</span>
								{c.imported && <span className="pill small-pill">already added</span>}
								<span className="muted small mono mcp-tool-desc ellipsis">
									{c.transport === 'stdio' ? [c.command, ...c.args].join(' ') : `${c.transport.toUpperCase()} ${c.url}`}
								</span>
								{(c.envKeys.length > 0 || c.headerKeys.length > 0) && (
									<span className="muted small mcp-tool-desc">
										{c.transport === 'stdio' ? 'Environment' : 'Headers'}: {[...c.envKeys, ...c.headerKeys].join(', ')}
									</span>
								)}
							</span>
						</label>
					))}
				</div>
			)}
			<div className="form-actions">
				<button
					className="btn primary small"
					disabled={!picked.size}
					onClick={async () => {
						if (await run(window.review.mcpImportClaude(repoId, [...picked]))) onDone()
					}}
				>
					Import {picked.size || ''} server{picked.size === 1 ? '' : 's'}
				</button>
				<span className="muted small">Test each one afterwards to see its tools.</span>
			</div>
		</div>
	)
}
