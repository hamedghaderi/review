import { rangeSummary, type RangeCommit, type SinceReview } from '../../shared/rangeDiff.ts'

const STATE_LABEL: Record<RangeCommit['state'], string> = { changed: 'Changed', new: 'New', dropped: 'Dropped', same: 'Unchanged' }

/**
 * What the author changed since your review when the branch was force-pushed (issue #274): each commit before and after,
 * lined up, with the base branch's commits left out. A changed commit opens its diff of the diff. Facts only, never posted.
 */
export function SinceReviewBanner({
	since: s,
	repoUrl,
	open,
	onToggle,
}: {
	since: SinceReview
	repoUrl: string | null
	open: boolean
	onToggle(): void
}) {
	if (!s.rewritten) return null
	const range = (
		<span className="mono">
			{s.from.slice(0, 7)} → {s.to.slice(0, 7)}
		</span>
	)
	if (s.error)
		return (
			<div className="banner" role="status">
				<span>
					<strong>Force-pushed since your review</strong> ({range}). <span className="muted">{s.error}</span>
				</span>
			</div>
		)
	if (!s.commits.length) return null
	const same = s.commits.filter((c) => c.state === 'same')
	const rest = s.commits.filter((c) => c.state !== 'same')
	const whole = s.squashed ? s.commits[0] : null
	return (
		<div className="banner drift-banner since-review" role="status">
			<div className="drift-head">
				<span>
					{whole ? (
						<>
							<strong>Squashed and force-pushed since your review</strong> ({range}), so the commits can’t be lined up. Comparing the whole
							change instead, without what came from the base branch:{' '}
							{whole.state === 'same'
								? 'it is the same as when you reviewed it.'
								: whole.state === 'changed'
									? 'it changed.'
									: 'it was rewritten too much to pair with what you reviewed, so review it again in full.'}
						</>
					) : (
						<>
							<strong>Force-pushed since your review</strong> ({range}): {rangeSummary(s.commits)}. Commits from the base branch are left
							out.
						</>
					)}
				</span>
				<span className="spacer" />
				{(whole ? whole.state === 'changed' : s.commits.length > 0) && (
					<button className="btn small" onClick={onToggle} aria-expanded={open}>
						{open ? 'Hide' : 'Show'}
					</button>
				)}
			</div>
			{open && whole?.state === 'changed' && <InterDiff lines={whole.diff} />}
			{open && !whole && (
				<ul className="since-list small">
					{rest.map((c) => (
						<li key={`${c.old ?? ''}:${c.new ?? ''}`}>
							{c.state === 'changed' ? (
								<details>
									<summary>
										<CommitLine c={c} repoUrl={repoUrl} />
									</summary>
									<InterDiff lines={c.diff} />
								</details>
							) : (
								<CommitLine c={c} repoUrl={repoUrl} />
							)}
						</li>
					))}
					{same.length > 0 && (
						<li className="muted" title={same.map((c) => c.subject).join('\n')}>
							{same.length} unchanged commit{same.length === 1 ? '' : 's'}
						</li>
					)}
				</ul>
			)}
		</div>
	)
}

function CommitLine({ c, repoUrl }: { c: RangeCommit; repoUrl: string | null }) {
	const sha = c.new ?? c.old!
	return (
		<span>
			<span className={`since-state ${c.state}`}>{STATE_LABEL[c.state]}</span>{' '}
			<a className="mono" href={repoUrl ? `${repoUrl}/commit/${sha}` : undefined} target="_blank" rel="noreferrer">
				{sha.slice(0, 7)}
			</a>{' '}
			{c.subject}
		</span>
	)
}

/** A diff of the diff: the first column says what changed in the patch, the rest is the patch line itself. */
function InterDiff({ lines }: { lines: Array<string> }) {
	return (
		<pre className="fixed-patch-hunk mono since-interdiff">
			{lines.map((l, i) => {
				const mark = l[0] ?? ' '
				const kind = mark === '+' ? 'add' : mark === '-' ? 'del' : mark === '@' || mark === '#' ? 'head' : 'ctx'
				return (
					<div key={i} className={`fixed-patch-line ${kind}`}>
						<span className="fixed-patch-sign">{kind === 'add' ? '+' : kind === 'del' ? '−' : ' '}</span>
						<span>{kind === 'head' ? l : l.slice(1)}</span>
					</div>
				)
			})}
		</pre>
	)
}
