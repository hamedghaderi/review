import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AiSettingsView, GitHubMapping, GitHubStatus, McpSettingsView, Result, ReviewTeam } from '../../shared/types.ts'
import { AddConnection, ConnectionDetail, FindingLevels, Limits, STATUS_TEXT } from './ProviderSettings.tsx'
import { AppClones, AutoReview, GiphyKey, GitHubAccount, GitHubNotifications, GitHubRepoChoice } from './GitHubSettings.tsx'
import { suggestTeam, TeamEditor } from './TeamEditor.tsx'
import { McpImport, McpServerEditor } from './McpSettings.tsx'
import { UsageSettings } from './UsageSettings.tsx'
import { AppearanceSettings } from './AppearanceSettings.tsx'
import { KeymapSettings } from './KeymapSettings.tsx'

/**
 * A page in the settings window. Fixed pages have plain names; pages for one item carry its id after a colon:
 * `connection:<id>`, `add:<kind>:<preset>`, `team:<id>`, `mcp:<id>`.
 */
export type SettingsPage = string

interface Node {
	id: SettingsPage
	label: string
	keywords?: string // more words the search finds the page by
	dot?: string // a status dot: connected, failed, testing, or '' for grey
	meta?: string // muted text on the right
	title?: string // tooltip
	group?: boolean // only a heading: choosing it shows its first page
	children?: Array<Node>
}

// The page shown when settings open without asking for one: the last one shown, as in IDEs.
let lastPage: SettingsPage = 'providers'

/**
 * Settings, in one window: a searchable tree of pages on the left (as in JetBrains IDEs), the chosen page on the right
 * under its path. Every change takes effect as it is made; there is nothing to apply.
 */
