import { useEffect, useRef, useState } from 'react'
import type { AppClone, GifStatus, GitHubMapping, GitHubStatus, Result } from '../../shared/types.ts'

const STATE_TEXT: Record<GitHubStatus['state'], string> = {
	anonymous: 'Not connected',
	checking: 'Checking…',
	connected: 'Connected',
	failed: 'Connection failed',
	offline: 'Offline',
}

/** Runs a GitHub settings change; the settings window shows any error and takes the new status. */
export type GitHubAct = (p: Promise<Result<GitHubStatus>>) => Promise<void>

/** Settings → GitHub → Account: the gh CLI login or a personal access token for the API. */
export function GitHubAccount({ status, act }: { status: GitHubStatus; act: GitHubAct }) {
	const [token, setToken] = useState('')
	const [persist, setPersist] = useState(status.storage.secure)
	const [saving, setSaving] = useState(false)

	async function save(): Promise<void> {
		setSaving(true)
		await act(window.review.githubSetToken(token, persist))
		setSaving(false)
		setToken('')
	}

	const hasToken = status.credential === 'saved' || status.credential === 'session'
	return (
		<div className="settings-main form">
			<div className="detail-head">
				<h3>GitHub API</h3>
				<span
					className={`status-pill ${status.state === 'connected' ? 'connected' : status.state === 'failed' ? 'failed' : status.state === 'checking' ? 'testing' : ''}`}
				>
					{STATE_TEXT[status.state]}
					{status.login && ` as ${status.login}`}
				</span>
			</div>
			{status.message && <p className="error-text small selectable">{status.message}</p>}
			<p className="muted small">
				Browsing local and remote branches never needs GitHub. Signing in lets you list private pull requests, see review requests, use the
				“Mine” and “Review requested” filters, publish reviews, and raises the API limit from 60 to 5,000 requests per hour.
			</p>
			{status.cli && (
				<div className={`cli-box ${status.source === 'gh' ? 'on' : ''}`}>
					<div className="cli-head">
						<strong>Use GitHub CLI login</strong>
						<span className="spacer" />
						{status.cli.enabled ? (
							<button className="btn small" onClick={() => void act(window.review.githubUseCli(false))}>
								Stop using
							</button>
						) : (
							<button
								className="btn small primary"
								disabled={!status.cli.available}
								onClick={() => void act(window.review.githubUseCli(true))}
							>
								Use {status.cli.login ? `gh login (${status.cli.login})` : 'gh login'}
							</button>
						)}
					</div>
					<p className="muted small">
						{status.cli.available
							? `Uses the account the GitHub CLI is logged in with${status.cli.login ? ` (${status.cli.login})` : ''}, with the same access gh has. The app asks gh for its token when needed and never stores it; logging out of gh disconnects the app too.`
							: 'The GitHub CLI (gh) isn’t installed or isn’t logged in. Install it and run “gh auth login” in a terminal, then reopen this page.'}
					</p>
					{status.cli.enabled && hasToken && (
						<p className="small warn-text">A token saved below takes precedence. Remove it to use the gh login.</p>
					)}
					{status.source === 'gh' && status.scopes && !status.scopes.includes('repo') && (
						<p className="small warn-text">
							The gh login has no “repo” scope ({status.scopes.join(', ') || 'none'}), so private repositories and publishing won’t work.
							Run “gh auth refresh -s repo”.
						</p>
					)}
				</div>
			)}
			<h3 className="small-h">Or a personal access token</h3>
			<p className="muted small">
				Create a <strong>fine-grained</strong> token with <strong>Pull requests: Read</strong> for browsing, or{' '}
				<strong>Read and write</strong> if you also want to publish reviews (Metadata: Read is added automatically). For organization
				repositories, choose the organization as resource owner. The token is used for GitHub API calls only. Pull request commits are
				fetched with Git, which uses your existing SSH keys or credential helper, so a connected token doesn’t guarantee that fetching will
				succeed.
			</p>
			<div>
				<a href={status.tokenUrl} target="_blank" rel="noreferrer">
					Create a read-only token ↗
				</a>
				{' · '}
				<a href={status.writeTokenUrl} target="_blank" rel="noreferrer">
					Create a token that can publish reviews ↗
				</a>
			</div>
			{!status.storage.secure && status.storage.message && <div className="notice">{status.storage.message}</div>}
			<form
				className="key-form"
				onSubmit={(e) => {
					e.preventDefault()
					if (token.trim()) void save()
				}}
			>
				<label className="field">
					<span>{hasToken ? 'Replace token' : 'Personal access token'}</span>
					<div className="key-row">
						<input
							type="password"
							autoComplete="off"
							spellCheck={false}
							placeholder="github_pat_…"
							value={token}
							onChange={(e) => setToken(e.target.value)}
						/>
						<button className="btn primary" disabled={!token.trim() || saving}>
							{saving ? 'Checking…' : 'Save and test'}
						</button>
					</div>
				</label>
				<label className="check small">
					<input type="checkbox" checked={persist} disabled={!status.storage.secure} onChange={(e) => setPersist(e.target.checked)} />
					Remember in the system keychain ({status.storage.backend})
				</label>
			</form>
			{hasToken && (
				<div className="form-actions">
					<button className="btn" onClick={() => void act(window.review.githubVerify())} disabled={status.state === 'checking'}>
						Test again
					</button>
					<button className="btn danger" onClick={() => void act(window.review.githubDisconnect())}>
						Disconnect
					</button>
					<span className="muted small">{status.credential === 'session' ? 'Kept for this session only.' : 'Stored encrypted.'}</span>
				</div>
			)}
			{status.rate && (
				<p className="muted small">
					API requests left: {status.rate.remaining.toLocaleString()} of {status.rate.limit.toLocaleString()} (resets{' '}
					{new Date(status.rate.resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}).
				</p>
			)}
		</div>
	)
}

/** Settings → GitHub → Notifications: review requests checked in the background. */
export function GitHubNotifications({ status, act }: { status: GitHubStatus; act: GitHubAct }) {
	return (
		<div className="settings-main form">
			<div className="notify-box small">
				<label className="check">
					<input
						type="checkbox"
						checked={status.notifications.enabled}
						onChange={(e) => void act(window.review.githubSetNotifications({ ...status.notifications, enabled: e.target.checked }))}
					/>
					<span>
						<strong>Notify me about review requests</strong>
						<span className="muted block">
							Checks GitHub every minute while the app runs (and when your Mac wakes), for repositories you have opened here: a new request,
							a request after you already reviewed, a draft marked ready, or new commits on a pull request you reviewed. Clicking a
							notification opens the review. The dock icon shows how many requests are open.
						</span>
					</span>
				</label>
				<div>
					<button className="btn small" onClick={() => void act(window.review.githubTestNotification())}>
						Send a test notification
					</button>
				</div>
				{status.notificationProblem && <p className="small error-text selectable">{status.notificationProblem}</p>}
			</div>
		</div>
	)
}

export function GitHubRepoChoice({ mapping, onChoose }: { mapping: GitHubMapping; onChoose(repo: string): void }) {
	return (
		<div className="settings-main form">
			<h3>Pull requests for this repository</h3>
			<p className="muted small">
				Remotes point at more than one GitHub repository. Choose whose pull requests to browse. The choice is remembered for this clone.
			</p>
			{mapping.candidates.map((c) => (
				<label key={c.repo} className="radio">
					<input type="radio" name="gh-repo" checked={mapping.selected === c.repo} onChange={() => onChoose(c.repo)} />
					<span className="mono">{c.repo}</span>
					<span className="muted small">({c.remotes.join(', ')})</span>
				</label>
			))}
		</div>
	)
}

/**
 * Automatic review, off by default. Ticking the box only opens a warning: it is turned on from there, once you have read
 * that the app will post reviews and approve pull requests as you.
 */
export function AutoReview({
	on,
	commits,
	onSet,
	onSetCommits,
}: {
	on: boolean
	commits: boolean
	onSet(enabled: boolean): Promise<void>
	onSetCommits(enabled: boolean): Promise<void>
}) {
	const [confirming, setConfirming] = useState(false)
	const confirm = useRef<HTMLButtonElement>(null)
	useEffect(() => {
		if (confirming) confirm.current?.focus()
	}, [confirming])
	return (
		<div className={`notify-box small ${on ? 'on' : ''}`}>
			<label className="check">
				<input
					type="checkbox"
					checked={on}
					onChange={(e) => {
						if (e.target.checked) setConfirming(true)
						else void onSet(false)
					}}
				/>
				<span>
					<strong>Review requests automatically with AI</strong>
					<span className="muted block">
						When someone requests your review in a repository you have opened here, the AI reviews the pull request with the model or team
						chosen for AI reviews, and submits the review on GitHub as you. Findings at the levels set to be added as comments are posted.
						It approves when every file was reviewed, it found no blocking, should-fix or question findings and CI passed (it waits up to 20
						minutes for checks to finish), requests changes for a blocking finding, and otherwise comments. You get a notification each
						time. Needs a token that can publish reviews.
					</span>
				</span>
			</label>
			<label className="check">
				<input type="checkbox" checked={commits} disabled={!on} onChange={(e) => void onSetCommits(e.target.checked)} />
				<span>
					Also review new commits
					<span className="muted block">
						When a pull request it reviewed gets new commits, it reviews only the files whose changes differ since then, once nothing has
						been pushed for 5 minutes. It submits a new review with the new findings; the earlier ones are not posted again. When every file
						changed, or the model, team or finding levels did, it skips the commits and tells you.
					</span>
				</span>
			</label>
			{confirming && !on && (
				<div className="auto-review-warn" role="alertdialog" aria-labelledby="auto-review-warn-title">
					<p id="auto-review-warn-title">
						<strong>Before you turn this on: the app will act as you on GitHub.</strong>
					</p>
					<ul>
						<li>Reviews are written by AI and submitted under your GitHub account right away, without you reading them first.</li>
						<li>
							It can <strong>approve pull requests</strong>. An approval from you may be enough for a pull request to be merged.
						</li>
						<li>It can also request changes, which can block a pull request until it is reviewed again.</li>
						<li>The AI can be wrong, and people will read the review as yours.</li>
					</ul>
					<div className="form-actions">
						<button ref={confirm} className="btn small danger" onClick={() => void onSet(true).then(() => setConfirming(false))}>
							Turn on automatic review
						</button>
						<button className="btn small" onClick={() => setConfirming(false)}>
							Cancel
						</button>
					</div>
				</div>
			)}
		</div>
	)
}

/** The GIPHY API key for GIFs in review summaries. Checked with one request, kept in the main process only. */
export function GiphyKey() {
	const [status, setStatus] = useState<GifStatus | null>(null)
	const [key, setKey] = useState('')
	const [persist, setPersist] = useState(true)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		void window.review.gifStatus().then((r) => {
			if (!r.ok) return
			setStatus(r.value)
			setPersist(r.value.storage.secure)
		})
	}, [])

	const act = async (p: ReturnType<typeof window.review.gifStatus>): Promise<void> => {
		setSaving(true)
		setError(null)
		const r = await p
		setSaving(false)
		setKey('')
		if (r.ok) setStatus(r.value)
		else setError(r.error.message)
	}

	if (!status) return null
	const has = status.key !== 'none'
	return (
		<>
			<h3>GIFs in reviews</h3>
			<p className="muted small">
				The GIF button in “Publish to GitHub” searches GIPHY (workplace-safe rating G only). Your search words go to GIPHY; the app
				downloads small previews itself and checks that they are GIFs, and the review only gets an image link that GitHub shows through its
				own image proxy. Get a free key by creating an API app on the{' '}
				<a href={status.keyUrl} target="_blank" rel="noreferrer">
					GIPHY developer dashboard ↗
				</a>
				.
			</p>
			{error && <p className="small error-text">{error}</p>}
			<form
				className="key-form"
				onSubmit={(e) => {
					e.preventDefault()
					if (key.trim()) void act(window.review.gifSetKey(key, persist))
				}}
			>
				<label className="field">
					<span>{has ? 'Replace GIPHY API key' : 'GIPHY API key'}</span>
					<div className="key-row">
						<input type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} />
						<button className="btn primary" disabled={!key.trim() || saving}>
							{saving ? 'Checking…' : 'Save and test'}
						</button>
					</div>
				</label>
				<label className="check small">
					<input type="checkbox" checked={persist} disabled={!status.storage.secure} onChange={(e) => setPersist(e.target.checked)} />
					Remember in the system keychain ({status.storage.backend})
				</label>
			</form>
			{has && (
				<div className="form-actions">
					<button className="btn danger" onClick={() => void act(window.review.gifRemoveKey())} disabled={saving}>
						Remove key
					</button>
					<span className="muted small">{status.key === 'session' ? 'Kept for this session only.' : 'Stored encrypted.'}</span>
				</div>
			)}
		</>
	)
}

