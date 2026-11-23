import { useEffect, useState } from 'react'
import {
	MAX_NOTE_PATHS,
	MAX_REVIEWER_NOTE_CHARS,
	type DismissalRef,
	type DismissReason,
	type NoteSuggestion,
	type NoteSuggestionAction,
	type Result,
} from '../../shared/types.ts'
import { CATEGORY_LABEL } from '../../shared/findings.ts'

/**
 * Notes suggested from findings you dismissed the same way across pull requests (issue #278). What happened comes
 * first (each dismissal, where, and your note), then what the AI makes of it (the draft), which you can edit. Nothing
 * is added until you accept.
 */

export const REASON_LABEL: Record<DismissReason, string> = {
	wrong: 'wrong',
	'not-worth-it': 'not worth fixing',
	'handled-elsewhere': 'handled elsewhere',
	intended: 'intended',
}

const when = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/** "4 pull requests", "2 branches", or "3 pull requests and branches" when they mix. */
function spanText(refs: Array<DismissalRef>): string {
	const keys = new Set(refs.map((r) => r.prKey))
	const prs = [...keys].filter((k) => k.startsWith('pr:')).length
	const n = keys.size
	if (prs === n) return `${n} pull request${n === 1 ? '' : 's'}`
	if (prs === 0) return `${n} branch${n === 1 ? '' : 'es'}`
	return `${n} pull requests and branches`
}

/** "You dismissed 6 Convention findings like this as intended across 4 pull requests." */
export function evidenceLine(s: Pick<NoteSuggestion, 'from' | 'rule' | 'reason'>): string {
	const n = s.from.length
	return `You dismissed ${n} ${CATEGORY_LABEL[s.rule]} finding${n === 1 ? '' : 's'} like this as ${REASON_LABEL[s.reason]} across ${spanText(s.from)}.`
}

/** "Suggested from 3 Convention findings you dismissed as intended across 2 pull requests." */
export function sourceLine(from: Array<DismissalRef>): string {
	const n = from.length
	const reasons = [...new Set(from.map((r) => REASON_LABEL[r.reason]))].join(' or ')
	return `Suggested from ${n} ${CATEGORY_LABEL[from[0].rule]} finding${n === 1 ? '' : 's'} you dismissed as ${reasons} across ${spanText(from)}.`
}

/** Each dismissal: where, what the finding said, and your note. */
export function DismissalList({ refs }: { refs: Array<DismissalRef> }) {
	return (
		<ul className="dismissal-list small">
			{[...refs]
				.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))
				.map((r) => (
					<li key={r.key}>
						<div>
							<span className="mono">{r.target}</span> · <span className="mono">{`${r.path}${r.line ? `:${r.line}` : ''}`}</span>
						</div>
						<div>“{r.title}”</div>
						<div className="muted">
							Dismissed as {REASON_LABEL[r.reason]} on {when(r.decidedAt)}
							{r.note ? (
								<>
									: <span className="selectable">{r.note}</span>
								</>
							) : (
								', no note'
							)}
						</div>
					</li>
				))}
		</ul>
	)
}

/** One suggestion: the evidence, then the draft to edit, then accept, put off or refuse. */
export function NoteSuggestionReview({
	notesKey,
	suggestion: s,
	onSettled,
}: {
	notesKey: string
	suggestion: NoteSuggestion
	onSettled(list: Array<NoteSuggestion>, accepted: boolean): void
}) {
	const [text, setText] = useState(s.text)
	const [paths, setPaths] = useState(s.paths.join('\n'))
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const list = paths
		.split('\n')
		.map((p) => p.trim())
		.filter(Boolean)
	const settle = async (action: NoteSuggestionAction): Promise<void> => {
		setBusy(true)
		setError(null)
		const r: Result<Array<NoteSuggestion>> = await window.review.settleNoteSuggestion(notesKey, s.id, action)
		setBusy(false)
		if (r.ok) onSettled(r.value, action.kind === 'accept')
		else setError(r.error.message)
	}
	return (
		<div className="note-suggestion">
			<h4>What happened</h4>
			<p className="small">{evidenceLine(s)}</p>
			<DismissalList refs={s.from} />
			<h4>What the AI makes of it</h4>
			<p className="muted small">
				{s.problem ? `${s.problem}. ` : ''}A draft note for the reviewer, written by {s.model || 'the model for questions'} from your
				reasons and notes. Edit it before you accept: say what is true here, not what to skip.
			</p>
			<label className="field">
				<span>Note</span>
				<textarea
					className="style-edit"
					rows={3}
					value={text}
					maxLength={MAX_REVIEWER_NOTE_CHARS}
					onChange={(e) => setText(e.target.value)}
				/>
			</label>
			<label className="field">
				<span>Files</span>
				<textarea
					className="style-edit mono"
					rows={2}
					value={paths}
					placeholder="Whole repository"
					onChange={(e) => setPaths(e.target.value)}
				/>
			</label>
			<p className="muted small">{CATEGORY_LABEL[s.rule]} findings only. One file pattern per line; empty covers the whole repository.</p>
			{list.length > MAX_NOTE_PATHS && <p className="small error-text">At most {MAX_NOTE_PATHS} patterns.</p>}
			<div className="form-actions start">
				<button
					className="btn primary"
					disabled={busy || !text.trim() || list.length > MAX_NOTE_PATHS}
					onClick={() => void settle({ kind: 'accept', text, paths: list })}
				>
					Add this note
				</button>
				<button
					className="btn"
					disabled={busy}
					onClick={() => void settle({ kind: 'later' })}
					title="Asks again once three more findings like these are dismissed"
				>
					Not now
				</button>
				<button
					className="btn"
					disabled={busy}
					onClick={() => void settle({ kind: 'never' })}
					title="Stops suggesting a note for findings like these. You can undo it in Settings › AI review › Reviewer notes."
				>
					Never for these
				</button>
			</div>
			{error && <p className="small error-text">{error}</p>}
		</div>
	)
}

