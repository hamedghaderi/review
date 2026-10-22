import { useMemo, useState } from 'react'
import {
	CLI_CONCURRENCY,
	DEFAULT_TEAM_ROLES,
	REVIEW_RULES,
	sharedLogins,
	type AiSettingsView,
	type ConnectionView,
	type ReviewRule,
	type ReviewTeam,
	type TeamMember,
} from '../../shared/types.ts'
import { RULE_LABEL } from './FindingsPanel.tsx'
import { baseModel, effortOf, effortsFor, listed, withEffort } from './efforts.ts'
import { personaOf, REVIEW_PERSONAS, type PersonaId } from '../../shared/personas.ts'

// Model names that suit each default role; models are filled in by `suggestTeam`.
const HINTS: Record<string, RegExp> = {
	defects: /codex|gpt-?5|gpt-?6|o\d/i,
	security: /claude|opus|sonnet/i,
	callers: /gemini|gpt|claude/i,
	tests: /mini|flash|haiku|small|nano/i,
}

/** Roles a new team starts with. Each rule belongs to exactly one role. */
const DEFAULT_ROLES: Array<StartingRole> = DEFAULT_TEAM_ROLES.map((r) => ({
	role: r.role,
	rules: [...r.rules],
	hint: HINTS[r.id],
}))

// Each persona takes the hint of the default role whose rules it shares.
const PERSONA_HINTS: Record<PersonaId, RegExp> = {
	'clean-code': HINTS.callers,
	'test-driven': HINTS.tests,
	pragmatic: HINTS.defects,
	performance: HINTS.defects,
	security: HINTS.security,
	'api-steward': HINTS.callers,
}

/** The persona team: one member per persona, each with the rules it owns, so every rule is checked once. */
const PERSONA_ROLES: Array<StartingRole> = REVIEW_PERSONAS.map((p) => ({
	role: p.name,
	rules: [...p.rules],
	hint: PERSONA_HINTS[p.id],
	persona: p.id,
}))

interface StartingRole {
	role: string
	rules: Array<ReviewRule>
	hint: RegExp
	persona?: PersonaId
}

function usable(c: ConnectionView): boolean {
	return c.status === 'connected' || c.status === 'testing' || c.kind === 'fixture'
}

/**
 * A starting team: four roles (or one per persona), each given a connected model whose name fits the role, else the
 * current model.
 */
export function suggestTeam(settings: AiSettingsView, personas = false): ReviewTeam {
	const options = settings.connections
		.filter(usable)
		.flatMap((c) => c.models.filter(listed).map((m) => ({ connectionId: c.id, modelId: m.id })))
	const fallback = settings.selection ?? options[0] ?? { connectionId: '', modelId: '' }
	const used = new Set<string>()
	const members: Array<TeamMember> = (personas ? PERSONA_ROLES : DEFAULT_ROLES).map((r) => {
		const pick = options.find((o) => r.hint.test(o.modelId) && !used.has(o.modelId)) ?? fallback
		used.add(pick.modelId)
		return { id: crypto.randomUUID(), role: r.role, rules: r.rules, ...(r.persona ? { persona: r.persona } : {}), ...pick }
	})
	return { id: crypto.randomUUID(), name: personas ? 'Persona team' : 'Review team', members }
}

interface Props {
	settings: AiSettingsView
	team: ReviewTeam
	isNew: boolean
	onSave(team: ReviewTeam): Promise<boolean>
	onRemove(): void
	onCancel(): void
}