function size(bytes: number | null): string {
	if (bytes === null) return 'size unknown'
	const units = ['B', 'KB', 'MB', 'GB']
	let n = bytes
	let u = 0
	while (n >= 1024 && u < units.length - 1) {
		n /= 1024
		u++
	}
	return `${n < 10 && u > 0 ? n.toFixed(1) : Math.round(n)} ${units[u]}`
}

/** The clones the app made for repositories you had no clone of, each deletable (to the Trash, after asking). */
export function AppClones({ onDelete }: { onDelete(repoId: string): Promise<boolean> }) {
	const [clones, setClones] = useState<Array<AppClone> | null>(null)
	const [error, setError] = useState<string | null>(null)
	const load = (): void =>
		void window.review.appClones().then((r) => {
			if (r.ok) setClones(r.value)
			else setError(r.error.message)
		})
	useEffect(load, [])
	if (!clones && !error) return null
	return (
		<>
			<h3>Clones made by the app</h3>
			<p className="muted small">
				Made with “Clone for me” for repositories you had no clone of. Deleting one moves its folder to the Trash, and the app forgets its
				reviews.
			</p>
			{error && <p className="small error-text">{error}</p>}
			{clones?.length === 0 && <p className="muted small">The app hasn’t cloned any repositories.</p>}
			<ul className="clone-list">
				{clones?.map((c) => (
					<li key={c.root}>
						<div className="clone-info">
							<span className="mono">{c.repo}</span>
							<span className="muted small ellipsis" title={c.root}>
								{c.root} · {c.missing ? 'folder missing' : size(c.bytes)}
							</span>
						</div>
						{!c.missing && (
							<button className="btn small ghost" onClick={() => void window.review.revealAppClone(c.repoId)}>
								Show in folder
							</button>
						)}
						<button
							className="btn small danger"
							onClick={() =>
								void onDelete(c.repoId).then((deleted) => {
									if (deleted) load()
								})
							}
						>
							Delete
						</button>
					</li>
				))}
			</ul>
		</>
	)
}
