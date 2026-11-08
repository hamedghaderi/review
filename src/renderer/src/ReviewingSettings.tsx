import { useEffect, useState } from 'react'
import type { ReviewingPrefs } from '../../shared/types.ts'
import { keyLabel } from './keymap.ts'

/** Settings › Reviewing: how reviews are read. Each option is off until you turn it on. */
export function ReviewingSettings() {
	const [prefs, setPrefs] = useState<ReviewingPrefs | null>(null)
	const [error, setError] = useState<string | null>(null)
	useEffect(() => {
		void window.review.reviewing().then((r) => (r.ok ? setPrefs(r.value) : setError(r.error.message)))
		return window.review.onReviewingChanged(setPrefs)
	}, [])
	if (!prefs) return <div className="form">{error && <p className="small error-text">{error}</p>}</div>

	const set = async (next: ReviewingPrefs): Promise<void> => {
		setPrefs(next)
		setError(null)
		const r = await window.review.setReviewing(next)
		if (r.ok) setPrefs(r.value)
		else setError(r.error.message)
	}
	const next = keyLabel('commitNext')
	const prev = keyLabel('commitPrev')
	return (
		<div className="form">
			<h3>Reviewing</h3>
			<label className="check">
				<input type="checkbox" checked={prefs.stepCommits} onChange={(e) => void set({ ...prefs, stepCommits: e.target.checked })} />
				<span>
					Step through commits
					<span className="muted block">
						Pull request and branch reviews get a commit picker next to the title. Pick a commit to read only its changes, with its message
						above them{next && prev ? `; ${next} and ${prev} go to the next and previous commit` : ''}. All changes stays the default. A
						comment you write in a commit moves to the same lines in the latest commit, so it publishes as usual; when those lines change
						again in a later commit, it asks you to comment there instead. Merge commits are left out. In a commit, the AI (the model for
						questions) can check whether its diff does what its message says, one commit at a time or all of them after showing the cost; it
						only runs when you click.
					</span>
				</span>
			</label>
			<label className="check sub-check">
				<input
					type="checkbox"
					checked={prefs.offerWalk}
					disabled={!prefs.stepCommits}
					onChange={(e) => void set({ ...prefs, offerWalk: e.target.checked })}
				/>
				<span>
					Offer a walkthrough when a review opens
					<span className="muted block">
						When a review has two or more commits, it asks whether to walk through them. The walkthrough goes file by file through each
						commit, oldest first, and asks before moving on to the next commit. Without this, the Walk through button next to the commit
						picker starts one.
					</span>
				</span>
			</label>
			{error && <p className="small error-text">{error}</p>}
		</div>
	)
}