/** Edits a review team: named roles, one model each, and which rules each role checks (every rule exactly once). */
export function TeamEditor({ settings, team: initial, isNew, onSave, onRemove, onCancel }: Props) {
	const [team, setTeam] = useState<ReviewTeam>(initial)
	const [saving, setSaving] = useState(false)
	const connections = settings.connections.filter(usable)
	const owner = useMemo(() => {
		const m = new Map<ReviewRule, string>()
		for (const x of team.members) for (const r of x.rules) m.set(r, x.id)
		return m
	}, [team.members])
	const missing = REVIEW_RULES.filter((r) => !owner.has(r))
	const set = (id: string, patch: Partial<TeamMember>): void =>
		setTeam((t) => ({ ...t, members: t.members.map((m) => (m.id === id ? { ...m, ...patch } : m)) }))

	// Giving a rule to one member takes it from whoever had it, so each rule has one owner.
	const assign = (rule: ReviewRule, memberId: string): void =>
		setTeam((t) => ({
			...t,
			members: t.members.map((m) =>
				m.id === memberId
					? { ...m, rules: m.rules.includes(rule) ? m.rules : [...m.rules, rule] }
					: { ...m, rules: m.rules.filter((r) => r !== rule) },
			),
		}))

	// A role still named after its old lens (or never renamed) follows the new one; a name you typed stays.
	const setPersona = (m: TeamMember, id: PersonaId | null): void => {
		const named = !m.role.trim() || /^Reviewer \d+$/.test(m.role) || m.role === personaOf(m.persona)?.name
		set(m.id, { persona: id, ...(named && id ? { role: personaOf(id)!.name } : {}) })
	}

	const removeMember = (id: string): void => setTeam((t) => ({ ...t, members: t.members.filter((m) => m.id !== id) }))
	const addMember = (): void =>
		setTeam((t) => ({
			...t,
			members: [
				...t.members,
				{
					id: crypto.randomUUID(),
					role: `Reviewer ${t.members.length + 1}`,
					rules: [],
					...(settings.selection ?? { connectionId: connections[0]?.id ?? '', modelId: connections[0]?.models[0]?.id ?? '' }),
				},
			],
		}))

	const empty = team.members.filter((m) => m.rules.length === 0)
	const invalid = team.members.some((m) => !connections.some((c) => c.id === m.connectionId && c.models.some((x) => x.id === m.modelId)))
	const canSave =
		!!team.name.trim() &&
		team.members.length > 0 &&
		missing.length === 0 &&
		empty.length === 0 &&
		!invalid &&
		team.members.every((m) => m.role.trim())

	return (
		<div className="form team-editor">
			<h3>{isNew ? 'New review team' : team.name}</h3>
			<p className="muted small">
				Each reviewer checks only its own rules, on only the changed files those rules apply to, and all of them run at the same time.
				Findings are merged into one list. A team uses more tokens than one model, but less than one model per reviewer.
			</p>
			<label className="field">
				<span>Team name</span>
				<input value={team.name} onChange={(e) => setTeam({ ...team, name: e.target.value })} maxLength={80} />
			</label>

			{team.members.map((m) => {
				const conn = connections.find((c) => c.id === m.connectionId)
				const base = baseModel(conn, m.modelId)
				const efforts = effortsFor(conn, base)
				return (
					<div key={m.id} className="member-card">
						<div className="member-head">
							<input
								className="member-role"
								value={m.role}
								onChange={(e) => set(m.id, { role: e.target.value })}
								aria-label="Role name"
								maxLength={60}
							/>
							<select
								value={`${m.connectionId}\u0000${base}`}
								onChange={(e) => {
									const [connectionId, modelId] = e.target.value.split('\u0000')
									// Another model keeps the effort chosen, where it takes it.
									const next = connections.find((c) => c.id === connectionId)
									set(m.id, { connectionId, modelId: withEffort(next, modelId, effortOf(conn, m.modelId)) })
								}}
								aria-label={`Model for ${m.role}`}
							>
								{!conn && <option value={`${m.connectionId}\u0000${m.modelId}`}>Choose a model…</option>}
								{connections.map((c) => (
									<optgroup key={c.id} label={c.label}>
										{c.models.filter(listed).map((x) => (
											<option key={x.id} value={`${c.id}\u0000${x.id}`}>
												{x.label}
											</option>
										))}
									</optgroup>
								))}
							</select>
							<button
								className="btn small ghost"
								onClick={() => removeMember(m.id)}
								disabled={team.members.length <= 1}
								aria-label={`Remove ${m.role}`}
							>
								✕
							</button>
						</div>
						{efforts.length > 0 && (
							<label className="member-lens small" title="How hard the model thinks. Higher is slower and uses more of your plan’s limits.">
								<span className="muted">Effort</span>
								<select
									value={effortOf(conn, m.modelId) ?? ''}
									onChange={(e) => set(m.id, { modelId: withEffort(conn, base, e.target.value || null) })}
									aria-label={`Effort for ${m.role}`}
								>
									<option value="">Default</option>
									{efforts.map((x) => (
										<option key={x} value={x}>
											{x}
										</option>
									))}
								</select>
							</label>
						)}
						<label className="member-lens small" title={personaOf(m.persona)?.summary ?? 'No lens: the reviewer checks its rules evenly.'}>
							<span className="muted">Lens</span>
							<select
								value={m.persona ?? ''}
								onChange={(e) => setPersona(m, (personaOf(e.target.value)?.id ?? null) as PersonaId | null)}
								aria-label={`Lens for ${m.role}`}
							>
								<option value="">None</option>
								{REVIEW_PERSONAS.map((p) => (
									<option key={p.id} value={p.id}>
										{p.name}
									</option>
								))}
							</select>
							{m.persona && <span className="muted ellipsis">Inspired by {personaOf(m.persona)?.inspiredBy}</span>}
						</label>
						<div className="member-rules small">
							{m.rules.length === 0 ? (
								<span className="warn-text">No rules yet. Assign some below, or remove this reviewer.</span>
							) : (
								REVIEW_RULES.filter((r) => m.rules.includes(r)).map((r) => (
									<span key={r} className="rule-chip">
										{RULE_LABEL[r]}
									</span>
								))
							)}
						</div>
					</div>
				)
			})}
			<div>
				<button className="btn small" onClick={addMember} disabled={team.members.length >= 8}>
					+ Add reviewer
				</button>
			</div>
			{sharedLogins(settings, team.members).map((g) => (
				<p key={g.label} className="notice small">
					{g.roles.join(', ')} all use {g.label}, so they share one plan’s usage limits and take turns: {CLI_CONCURRENCY} requests at a
					time. The review takes longer, and reaching the limit stops all of them.
				</p>
			))}

			<h3 className="small-h">Who checks what</h3>
			<table className="rule-table small">
				<tbody>
					{REVIEW_RULES.map((r) => (
						<tr key={r}>
							<td>{RULE_LABEL[r]}</td>
							<td>
								<select value={owner.get(r) ?? ''} onChange={(e) => assign(r, e.target.value)} aria-label={`Reviewer for ${RULE_LABEL[r]}`}>
									{!owner.has(r) && <option value="">Nobody</option>}
									{team.members.map((m) => (
										<option key={m.id} value={m.id}>
											{m.role}
										</option>
									))}
								</select>
							</td>
						</tr>
					))}
				</tbody>
			</table>

			{missing.length > 0 && (
				<p className="small error-text">Every rule needs a reviewer. Unassigned: {missing.map((r) => RULE_LABEL[r]).join(', ')}.</p>
			)}
			{invalid && <p className="small error-text">A reviewer’s model is not available. Choose a connected model for it.</p>}
			<div className="form-actions">
				<button
					className="btn primary"
					disabled={!canSave || saving}
					onClick={async () => {
						setSaving(true)
						await onSave({ ...team, name: team.name.trim(), members: team.members.map((m) => ({ ...m, role: m.role.trim() })) })
						setSaving(false)
					}}
				>
					{isNew ? 'Create team' : 'Save team'}
				</button>
				<button className="btn" onClick={onCancel}>
					Cancel
				</button>
				<span className="spacer" />
				{!isNew && (
					<button className="btn danger" onClick={onRemove}>
						Delete team
					</button>
				)}
			</div>
		</div>
	)
}
