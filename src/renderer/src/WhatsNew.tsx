import { useEffect, useState } from 'react'
import { notesIn, type NotesRange } from '../../shared/releases.ts'
import type { ReleaseNote } from '../../shared/types.ts'
import { GitHubHtml } from './GitHubHtml.tsx'

const RELEASES = 'https://github.com/hamedghaderi/review/releases'

/**
 * What's new in Review: the release notes GitHub has for `range`, newest first. Shown once after an update, from the
 * update banner before installing, and from Help › What's New.
 */
export function WhatsNew({ range, onClose }: { range: NotesRange; onClose(): void }) {
	const [notes, setNotes] = useState<Array<ReleaseNote> | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		void window.review.releaseNotes().then((r) => (r.ok ? setNotes(r.value) : setError(r.error.message)))
	}, [])
	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape') onClose()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [onClose])

	const shown = notes ? notesIn(notes, range) : []
	const title = range.kind === 'since' ? `What’s new in Review ${range.to}` : 'What’s new in Review'
	return (
		<div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className="modal whats-new" role="dialog" aria-modal="true" aria-labelledby="whats-new-title">
				<div className="modal-head">
					<h2 id="whats-new-title">{title}</h2>
					<span className="spacer" />
					<button className="btn small ghost" onClick={onClose} aria-label="Close">
						✕
					</button>
				</div>
				<div className="whats-new-body">
					{!notes && !error && <p className="small muted">Reading the release notes from GitHub…</p>}
					{error && (
						<p className="small error-text">
							The release notes couldn’t be read from GitHub. {error}{' '}
							<a href={RELEASES} target="_blank" rel="noreferrer">
								Read them on GitHub ↗
							</a>
						</p>
					)}
					{notes && !shown.length && <p className="small muted">There are no release notes for this version yet.</p>}
					{shown.map((n) => (
						<section key={n.version} className="whats-new-release">
							<div className="whats-new-version">
								<h3>Review {n.version}</h3>
								{n.date && (
									<span className="muted small">
										{new Date(n.date).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}
									</span>
								)}
								<span className="spacer" />
								<a className="small" href={n.url} target="_blank" rel="noreferrer">
									On GitHub ↗
								</a>
							</div>
							<GitHubHtml html={n.html} empty="No notes for this release." media />
						</section>
					))}
				</div>
				<div className="whats-new-foot small">
					<a href={RELEASES} target="_blank" rel="noreferrer">
						All releases ↗
					</a>
					<span className="spacer" />
					<button className="btn small primary" onClick={onClose}>
						Done
					</button>
				</div>
			</div>
		</div>
	)
}
