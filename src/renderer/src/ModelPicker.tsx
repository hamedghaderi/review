import { useEffect, useMemo, useRef, useState } from 'react'
import type { AiSettingsView, ConnectionView, ModelSelection, ModelView } from '../../shared/types.ts'

interface Props {
	settings: AiSettingsView | null
	selection: ModelSelection | null
	disabled: boolean
	onSelect(selection: ModelSelection): void
	onSelectTeam(teamId: string): void
	onManage(team?: 'new' | string): void
}

export function sourceLabel(m: ModelView): string {
	if (m.probe?.ok) return 'Tested'
	if (m.source === 'discovered') return 'Available'
	if (m.source === 'manual') return 'Manual'
	return 'Catalog'
}

export function sourceTitle(m: ModelView): string {
	if (m.probe) return m.probe.message
	if (m.source === 'discovered') return 'Listed by the provider for this key.'
	if (m.source === 'manual') return 'Entered manually; not confirmed by the provider.'
	return 'From the built-in catalog; account access is not verified until the connection is tested.'
}

/** Only connections that can run a review appear in the picker. */
function usable(c: ConnectionView): boolean {
	return c.status === 'connected' || c.status === 'testing'
}

/**
 * Compact provider/model picker. Keyboard: ↑/↓ move, Enter selects, Esc closes; typing filters.
 * Shows "Connect AI provider" when nothing is usable.
 */
