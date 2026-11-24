import { useState } from 'react'
import type { AiTextFlag } from '../../shared/types.ts'

interface Props {
	textId: string | undefined // absent on text from before it was recorded: nothing to count it against
	flagged: AiTextFlag | undefined
	what: string // "explanation", "conclusion", "answer"
	onFlag(textId: string, flag: { note: string | null } | null): Promise<string | null> // why it failed, or null
}

/**
 * "This is wrong" on an AI text (issue #289), with an optional note on what was wrong, counted per model in Outcomes.
 * There is no thumbs-up: not flagging a text doesn't make it right, so Outcomes counts flags, never an accuracy rate.
 */
export function FlagWrong({ textId, flagged, what, onFlag }: Props) {
	const [open, setOpen] = useState(false)
	const [note, setNote] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	if (!textId) return null
	const send = async (flag: { note: string | null } | null): Promise<void> => {
		setBusy(true)
		setError(null)
		const problem = await onFlag(textId, flag)
		setBusy(false)
		if (problem) return setError(problem)
		setOpen(false)
		setNote('')
	}
	if (flagged)
		return (
			<span className="flag-wrong small" role="status">
				<span className="flag-wrong-mark">You said this {what} is wrong</span>
				{flagged.note && <span className="muted selectable">: {flagged.note}</span>}{' '}
				<button className="link" onClick={() => void send(null)} disabled={busy}>
					Take back
				</button>
				{error && <span className="error-text"> {error}</span>}
			</span>
		)
	if (!open)
		return (
			<button
				className="btn small ghost"
				onClick={() => setOpen(true)}
				title={`Counted for this model in Outcomes, so you can see how often its ${what}s are wrong.`}
			>
				This is wrong
			</button>
		)
	return (
		<form
			className="flag-wrong-form small"
			onSubmit={(e) => {
				e.preventDefault()
				void send({ note: note.trim() || null })
			}}
		>
			<input
				autoFocus
				value={note}
				maxLength={500}
				placeholder="What was wrong? (optional)"
				aria-label={`What was wrong with this ${what} (optional)`}
				onChange={(e) => setNote(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Escape') {
						e.preventDefault()
						setOpen(false)
					}
				}}
			/>
			<button className="btn small" type="submit" disabled={busy}>
				{busy ? 'Saving…' : 'Flag as wrong'}
			</button>
			<button className="btn small ghost" type="button" onClick={() => setOpen(false)} disabled={busy}>
				Cancel
			</button>
			{error && <span className="error-text">{error}</span>}
		</form>
	)
}
