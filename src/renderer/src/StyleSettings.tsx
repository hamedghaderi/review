import { useEffect, useState } from 'react'
import { MAX_STYLE_CHARS, STYLE_REFRESH_EVERY, type ReviewStyle, type StyleBasis } from '../../shared/types.ts'
import { Markdown } from './Markdown.tsx'

function basisText(b: StyleBasis): string {
	const parts = [
		b.edits && `${b.edits} finding${b.edits === 1 ? '' : 's'} you edited`,
		b.comments && `${b.comments} comment${b.comments === 1 ? '' : 's'} you wrote here`,
		b.github && `${b.github} of your comments on GitHub`,
	].filter(Boolean)
	return parts.length ? `From ${parts.join(', ')}` : 'From no examples'
}

const when = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/**
 * Settings › AI review › Your review style: the note on how you word review comments, written by the model for
 * questions from your own comments (issue #135). You can read it, edit it, rebuild it or turn it off.
 */
export function StyleSettings({ hasQuestionModel }: { hasQuestionModel: boolean }) {
	const [style, setStyle] = useState<ReviewStyle | null | undefined>(undefined)
	const [draft, setDraft] = useState<string | null>(null) // the note while you edit it
	const [building, setBuilding] = useState(false)
	const [error, setError] = useState<string | null>(null)
	useEffect(() => {
		void window.review.reviewStyle().then((r) => (r.ok ? setStyle(r.value) : setError(r.error.message)))
	}, [])

	const take = (r: Awaited<ReturnType<typeof window.review.buildReviewStyle>>): boolean => {
		if (!r.ok) {
			setError(r.error.message)
			return false
		}
		setStyle(r.value)
		setError(null)
		return true
	}
	const build = async (): Promise<void> => {
		setBuilding(true)
		setError(null)
		take(await window.review.buildReviewStyle())
		setBuilding(false)
	}

	if (style === undefined) return <div className="form">{error && <p className="small error-text">{error}</p>}</div>
	const buildButton = (label: string) => (
		<button className="btn" disabled={building || !hasQuestionModel} onClick={() => void build()}>
			{building ? 'Reading your comments…' : label}
		</button>
	)
	return (
		<div className="form style-settings">
			<h3>Your review style</h3>
			<p className="muted small">
				A short note on how you word review comments, so the comments the AI writes for you sound like you. It is written from the findings
				you edited before posting them, the comments you wrote in Review, and your review comments on GitHub, and sent to the model for
				questions. It changes only the wording, never what counts as a finding.
			</p>
			{!hasQuestionModel && <p className="small">Choose a model for questions first, in AI review › Providers.</p>}

			{style === null ? (
				<div className="form-actions start">{buildButton('Learn my style')}</div>
			) : (
				<>
					<label className="check">
						<input
							type="checkbox"
							checked={style.on}
							onChange={async (e) => take(await window.review.setReviewStyle({ text: style.text, on: e.target.checked }))}
						/>
						Write in my style
					</label>
					<p className="muted small">Findings and drafted replies don't use it yet.</p>

					{draft === null ? (
						<div className={`style-note${style.on ? '' : ' off'}`}>
							<Markdown text={style.text} />
						</div>
					) : (
						<textarea
							className="style-edit"
							rows={12}
							value={draft}
							maxLength={MAX_STYLE_CHARS}
							onChange={(e) => setDraft(e.target.value)}
							aria-label="Your review style"
						/>
					)}
					<span className="muted small field-note">
						{basisText(style.basis)} · {style.auto ? `updated on its own from ${style.auto} new comments` : 'built'} {when(style.builtAt)}
						{style.edited ? ' · edited by you' : ''}
					</span>
					<p className="muted small">
						{style.on
							? `It updates on its own after a review run, once you have edited ${STYLE_REFRESH_EVERY} more findings or written ${STYLE_REFRESH_EVERY} more comments. Each update is one request to the model for questions.`
							: 'While it is off, it does not update on its own.'}
					</p>
					{style.autoFailed && (
						<p className="small error-text">
							The last update on its own failed ({when(style.autoFailed.at)}): {style.autoFailed.message} It tries again after{' '}
							{STYLE_REFRESH_EVERY} more comments.
						</p>
					)}

					{draft === null ? (
						<div className="form-actions start">
							<button className="btn" onClick={() => setDraft(style.text)}>
								Edit
							</button>
							{!style.proposed && buildButton('Rebuild from my comments')}
						</div>
					) : (
						<div className="form-actions start">
							<button
								className="btn primary"
								disabled={!draft.trim()}
								onClick={async () => take(await window.review.setReviewStyle({ text: draft, on: style.on })) && setDraft(null)}
							>
								Save
							</button>
							<button className="btn" onClick={() => setDraft(null)}>
								Cancel
							</button>
						</div>
					)}

					{style.proposed && (
						<div className="style-proposed">
							<h4>A rebuilt note</h4>
							<p className="muted small">
								{style.proposed.auto ? `Updated on its own from ${style.proposed.auto} new comments. ` : ''}You edited your note, so the
								rebuilt one waits here instead of replacing it. {basisText(style.proposed.basis)}.
							</p>
							<div className="style-note">
								<Markdown text={style.proposed.text} />
							</div>
							<div className="form-actions start">
								<button className="btn primary" onClick={async () => take(await window.review.settleReviewStyle(true)) && setDraft(null)}>
									Use the rebuilt note
								</button>
								<button className="btn" onClick={async () => take(await window.review.settleReviewStyle(false))}>
									Keep mine
								</button>
							</div>
						</div>
					)}
				</>
			)}
			{error && <p className="small error-text">{error}</p>}
		</div>
	)
}
