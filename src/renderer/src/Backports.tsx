import { backportSummary, type BackportCommit, type Backports } from '../../shared/backports.ts'
import { InterDiff } from './SinceReview.tsx'

/** "Backport: 3 same as on main, 1 differs, 1 new" in the target bar; opens the list. Facts only, never posted. */
export function BackportLabel({ backports: b, open, onToggle }: { backports: Backports; open: boolean; onToggle(): void }) {
	if (b.error)
		return (
			<span className="agent-share nowrap" title={b.error}>
				Backport: not matched with {b.defaultBranch}
			</span>
		)
	return (
		<button
			className={`btn small ghost backport-toggle${open ? ' on' : ''}`}
			aria-expanded={open}
			onClick={onToggle}
			title={`This pull request's commits, matched with their originals on ${b.defaultBranch}. A commit that differs from its original is where the backport needs a look.`}
		>
			Backport: {backportSummary(b)}
		</button>
	)
}

const LABEL: Record<BackportCommit['state'], (main: string) => string> = {
	same: (main) => `Same as on ${main}`,
	differs: () => 'Differs from its original',
	none: () => 'No original found',
}

const VIA: Record<NonNullable<BackportCommit['via']>, string> = {
	patch: 'it has the same patch',
	'cherry-pick': 'its “cherry picked from” line names it',
	subject: 'it is the one commit there with this subject',
}

/** Each commit with its original; one that differs opens how, as a diff of the diff. */
export function BackportList({ backports: b, repoUrl }: { backports: Backports; repoUrl: string | null }) {
	const link = (sha: string) => (
		<a className="mono" href={repoUrl ? `${repoUrl}/commit/${sha}` : undefined} target="_blank" rel="noreferrer">
			{sha.slice(0, 7)}
		</a>
	)
	const line = (c: BackportCommit) => (
		<span>
			<span className={`since-state ${c.state === 'differs' ? 'changed' : c.state === 'none' ? 'new' : 'same'}`}>
				{LABEL[c.state](b.defaultBranch)}
			</span>{' '}
			{link(c.sha)} {c.subject}
			{c.state !== 'none' && (
				<span className="muted" title={c.via ? `Matched because ${VIA[c.via]}.` : undefined}>
					{' '}
					· original {c.original ? link(c.original) : `on ${b.defaultBranch}`}
					{c.pr && (
						<>
							{' '}
							in{' '}
							<a href={c.pr.url} target="_blank" rel="noreferrer">
								#{c.pr.number}
							</a>{' '}
							{c.pr.title}
						</>
					)}
				</span>
			)}
		</span>
	)
	return (
		<div className="banner drift-banner since-review" role="region" aria-label="Backported commits">
			<div className="drift-head">
				<span>
					<strong>Backport into a branch other than {b.defaultBranch}</strong>: {backportSummary(b)}. Commits the same as on{' '}
					{b.defaultBranch} were reviewed there; the ones that differ are where to look.
				</span>
			</div>
			<ul className="since-list small">
				{b.commits.map((c) => (
					<li key={c.sha}>
						{c.state === 'differs' ? (
							<details>
								<summary>{line(c)}</summary>
								{c.diff.length ? (
									<InterDiff lines={c.diff} />
								) : (
									<p className="muted">The difference is too large to show here. Compare the two commits on GitHub.</p>
								)}
							</details>
						) : (
							line(c)
						)}
					</li>
				))}
			</ul>
		</div>
	)
}

/** " · same as on main" after a commit in the commit picker. */
export function backportTag(b: Backports | null, sha: string): string {
	const c = b && !b.error ? b.commits.find((x) => x.sha === sha) : null
	return c?.state === 'same' ? ` · same as on ${b!.defaultBranch}` : c?.state === 'differs' ? ' · differs from its original' : ''
}