export function Settings(props: {
	page: SettingsPage | null
	ai: AiSettingsView
	github: GitHubStatus
	mapping: GitHubMapping | null
	repoId: string | null // the open repository, for MCP servers started in its folder and its Claude Code settings
	onClose(): void
	onAi(view: AiSettingsView): void
	onGitHub(status: GitHubStatus): void
	onChooseRepo(repo: string): void
	onDeleteClone(repoId: string): Promise<boolean>
}) {
	const { ai, github, onClose } = props
	const [page, setPageOnly] = useState<SettingsPage>(props.page ?? lastPage)
	const setPage = (p: SettingsPage): void => {
		lastPage = p
		setError(null)
		setPageOnly(p)
	}
	useEffect(() => {
		lastPage = page
	}, [page])
	const [query, setQuery] = useState('')
	const [folded, setFolded] = useState<Set<string>>(new Set())
	const [error, setError] = useState<string | null>(null)
	const [mcp, setMcp] = useState<McpSettingsView | null>(null)
	// A team being created lives here until it is saved; saved teams are read from the settings.
	const [newTeam, setNewTeam] = useState<ReviewTeam | null>(() =>
		props.page === 'team-new' ? suggestTeam(ai) : props.page === 'persona-new' ? suggestTeam(ai, true) : null,
	)
	const dialog = useRef<HTMLDivElement>(null)
	const search = useRef<HTMLInputElement>(null)

	useEffect(() => {
		void window.review.mcpSettings().then((r) => r.ok && setMcp(r.value))
		return window.review.onMcpSettingsChanged(setMcp)
	}, [])
	useEffect(() => {
		search.current?.focus()
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape') onClose()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [onClose])

	async function run<T extends AiSettingsView>(p: Promise<Result<T>>): Promise<boolean> {
		setError(null)
		const r = await p
		if (!r.ok) {
			setError(r.error.message)
			return false
		}
		props.onAi(r.value)
		return true
	}
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
	async function act(p: Promise<Result<GitHubStatus>>): Promise<void> {
		setError(null)
		const r = await p
		if (!r.ok) setError(r.error.message)
		else props.onGitHub(r.value)
	}

	const canTeam = ai.connections.some((c) => c.status === 'connected' || c.kind === 'fixture')
	const tree: Array<Node> = useMemo(
		() => [
			{ id: 'appearance', label: 'Appearance', keywords: 'theme light dark colour color' },
			{ id: 'keymap', label: 'Keymap', keywords: 'shortcuts keys keyboard hotkeys bindings' },
			{
				id: 'github-group',
				label: 'GitHub',
				group: true,
				dot: github.state === 'connected' ? 'connected' : github.state === 'failed' ? 'failed' : undefined,
				children: [
					{ id: 'github', label: 'Account', keywords: 'token login gh cli personal access api rate limit sign in' },
					{ id: 'notifications', label: 'Notifications', keywords: 'review requests sound dock' },
					{ id: 'auto-review', label: 'Automatic review', keywords: 'approve submit commits ai' },
					...(props.mapping && props.mapping.candidates.length > 0
						? [{ id: 'repo', label: 'This repository', keywords: 'remotes fork upstream pull requests' }]
						: []),
					{ id: 'clones', label: 'Clones', keywords: 'clone for me trash delete disk' },
					{ id: 'gifs', label: 'GIFs', keywords: 'giphy key' },
				],
			},
			{
				id: 'ai',
				label: 'AI review',
				group: true,
				children: [
					{
						id: 'providers',
						label: 'Providers',
						keywords: `connections models api key ${ai.providers.map((p) => p.label).join(' ')}`,
						children: ai.connections.map((c) => ({
							id: `connection:${c.id}`,
							label: c.label,
							dot: c.status,
							title: STATUS_TEXT[c.status],
						})),
					},
					{
						id: 'teams',
						label: 'Review teams',
						keywords: 'persona rules models split',
						children: ai.teams.map((t) => ({
							id: `team:${t.id}`,
							label: t.name,
							dot: t.issues.length ? 'failed' : 'connected',
							meta: `${t.members.length}`,
						})),
					},
					{ id: 'levels', label: 'Finding levels', keywords: 'blocking should fix question nit comments' },
					{ id: 'limits', label: 'Review input', keywords: 'limits context lines batch related code lookups verify duplicates' },
					{
						id: 'mcp',
						label: 'MCP servers',
						keywords: 'tools claude code import',
						children: (mcp?.servers ?? []).map((x) => ({
							id: `mcp:${x.id}`,
							label: x.name,
							dot: !x.enabled ? '' : x.lastTest ? (x.lastTest.ok ? 'connected' : 'failed') : '',
						})),
					},
					{ id: 'usage', label: 'Usage', keywords: 'tokens cost budget spend' },
				],
			},
			{ id: 'about', label: 'About', keywords: 'version' },
		],
		[ai, github.state, props.mapping, mcp],
	)

	// Searching shows the pages whose name or keywords match, with the groups above them, all unfolded.
	const q = query.trim().toLowerCase()
	const shown = useMemo(() => {
		if (!q) return tree
		const filter = (nodes: Array<Node>): Array<Node> =>
			nodes.flatMap((n) => {
				const kids = n.children ? filter(n.children) : []
				const hit = `${n.label} ${n.keywords ?? ''}`.toLowerCase().includes(q)
				return hit || kids.length ? [{ ...n, children: hit && !kids.length ? n.children : kids }] : []
			})
		return filter(tree)
	}, [tree, q])
	// The rows in order, for the arrow keys and for Enter in the search box.
	const rows = useMemo(() => {
		const out: Array<Node> = []
		const walk = (nodes: Array<Node>, key: string): void => {
			for (const n of nodes) {
				out.push(n)
				if (n.children?.length && (q || !folded.has(`${key}/${n.label}`))) walk(n.children, `${key}/${n.label}`)
			}
		}
		walk(shown, '')
		return out
	}, [shown, folded, q])
	const leaf = (n: Node): SettingsPage => (n.group && n.children?.[0] ? n.children[0].id : n.id)

	// The path to the page, for the breadcrumb. A team being created has none in the tree.
	const path = useMemo(() => {
		const find = (nodes: Array<Node>, trail: Array<string>): Array<string> | null => {
			for (const n of nodes) {
				if (!n.group && n.id === page) return [...trail, n.label]
				const deeper = n.children ? find(n.children, [...trail, n.label]) : null
				if (deeper) return deeper
			}
			return null
		}
		if (page === 'team-new' || page === 'persona-new') return ['AI review', 'Review teams', 'New team']
		if (page.startsWith('add:')) {
			const kind = page.split(':')[1]
			return ['AI review', 'Providers', `Add ${ai.providers.find((p) => p.kind === kind)?.label ?? 'provider'}`]
		}
		if (page === 'mcp-new') return ['AI review', 'MCP servers', 'Add server']
		if (page === 'mcp-import') return ['AI review', 'MCP servers', 'Import from Claude Code']
		return find(tree, []) ?? []
	}, [tree, page, ai.providers])

	function onTreeKey(e: React.KeyboardEvent): void {
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
		e.preventDefault()
		const pages = rows.filter((n) => !n.group)
		const at = pages.findIndex((n) => n.id === page)
		const next = pages[Math.max(0, Math.min(pages.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]
		if (next) setPage(leaf(next))
	}

	function renderNodes(nodes: Array<Node>, depth: number, key: string): ReactNode {
		return nodes.map((n) => {
			const k = `${key}/${n.label}`
			const open = !!q || !folded.has(k)
			const kids = !!n.children?.length
			const on = !n.group && n.id === page
			return (
				<Fragment key={k}>
					<div
						className={`tree-row${on ? ' on' : ''}`}
						style={{ paddingLeft: 6 + depth * 14 }}
						role="treeitem"
						aria-selected={on}
						aria-expanded={kids ? open : undefined}
					>
						<button
							className="tree-fold"
							tabIndex={-1}
							aria-hidden={!kids}
							disabled={!kids}
							onClick={() =>
								setFolded((f) => {
									const next = new Set(f)
									if (next.has(k)) next.delete(k)
									else next.add(k)
									return next
								})
							}
						>
							{kids ? (open ? '▾' : '▸') : ''}
						</button>
						<button className="tree-label" tabIndex={-1} title={n.title} onClick={() => setPage(leaf(n))}>
							{n.dot !== undefined && <span className={`dot ${n.dot}`} aria-hidden />}
							<span className="ellipsis">{n.label}</span>
							{n.meta && <span className="muted small nowrap">{n.meta}</span>}
						</button>
					</div>
					{kids && open && renderNodes(n.children!, depth + 1, k)}
				</Fragment>
			)
		})
	}

	const savedTeam = page.startsWith('team:') ? (ai.teams.find((t) => `team:${t.id}` === page) ?? null) : null
	const connection = page.startsWith('connection:') ? (ai.connections.find((c) => `connection:${c.id}` === page) ?? null) : null
	const mcpServer = page.startsWith('mcp:') ? (mcp?.servers.find((x) => `mcp:${x.id}` === page) ?? null) : null

	function body(): ReactNode {
		if (page === 'appearance') return <AppearanceSettings />
		if (page === 'keymap') return <KeymapSettings />
		if (page === 'github') return <GitHubAccount status={github} act={act} />
		if (page === 'notifications') return <GitHubNotifications status={github} act={act} />
		if (page === 'auto-review')
			return (
				<div className="settings-main form">
					<AutoReview
						on={github.autoReview}
						commits={github.autoReviewCommits}
						onSet={(enabled) => act(window.review.githubSetAutoReview(enabled))}
						onSetCommits={(enabled) => act(window.review.githubSetAutoReviewCommits(enabled))}
					/>
				</div>
			)
		if (page === 'repo' && props.mapping) return <GitHubRepoChoice mapping={props.mapping} onChoose={props.onChooseRepo} />
		if (page === 'clones')
			return (
				<div className="settings-main form">
					<AppClones onDelete={props.onDeleteClone} />
				</div>
			)
		if (page === 'gifs')
			return (
				<div className="settings-main form">
					<GiphyKey />
				</div>
			)
		if (page === 'providers')
			return (
				<div className="settings-main form">
					<h3>Providers</h3>
					{ai.connections.length === 0 ? (
						<p className="muted small">No providers connected. Manual review works without one.</p>
					) : (
						<div className="settings-list">
							{ai.connections.map((c) => (
								<button key={c.id} className="conn-item" onClick={() => setPage(`connection:${c.id}`)}>
									<span className={`dot ${c.status}`} aria-hidden />
									<span className="ellipsis">{c.label}</span>
									<span className="muted small nowrap">{STATUS_TEXT[c.status]}</span>
								</button>
							))}
						</div>
					)}
					<h3 className="small-h">Add a provider</h3>
					<div className="add-grid">
						{ai.providers.flatMap((p) => {
							const exists = !p.multiple && ai.connections.some((c) => c.kind === p.kind)
							// Providers with presets (e.g. local servers) get one entry per preset, so each is findable by name.
							const entries = p.presets.length
								? p.presets.map((x) => ({ preset: x.id as string | null, label: x.label, title: x.note ?? p.description }))
								: [{ preset: null, label: p.label, title: p.description }]
							return entries.map((e) => (
								<button
									key={`${p.kind}:${e.preset ?? ''}`}
									className="btn add-card"
									disabled={exists}
									onClick={() => setPage(`add:${p.kind}:${e.preset ?? ''}`)}
									title={exists ? 'Already connected' : e.title}
								>
									<span className="ellipsis">{e.label}</span>
									{p.development && <span className="pill warn">Dev</span>}
								</button>
							))
						})}
					</div>
				</div>
			)
		if (page.startsWith('add:')) {
			const [, kind, preset] = page.split(':')
			const provider = ai.providers.find((p) => p.kind === kind)
			if (provider)
				return (
					<AddConnection
						key={page}
						provider={provider}
						initialPreset={preset || null}
						onCancel={() => setPage('providers')}
						onCreate={async (input) => {
							const r = await window.review.createConnection(input)
							if (!r.ok) {
								setError(r.error.message)
								return
							}
							props.onAi(r.value)
							const created = r.value.connections.find((c) => !ai.connections.some((o) => o.id === c.id))
							setPage(created ? `connection:${created.id}` : 'providers')
						}}
					/>
				)
		}
		if (connection)
			return (
				<ConnectionDetail
					key={connection.id}
					connection={connection}
					provider={ai.providers.find((p) => p.kind === connection.kind)}
					settings={ai}
					run={run}
					onRemoved={() => setPage('providers')}
				/>
			)
		if (page === 'teams')
			return (
				<div className="settings-main form">
					<h3>Review teams</h3>
					<p className="muted small">
						A team splits the review rules between several models, or between personas that each check what they care about most.
					</p>
					{ai.teams.length > 0 && (
						<div className="settings-list">
							{ai.teams.map((t) => (
								<button
									key={t.id}
									className="conn-item"
									onClick={() => setPage(`team:${t.id}`)}
									title={t.issues.map((i) => i.message).join('\n') || undefined}
								>
									<span className={`dot ${t.issues.length ? 'failed' : 'connected'}`} aria-hidden />
									<span className="ellipsis">{t.name}</span>
									<span className="muted small nowrap">
										{t.members.length} reviewer{t.members.length === 1 ? '' : 's'}
									</span>
								</button>
							))}
						</div>
					)}
					<div className="form-actions start">
						<button
							className="btn"
							disabled={!canTeam}
							title="Split the review rules between several models"
							onClick={() => {
								setNewTeam(suggestTeam(ai))
								setPage('team-new')
							}}
						>
							New review team
						</button>
						<button
							className="btn"
							disabled={!canTeam}
							title="A team of personas (Clean Code, Test-driven, Pragmatic, Performance, Security, API steward), each checking the rules it cares about most"
							onClick={() => {
								setNewTeam(suggestTeam(ai, true))
								setPage('persona-new')
							}}
						>
							New persona team
						</button>
					</div>
					{!canTeam && <p className="muted small">Connect a provider first.</p>}
				</div>
			)
		const team = savedTeam ?? ((page === 'team-new' || page === 'persona-new') && newTeam ? newTeam : null)
		if (team) {
			const isNew = !savedTeam
			return (
				<TeamEditor
					key={team.id}
					settings={ai}
					team={team}
					isNew={isNew}
					onCancel={() => setPage('teams')}
					onSave={async (t) => {
						const ok = await run(window.review.saveTeam(t))
						if (ok) {
							if (isNew) await run(window.review.selectTeam(t.id))
							setNewTeam(null)
							setPage(`team:${t.id}`)
						}
						return ok
					}}
					onRemove={async () => {
						if (!window.confirm(`Delete ${team.name}?`)) return
						if (await run(window.review.removeTeam(team.id))) setPage('teams')
					}}
				/>
			)
		}
		if (page === 'levels')
			return (
				<div className="settings-main">
					<FindingLevels settings={ai} run={run} />
				</div>
			)
		if (page === 'limits')
			return (
				<div className="settings-main">
					<Limits settings={ai} run={run} />
				</div>
			)
		if (page === 'mcp')
			return (
				<div className="settings-main form">
					<h3>MCP servers</h3>
					<p className="muted small">Give reviewers tools from an MCP server.</p>
					{!!mcp?.servers.length && (
						<div className="settings-list">
							{mcp.servers.map((x) => (
								<button key={x.id} className="conn-item" onClick={() => setPage(`mcp:${x.id}`)} title={x.lastTest?.message}>
									<span className={`dot ${!x.enabled ? '' : x.lastTest ? (x.lastTest.ok ? 'connected' : 'failed') : ''}`} aria-hidden />
									<span className="ellipsis">{x.name}</span>
									<span className="muted small nowrap">
										{!x.enabled ? 'Off' : x.tools ? `${x.tools.filter((t) => t.allowed).length} tools` : 'Not tested'}
									</span>
								</button>
							))}
						</div>
					)}
					<div className="form-actions start">
						<button className="btn" onClick={() => setPage('mcp-new')}>
							Add MCP server
						</button>
						<button className="btn" onClick={() => setPage('mcp-import')}>
							Import from Claude Code
						</button>
					</div>
				</div>
			)
		if (page === 'mcp-import') return <McpImport repoId={props.repoId} run={mcpRun} onDone={() => setPage('mcp')} />
		if (page === 'mcp-new' || mcpServer)
			return (
				<McpServerEditor
					key={mcpServer?.id ?? 'new'}
					server={mcpServer}
					repoId={props.repoId}
					lookups={ai.limits.lookups !== false}
					secure={mcp?.secureStorage ?? false}
					run={mcpRun}
					onSaved={(id) => setPage(`mcp:${id}`)}
					onRemoved={() => setPage('mcp')}
					onCancel={() => setPage('mcp')}
				/>
			)
		if (page === 'usage') return <UsageSettings connections={ai.connections} />
		if (page === 'about')
			return (
				<div className="settings-main form">
					<h3>Review</h3>
					<p className="muted selectable">Version {__APP_VERSION__}</p>
				</div>
			)
		return <div className="muted">This page is no longer here. Choose another on the left.</div>
	}

	return (
		<div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className="modal settings" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} ref={dialog}>
				<div className="modal-head">
					<h2 id="settings-title">Settings</h2>
					<span className="spacer" />
					<button className="btn small ghost" onClick={onClose} aria-label="Close settings">
						✕
					</button>
				</div>
				<div className="settings-body">
					<nav className="settings-nav" aria-label="Settings pages">
						<input
							ref={search}
							className="settings-search"
							type="search"
							placeholder="Search settings"
							aria-label="Search settings"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter' && rows[0]) setPage(leaf(rows.find((n) => !n.group) ?? rows[0]))
								else onTreeKey(e)
							}}
						/>
						<div className="settings-tree" role="tree" aria-label="Settings" tabIndex={0} onKeyDown={onTreeKey}>
							{rows.length ? renderNodes(shown, 0, '') : <div className="muted small pad">Nothing matches “{query.trim()}”.</div>}
						</div>
					</nav>
					<section className="settings-page">
						<div className="settings-crumbs" aria-label="Path">
							{path.map((p, i) => (
								<Fragment key={i}>
									{i > 0 && <span className="crumb-sep">›</span>}
									<span className={i === path.length - 1 ? 'crumb-on' : ''}>{p}</span>
								</Fragment>
							))}
						</div>
						{(!ai.storage.secure && ai.storage.message) || (!github.storage.secure && github.storage.message) ? (
							<div className="notice">{ai.storage.message ?? github.storage.message}</div>
						) : null}
						{error && (
							<button className="notice error-notice" onClick={() => setError(null)} title="Dismiss">
								{error} ✕
							</button>
						)}
						<div className="settings-scroll">{body()}</div>
					</section>
				</div>
			</div>
		</div>
	)
}
