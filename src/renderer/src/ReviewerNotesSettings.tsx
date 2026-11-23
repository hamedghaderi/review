import { useEffect, useState } from 'react'
import {
	MAX_NOTE_PATHS,
	MAX_REVIEWER_NOTE_CHARS,
	MAX_REVIEWER_NOTES,
	type FindingCategory,
	type NotesRepo,
	type Result,
	type ReviewerNote,
	type ReviewerNoteEdit,
} from '../../shared/types.ts'
import { CATEGORY_LABEL } from '../../shared/findings.ts'
import { notesMarkdown, noteScope } from '../../shared/notes.ts'

const when = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const RULES = Object.keys(CATEGORY_LABEL) as Array<FindingCategory>

/**
 * Settings › AI review › Reviewer notes (issue #278): notes you keep for the AI reviewer about one repository, sent with
 * the changed files they cover. They stay on this computer; Copy as Markdown is there to commit them to `.review/`.
 */
export function ReviewerNotesSettings({ repoId }: { repoId: string | null }) {
	const [repos, setRepos] = useState<Array<NotesRepo> | null>(null)
	const [key, setKey] = useState<string | null>(null)
	const [notes, setNotes] = useState<Array<ReviewerNote> | null>(null)
	const [editing, setEditing] = useState<ReviewerNoteEdit | null>(null)
	const [copied, setCopied] = useState<'yes' | 'failed' | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		void window.review.notesRepos(repoId).then((r) => {
			if (!r.ok) return setError(r.error.message)
			setRepos(r.value.repos)
			setKey(r.value.current ?? r.value.repos[0]?.key ?? null)
		})
	}, [repoId])
	useEffect(() => {
		setNotes(null)
		setEditing(null)
		setCopied(null)
		if (!key) return
		void window.review.reviewerNotes(key).then((r) => (r.ok ? setNotes(r.value) : setError(r.error.message)))
	}, [key])

	const take = (r: Result<Array<ReviewerNote>>): boolean => {
		if (!r.ok) {
			setError(r.error.message)
			return false
		}
		setNotes(r.value)
		setRepos((list) => list?.map((x) => (x.key === key ? { ...x, notes: r.value.length } : x)) ?? list)
		setError(null)
		setCopied(null)
		return true
	}
	const save = async (edit: ReviewerNoteEdit): Promise<boolean> => !!key && take(await window.review.saveReviewerNote(key, edit))
	const copy = (): void => {
		if (!notes) return
		void navigator.clipboard.writeText(notesMarkdown(notes)).then(
			() => setCopied('yes'),
			() => setCopied('failed'),
		)
	}

	const intro = (
		<>
			<h3>Reviewer notes</h3>
			<p className="muted small">
				Notes for the AI reviewer about one repository: what it keeps getting wrong here, or what is intended. Each run sends a note with
				the changed files it covers, as your own decision. The reviewer is told a note never settles a bug or security problem it can show
				in the code, and nothing it finds is hidden: a finding it raises anyway says which note covers it.
			</p>
			<p className="muted small">
				Notes stay on this computer and apply to every clone of the same GitHub repository. To share them with your team, copy them as
				Markdown into the repository’s <span className="mono">.review/</span> folder.
			</p>
		</>
	)
	if (repos === null) return <div className="form">{error ? <p className="small error-text">{error}</p> : intro}</div>
	if (!repos.length || !key)
		return (
			<div className="form">
				{intro}
				<p className="small">Open a repository first.</p>
			</div>
		)
	const on = notes?.filter((n) => n.on).length ?? 0
	return (
		<div className="form notes-settings">
			{intro}
			<label className="field">
				<span>Repository</span>
				<select value={key} onChange={(e) => setKey(e.target.value)}>
					{repos.map((r) => (
						<option key={r.key} value={r.key}>
							{r.label}
							{r.notes ? ` (${r.notes})` : ''}
						</option>
					))}
				</select>
			</label>

			{notes === null ? null : (
				<>
					{!notes.length && !editing && <p className="muted small">No notes for this repository yet.</p>}
					{!!notes.length && (
						<ul className="note-list">
							{notes.map((n) =>
								editing?.id === n.id ? (
									<li key={n.id}>
										<NoteEditor edit={editing} onChange={setEditing} onSave={save} onCancel={() => setEditing(null)} />
									</li>
								) : (
									<li key={n.id} className={`note-card${n.on ? '' : ' off'}`}>
										<div className="note-head small">
											<label className="check">
												<input
													type="checkbox"
													checked={n.on}
													onChange={(e) => void save({ id: n.id, text: n.text, rule: n.rule, paths: n.paths, on: e.target.checked })}
												/>
												<b>{noteScope(n)}</b>
											</label>
										</div>
										<p className="note-text selectable">{n.text}</p>
										<div className="note-foot small">
											<span className="muted">
												Added {when(n.addedAt)}
												{n.editedAt ? ` · edited ${when(n.editedAt)}` : ''}
												{n.on ? '' : ' · off, not sent'}
											</span>
											<span className="spacer" />
											<button
												className="btn small"
												disabled={!!editing}
												onClick={() => setEditing({ id: n.id, text: n.text, rule: n.rule, paths: n.paths, on: n.on })}
											>
												Edit
											</button>
											<button
												className="btn small"
												disabled={!!editing}
												onClick={async () => {
													if (window.confirm('Delete this note? Runs stop getting it.'))
														take(await window.review.deleteReviewerNote(key, n.id))
												}}
											>
												Delete
											</button>
										</div>
									</li>
								),
							)}
						</ul>
					)}
					{editing?.id === null && <NoteEditor edit={editing} onChange={setEditing} onSave={save} onCancel={() => setEditing(null)} />}
					{!editing && (
						<div className="form-actions start">
							<button
								className="btn"
								disabled={notes.length >= MAX_REVIEWER_NOTES}
								title={notes.length >= MAX_REVIEWER_NOTES ? `A repository can have at most ${MAX_REVIEWER_NOTES} notes.` : undefined}
								onClick={() => setEditing({ id: null, text: '', rule: null, paths: [], on: true })}
							>
								Add a note
							</button>
							<button className="btn" disabled={!on} title={on ? undefined : 'No note is on.'} onClick={copy}>
								Copy as Markdown
							</button>
							{copied && (
								<span className={`small ${copied === 'yes' ? 'muted' : 'error-text'}`} role="status">
									{copied === 'yes' ? `Copied ${on} note${on === 1 ? '' : 's'}.` : 'Could not copy to the clipboard.'}
								</span>
							)}
						</div>
					)}
				</>
			)}
			{error && <p className="small error-text">{error}</p>}
		</div>
	)
}

