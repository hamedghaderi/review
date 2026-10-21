import { useEffect, useRef, useState } from 'react'
import { FEEDBACK_KINDS, feedbackUrl, type FeedbackKind } from '../../shared/feedback.ts'

/**
 * Feedback as a GitHub issue: the form fills in a new issue, which opens in the browser for you to check and submit.
 * The app sends nothing itself.
 */
export function FeedbackDialog({ onClose }: { onClose(): void }) {
	const [kind, setKind] = useState<FeedbackKind>('bug')
	const [title, setTitle] = useState('')
	const [body, setBody] = useState('')
	const [withSystem, setWithSystem] = useState(true)
	const [os, setOs] = useState<string | null>(null)
	const first = useRef<HTMLInputElement>(null)

	useEffect(() => {
		first.current?.focus()
		void window.review.systemInfo().then((r) => r.ok && setOs(r.value))
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape') onClose()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [onClose])

	const system = `Review ${__APP_VERSION__}${os ? ` · ${os}` : ''}`
	const send = (): void => {
		window.open(feedbackUrl({ kind, title, body, system: withSystem ? system : null }), '_blank')
		onClose()
	}

	return (
		<div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className="modal feedback" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
				<div className="modal-head">
					<h2 id="feedback-title">Send feedback</h2>
					<span className="spacer" />
					<button className="btn small ghost" onClick={onClose} aria-label="Close">
						✕
					</button>
				</div>
				<form
					className="settings-main form"
					onSubmit={(e) => {
						e.preventDefault()
						if (title.trim()) send()
					}}
				>
					<fieldset className="radio-row small">
						<legend className="muted">What is it about?</legend>
						{FEEDBACK_KINDS.map((k) => (
							<label key={k.id} className="radio">
								<input type="radio" name="feedback-kind" checked={kind === k.id} onChange={() => setKind(k.id)} /> {k.label}
							</label>
						))}
					</fieldset>
					<label className="field">
						<span>Title</span>
						<input ref={first} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="In a few words" />
					</label>
					<label className="field">
						<span>Details</span>
						<textarea
							className="summary"
							rows={7}
							value={body}
							onChange={(e) => setBody(e.target.value)}
							placeholder={
								kind === 'bug'
									? 'What did you do, what did you expect, and what happened instead?'
									: 'What would make Review better for you?'
							}
						/>
					</label>
					<label className="check small">
						<input type="checkbox" checked={withSystem} onChange={(e) => setWithSystem(e.target.checked)} />
						Include <span className="mono">{system}</span>
					</label>
					<p className="muted small">
						This opens a new issue on GitHub in your browser, where you can check it before submitting. Issues are public, so leave out
						anything private, such as code or repository names you can’t share.
					</p>
					<div className="form-actions">
						<button type="button" className="btn" onClick={onClose}>
							Cancel
						</button>
						<button className="btn primary" disabled={!title.trim()}>
							Continue on GitHub ↗
						</button>
					</div>
				</form>
			</div>
		</div>
	)
}