/** A suggestion in a dialog, opened from the banner. */
export function NoteSuggestionDialog({
	notesKey,
	suggestion,
	onSettled,
	onClose,
}: {
	notesKey: string
	suggestion: NoteSuggestion
	onSettled(list: Array<NoteSuggestion>, accepted: boolean): void
	onClose(): void
}) {
	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape') onClose()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [onClose])
	return (
		<div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className="modal note-suggestion-modal" role="dialog" aria-modal="true" aria-labelledby="note-suggestion-title">
				<div className="modal-head">
					<h2 id="note-suggestion-title">A note for the reviewer?</h2>
					<span className="spacer" />
					<button className="btn small ghost" onClick={onClose} aria-label="Close">
						✕
					</button>
				</div>
				<div className="fixed-body">
					<NoteSuggestionReview key={suggestion.id} notesKey={notesKey} suggestion={suggestion} onSettled={onSettled} />
				</div>
			</div>
		</div>
	)
}

/**
 * The banner over a review when a note is suggested for its repository. It reads the suggestions itself and follows
 * them as they change, so it shows up shortly after the dismissal that completed a pattern.
 */
export function NoteSuggestionBanner({ repoId, onOpenNotes }: { repoId: string; onOpenNotes(): void }) {
	const [key, setKey] = useState<string | null>(null)
	const [list, setList] = useState<Array<NoteSuggestion>>([])
	const [open, setOpen] = useState(false)
	const [added, setAdded] = useState(false)
	useEffect(() => {
		let live = true
		setKey(null)
		setList([])
		void window.review.notesRepos(repoId).then((r) => live && r.ok && setKey(r.value.current))
		return () => {
			live = false
		}
	}, [repoId])
	useEffect(() => {
		if (!key) return
		let live = true
		const load = (): void => void window.review.noteSuggestions(key).then((r) => live && r.ok && setList(r.value))
		load()
		const off = window.review.onNoteSuggestionsChanged((k) => k === key && load())
		return () => {
			live = false
			off()
		}
	}, [key])
	const pending = list.filter((s) => s.state === 'pending')
	const first = pending[0]
	if (added && !first)
		return (
			<div className="banner" role="status">
				<span>Note added. Later reviews of this repository get it.</span>
				<span className="spacer" />
				<button className="btn small" onClick={onOpenNotes}>
					Reviewer notes
				</button>
				<button className="btn small ghost" onClick={() => setAdded(false)} aria-label="Close">
					✕
				</button>
			</div>
		)
	if (!key || !first) return null
	return (
		<>
			<div className="banner" role="status">
				<span>
					<strong>{evidenceLine(first)}</strong> The reviewer may be missing something about this repository. A note could tell it.
					{pending.length > 1 ? ` (${pending.length - 1} more suggestion${pending.length === 2 ? '' : 's'} waiting.)` : ''}
				</span>
				<span className="spacer" />
				<button className="btn small primary" onClick={() => setOpen(true)}>
					See why…
				</button>
			</div>
			{open && (
				<NoteSuggestionDialog
					notesKey={key}
					suggestion={first}
					onClose={() => setOpen(false)}
					onSettled={(next, accepted) => {
						setList(next)
						setOpen(false)
						if (accepted) setAdded(true)
					}}
				/>
			)}
		</>
	)
}
