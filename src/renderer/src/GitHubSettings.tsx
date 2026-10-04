import { useEffect, useRef, useState } from 'react'
import type { GifStatus, GitHubMapping, GitHubStatus } from '../../shared/types.ts'

interface Props {
	status: GitHubStatus
	mapping: GitHubMapping | null
	onClose(): void
	onStatus(s: GitHubStatus): void
	onChooseRepo(repo: string): void
}

const STATE_TEXT: Record<GitHubStatus['state'], string> = {
	anonymous: 'Not connected',
	checking: 'Checking…',
	connected: 'Connected',
	failed: 'Connection failed',
	offline: 'Offline',
}

/** Settings · GitHub: a read-only personal access token for the API, and which repository's pull requests to browse. */
export function GitHubSettings({ status, mapping, onClose, onStatus, onChooseRepo }: Props) {
	const [token, setToken] = useState('')
	const [persist, setPersist] = useState(status.storage.secure)
	const [error, setError] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)
	const dialog = useRef<HTMLDivElement>(null)

	useEffect(() => {
		dialog.current?.focus()
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape') onClose()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [onClose])

	async function save(): Promise<void> {
		setSaving(true)
		setError(null)
		const r = await window.review.githubSetToken(token, persist)
		setSaving(false)
		setToken('')
		if (!r.ok) setError(r.error.message)
		else onStatus(r.value)
	}

	async function act(p: ReturnType<typeof window.review.githubVerify>): Promise<void> {
		setError(null)
		const r = await p
		if (!r.ok) setError(r.error.message)
		else onStatus(r.value)
	}

	const hasToken = status.credential === 'saved' || status.credential === 'session'
	return (
		<div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className="modal gh-settings" role="dialog" aria-modal="true" aria-labelledby="gh-title" tabIndex={-1} ref={dialog}>
				<div className="modal-head">
					<h2 id="gh-title">Settings · GitHub</h2>
					<span className="spacer" />
					<button className="btn small ghost" onClick={onClose} aria-label="Close settings">
						✕
					</button>
				</div>
				{error && (
					<button className="notice error-notice" onClick={() => setError(null)} title="Dismiss">
						{error} ✕
					</button>
				)}
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
						Browsing local and remote branches never needs GitHub. Signing in lets you list private pull requests, see review requests, use
						the “Mine” and “Review requested” filters, publish reviews, and raises the API limit from 60 to 5,000 requests per hour.
					</p>
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
									Checks GitHub every minute while the app runs (and when your Mac wakes), for repositories you have opened here: a new
									request, a request after you already reviewed, a draft marked ready, or new commits on a pull request you reviewed.
									Clicking a notification opens the review. The dock icon shows how many requests are open.
								</span>
							</span>
						</label>
						<label className="check">
							<input
								type="checkbox"
								checked={status.notifications.sound}
								disabled={!status.notifications.enabled}
								onChange={(e) => void act(window.review.githubSetNotifications({ ...status.notifications, sound: e.target.checked }))}
							/>
							<span>Play a sound</span>
						</label>
						<div>
							<button className="btn small" onClick={() => void act(window.review.githubTestNotification())}>
								Send a test notification
							</button>
						</div>
						{status.notificationProblem && <p className="small error-text selectable">{status.notificationProblem}</p>}
					</div>
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
									: 'The GitHub CLI (gh) isn’t installed or isn’t logged in. Install it and run “gh auth login” in a terminal, then reopen this dialog.'}
							</p>
							{status.cli.enabled && hasToken && (
								<p className="small warn-text">A token saved below takes precedence. Remove it to use the gh login.</p>
							)}
							{status.source === 'gh' && status.scopes && !status.scopes.includes('repo') && (
								<p className="small warn-text">
									The gh login has no “repo” scope ({status.scopes.join(', ') || 'none'}), so private repositories and publishing won’t
									work. Run “gh auth refresh -s repo”.
								</p>
							)}
						</div>
					)}
					<h3 className="small-h">Or a personal access token</h3>
					<p className="muted small">
						Create a <strong>fine-grained</strong> token with <strong>Pull requests: Read</strong> for browsing, or{' '}
						<strong>Read and write</strong> if you also want to publish reviews (Metadata: Read is added automatically). For organization
						repositories, choose the organization as resource owner. The token is used for GitHub API calls only. Pull request commits are
						fetched with Git, which uses your existing SSH keys or credential helper, so a connected token doesn’t guarantee that fetching
						will succeed.
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

					<GiphyKey />

					{mapping && mapping.candidates.length > 0 && (
						<>
							<h3>Pull requests for this repository</h3>
							<p className="muted small">
								Remotes point at more than one GitHub repository. Choose whose pull requests to browse. The choice is remembered for this
								clone.
							</p>
							{mapping.candidates.map((c) => (
								<label key={c.repo} className="radio">
									<input type="radio" name="gh-repo" checked={mapping.selected === c.repo} onChange={() => onChooseRepo(c.repo)} />
									<span className="mono">{c.repo}</span>
									<span className="muted small">({c.remotes.join(', ')})</span>
								</label>
							))}
						</>
					)}
				</div>
			</div>
		</div>
	)
}

/** The GIPHY API key for GIFs in review summaries. Checked with one request, kept in the main process only. */
function GiphyKey() {
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