export function ModelPicker({ settings, selection, disabled, onSelect, onSelectTeam, onManage }: Props) {
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState('')
	const [cursor, setCursor] = useState(0)
	const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)
	const ref = useRef<HTMLDivElement>(null)
	const input = useRef<HTMLInputElement>(null)

	const connections = settings?.connections.filter(usable) ?? []
	const activeTeam =
		settings?.reviewer?.kind === 'team' ? settings.teams.find((t) => t.id === (settings.reviewer as { teamId: string }).teamId) : undefined
	const current = !activeTeam && selection ? connections.find((c) => c.id === selection.connectionId) : undefined
	const currentModel = current?.models.find((m) => m.id === selection?.modelId)
	const teams = (settings?.teams ?? []).filter((t) => !query.trim() || t.name.toLowerCase().includes(query.trim().toLowerCase()))

	const groups = useMemo(() => {
		const q = query.trim().toLowerCase()
		return connections
			.map((c) => ({
				connection: c,
				models: c.models.filter(
					(m) => !q || m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q) || c.label.toLowerCase().includes(q),
				),
			}))
			.filter((g) => g.models.length > 0)
	}, [connections, query])
	const flat: Array<{ connectionId: string; modelId: string } | { teamId: string }> = [
		...teams.map((t) => ({ teamId: t.id })),
		...groups.flatMap((g) => g.models.map((m) => ({ connectionId: g.connection.id, modelId: m.id }))),
	]

	useEffect(() => {
		if (!open) return
		setCursor(
			Math.max(
				0,
				flat.findIndex((f) =>
					'teamId' in f
						? f.teamId === activeTeam?.id
						: !activeTeam && f.connectionId === selection?.connectionId && f.modelId === selection?.modelId,
				),
			),
		)
		input.current?.focus()
		function onDown(e: MouseEvent): void {
			if (!ref.current?.contains(e.target as Node)) setOpen(false)
		}
		window.addEventListener('mousedown', onDown)
		return () => window.removeEventListener('mousedown', onDown)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open])

	if (!settings) return null
	if (connections.length === 0) {
		return (
			<button className="btn" onClick={() => onManage()} title="Connect an AI provider to run AI reviews. Manual review works without one.">
				Connect AI provider
			</button>
		)
	}

	function toggle(): void {
		const rect = ref.current?.getBoundingClientRect()
		if (rect) setAnchor({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) })
		setQuery('')
		setOpen((x) => !x)
	}

	function choose(i: number): void {
		const f = flat[i]
		if (!f) return
		if ('teamId' in f) onSelectTeam(f.teamId)
		else onSelect(f)
		setOpen(false)
	}

	function onKey(e: React.KeyboardEvent): void {
		if (e.key === 'ArrowDown') {
			e.preventDefault()
			setCursor((c) => Math.min(flat.length - 1, c + 1))
		} else if (e.key === 'ArrowUp') {
			e.preventDefault()
			setCursor((c) => Math.max(0, c - 1))
		} else if (e.key === 'Enter') {
			e.preventDefault()
			choose(cursor)
		} else if (e.key === 'Escape') {
			e.preventDefault()
			setOpen(false)
		}
	}

	const label = activeTeam
		? `${activeTeam.name} · ${activeTeam.members.length} reviewers`
		: current && currentModel
			? `${current.label} · ${currentModel.label}`
			: 'Choose model'
	let index = -1
	return (
		<div className="ai-control" ref={ref}>
			<button
				className={`btn model-btn ${!current && !activeTeam ? 'warn' : ''} ${activeTeam?.issues.length ? 'warn' : ''}`}
				onClick={toggle}
				aria-haspopup="listbox"
				aria-expanded={open}
				disabled={disabled}
				title={
					activeTeam
						? activeTeam.issues.map((i) => i.message).join('\n') || activeTeam.members.map((m) => `${m.role}: ${m.modelId}`).join('\n')
						: (settings.selectionIssue ?? (currentModel ? sourceTitle(currentModel) : 'Choose the model for the next AI review'))
				}
			>
				<span className="ellipsis">{label}</span>
				<span className="chev-down" aria-hidden>
					▾
				</span>
			</button>
			{open && (
				<div className="popover picker" style={anchor ?? undefined} onKeyDown={onKey}>
					<input
						ref={input}
						className="search"
						type="search"
						placeholder="Search models"
						value={query}
						onChange={(e) => {
							setQuery(e.target.value)
							setCursor(0)
						}}
						aria-label="Search models"
						aria-controls="model-list"
					/>
					<div className="picker-list" role="listbox" id="model-list" aria-label="Models">
						<div role="group" aria-label="Review teams">
							<div className="section-title picker-group">Review teams</div>
							{teams.map((t) => {
								index++
								const i = index
								const selected = activeTeam?.id === t.id
								return (
									<div
										key={t.id}
										role="option"
										aria-selected={selected}
										className={`picker-item ${i === cursor ? 'active' : ''} ${selected ? 'selected' : ''}`}
										onMouseEnter={() => setCursor(i)}
										onClick={() => choose(i)}
										title={t.members.map((m) => `${m.role}: ${m.modelId}`).join('\n')}
									>
										<span className="picker-check" aria-hidden>
											{selected ? '✓' : ''}
										</span>
										<span className="picker-team">
											<span className="ellipsis">{t.name}</span>
											<span className="muted small ellipsis">{t.members.map((m) => m.role).join(' · ')}</span>
										</span>
										{t.issues.length ? (
											<span className="src-tag bad">Needs attention</span>
										) : (
											<span className="src-tag team">Team · {t.members.length}</span>
										)}
									</div>
								)
							})}
							<div
								className="picker-item"
								onClick={() => {
									setOpen(false)
									onManage('new')
								}}
							>
								<span className="picker-check" aria-hidden />
								<span className="muted">+ New review team…</span>
							</div>
						</div>
						{groups.length === 0 && <div className="muted small pad">No models match.</div>}
						{groups.map((g) => (
							<div key={g.connection.id} role="group" aria-label={g.connection.label}>
								<div className="section-title picker-group">
									{g.connection.label}
									{g.connection.label !== g.connection.providerLabel && <span className="muted"> · {g.connection.providerLabel}</span>}
								</div>
								{g.models.map((m) => {
									index++
									const i = index
									const selected = !activeTeam && selection?.connectionId === g.connection.id && selection?.modelId === m.id
									return (
										<div
											key={m.id}
											role="option"
											aria-selected={selected}
											className={`picker-item ${i === cursor ? 'active' : ''} ${selected ? 'selected' : ''}`}
											onMouseEnter={() => setCursor(i)}
											onClick={() => choose(i)}
											title={sourceTitle(m)}
										>
											<span className="picker-check" aria-hidden>
												{selected ? '✓' : ''}
											</span>
											<span className="ellipsis">{m.label}</span>
											{m.label !== m.id && <span className="muted mono small ellipsis">{m.id}</span>}
											<span className="spacer" />
											<span className={`src-tag ${m.probe ? (m.probe.ok ? 'ok' : 'bad') : m.source}`}>
												{m.probe && !m.probe.ok ? 'Failed test' : sourceLabel(m)}
											</span>
										</div>
									)
								})}
							</div>
						))}
					</div>
					<div className="popover-actions picker-foot">
						<span className="muted small">↑↓ to move · Enter to select</span>
						<span className="spacer" />
						<button
							className="btn small ghost picker-manage"
							onClick={() => {
								setOpen(false)
								onManage()
							}}
						>
							Manage providers…
						</button>
					</div>
				</div>
			)}
		</div>
	)
}