/** Writing or changing one note: its text, the rule it is about and the files it covers. */
function NoteEditor(props: {
	edit: ReviewerNoteEdit
	onChange(next: ReviewerNoteEdit): void
	onSave(edit: ReviewerNoteEdit): Promise<boolean>
	onCancel(): void
}) {
	const { edit, onChange } = props
	// Paths are typed one per line; blank lines are dropped when saved.
	const [paths, setPaths] = useState(edit.paths.join('\n'))
	const [busy, setBusy] = useState(false)
	const list = paths
		.split('\n')
		.map((p) => p.trim())
		.filter(Boolean)
	return (
		<div className="key-form note-editor">
			<label className="field">
				<span>Note</span>
				<textarea
					className="style-edit"
					rows={4}
					value={edit.text}
					maxLength={MAX_REVIEWER_NOTE_CHARS}
					autoFocus
					placeholder="Error messages here are deliberately terse; their wording is not a finding."
					onChange={(e) => onChange({ ...edit, text: e.target.value })}
				/>
			</label>
			<p className="muted small">
				Write it as a fact about this repository, not as “don’t flag X”: the reviewer still raises a real problem the code shows.
			</p>
			<label className="field">
				<span>Rule</span>
				<select
					value={edit.rule ?? ''}
					onChange={(e) => onChange({ ...edit, rule: e.target.value ? (e.target.value as FindingCategory) : null })}
				>
					<option value="">Any rule</option>
					{RULES.map((r) => (
						<option key={r} value={r}>
							{CATEGORY_LABEL[r]}
						</option>
					))}
				</select>
			</label>
			<label className="field">
				<span>Files</span>
				<textarea
					className="style-edit mono"
					rows={3}
					value={paths}
					placeholder="src/errors/**"
					onChange={(e) => setPaths(e.target.value)}
				/>
			</label>
			<p className="muted small">
				One pattern per line, from the repository root. <span className="mono">*</span> stays in one folder,{' '}
				<span className="mono">**</span> goes into subfolders, a folder covers everything in it, and a name without a slash matches at any
				depth. Empty: the whole repository.
			</p>
			{list.length > MAX_NOTE_PATHS && <p className="small error-text">At most {MAX_NOTE_PATHS} patterns.</p>}
			<div className="form-actions start">
				<button
					className="btn primary"
					disabled={busy || !edit.text.trim() || list.length > MAX_NOTE_PATHS}
					onClick={async () => {
						setBusy(true)
						const ok = await props.onSave({ ...edit, paths: list })
						setBusy(false)
						if (ok) props.onCancel()
					}}
				>
					{edit.id ? 'Save' : 'Add note'}
				</button>
				<button className="btn" onClick={props.onCancel}>
					Cancel
				</button>
			</div>
		</div>
	)
}
