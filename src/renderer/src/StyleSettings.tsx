import { useEffect, useRef, useState } from 'react'
import {
	MAX_STYLE_CHARS,
	MAX_STYLE_PRS,
	STYLE_REFRESH_EVERY,
	type ReviewedPr,
	type ReviewStyle,
	type StyleBasis,
	type StylePr,
} from '../../shared/types.ts'
import { Markdown } from './Markdown.tsx'

function basisText(b: StyleBasis): string {
	const parts = [
		b.edits && `${b.edits} finding${b.edits === 1 ? '' : 's'} you edited`,
		b.comments && `${b.comments} comment${b.comments === 1 ? '' : 's'} you wrote here`,
		b.github && `${b.github} of your comments on ${b.prs ? `${b.prs} pull request${b.prs === 1 ? '' : 's'} you picked` : 'GitHub'}`,
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
				<>
					<StylePrPicker built={false} />
					<div className="form-actions start">{buildButton('Learn my style')}</div>
				</>
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
					<StylePrPicker built />
				</>
			)}
			{error && <p className="small error-text">{error}</p>}
		</div>
	)
}

const key = (p: { repo: string; number: number }): string => `${p.repo.toLowerCase()}#${p.number}`

/**
 * The GitHub pull requests your review style is learned from: up to MAX_STYLE_PRS you pick from the ones you reviewed
 * (or by pasting a link). With none picked, the note reads the ones you reviewed most recently.
 */
function StylePrPicker({ built }: { built: boolean }) {
	const [picked, setPicked] = useState<Array<StylePr> | null>(null)
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState('')
	const [found, setFound] = useState<Array<ReviewedPr> | null>(null)
	const [searching, setSearching] = useState(false)
	const [changed, setChanged] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const asked = useRef(0)
	useEffect(() => {
		void window.review.stylePrs().then((r) => (r.ok ? setPicked(r.value) : setError(r.error.message)))
	}, [])
	// Searching waits for you to stop typing; only the newest answer is shown.
	useEffect(() => {
		if (!open) return
		const n = ++asked.current
		setSearching(true)
		const t = setTimeout(async () => {
			const r = await window.review.reviewedPrs(query)
			if (n !== asked.current) return
			setSearching(false)
			if (r.ok) {
				setFound(r.value)
				setError(null)
			} else setError(r.error.message)
		}, 300)
		return () => clearTimeout(t)
	}, [open, query])
	if (!picked) return error ? <p className="small error-text">{error}</p> : null

	const save = async (next: Array<StylePr>): Promise<void> => {
		setPicked(next)
		const r = await window.review.setStylePrs(next)
		if (r.ok) {
			setPicked(r.value)
			setChanged(true)
			setError(null)
		} else setError(r.error.message)
	}
	const chosen = new Set(picked.map(key))
	const toggle = (p: ReviewedPr): Promise<void> =>
		save(chosen.has(key(p)) ? picked.filter((x) => key(x) !== key(p)) : [...picked, { repo: p.repo, number: p.number, title: p.title }])
	return (
		<div className="style-prs">
			<h4>Pull requests to learn from</h4>
			<p className="muted small">
				{picked.length
					? `Your review comments on these ${picked.length === 1 ? 'pull request are' : `${picked.length} pull requests are`} used instead of your recent ones. Your edits and comments in Review still count.`
					: `None picked, so it reads the 30 pull requests you reviewed most recently. Pick up to ${MAX_STYLE_PRS} that show how you review.`}
			</p>
			{!!picked.length && (
				<ul className="style-pr-list small">
					{picked.map((p) => (
						<li key={key(p)}>
							<span className="ellipsis" title={p.title}>
								{p.title}
							</span>
							<span className="muted nowrap">
								{p.repo}#{p.number}
							</span>
							<button
								className="btn small ghost"
								aria-label={`Stop learning from ${p.repo}#${p.number}`}
								onClick={() => void save(picked.filter((x) => key(x) !== key(p)))}
							>
								✕
							</button>
						</li>
					))}
				</ul>
			)}
			{changed && built && <p className="small">Rebuild the note to learn from these.</p>}
			{!open ? (
				<div className="form-actions start">
					<button className="btn" onClick={() => setOpen(true)}>
						{picked.length ? 'Change pull requests…' : 'Choose pull requests…'}
					</button>
				</div>
			) : (
				<div className="style-pr-picker">
					<input
						type="search"
						className="settings-search"
						placeholder="Search the pull requests you reviewed, or paste a link"
						aria-label="Search the pull requests you reviewed, or paste a link"
						value={query}
						autoFocus
						onChange={(e) => setQuery(e.target.value)}
					/>
					<div className="style-pr-results small" aria-busy={searching}>
						{found === null ? (
							<div className="muted pad">Loading…</div>
						) : !found.length ? (
							<div className="muted pad">{searching ? 'Searching…' : 'No pull requests you reviewed match.'}</div>
						) : (
							found.map((p) => {
								const on = chosen.has(key(p))
								const full = !on && picked.length >= MAX_STYLE_PRS
								return (
									<label
										key={key(p)}
										className={`check style-pr-row${full ? ' muted' : ''}`}
										title={full ? `You can pick up to ${MAX_STYLE_PRS}.` : p.title}
									>
										<input type="checkbox" checked={on} disabled={full} onChange={() => void toggle(p)} />
										<span className="ellipsis">{p.title}</span>
										<span className="muted nowrap">
											{p.repo}#{p.number} · {p.comments ? `${p.comments} by you` : 'no comments by you'}
										</span>
									</label>
								)
							})
						)}
					</div>
					<div className="form-actions start">
						<span className="muted small">
							{picked.length} of {MAX_STYLE_PRS} picked
						</span>
						<span className="spacer" />
						<button className="btn" onClick={() => setOpen(false)}>
							Done
						</button>
					</div>
				</div>
			)}
			{error && <p className="small error-text">{error}</p>}
		</div>
	)
}
