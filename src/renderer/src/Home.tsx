import { useCallback, useEffect, useMemo, useState } from 'react'
import { homeCount, INBOX_LABEL, type HomeInbox, type HomePr } from '../../shared/inbox.ts'
import type { InboxStatus } from '../../shared/types.ts'
import { ago } from './branches.ts'
import { useStored } from './useStored.ts'

/**
 * The start page's pull requests, kept current: read when shown, when the background check reports a change, and every
 * 30 seconds (the "checked" time moves even when nothing else does). Reading costs no GitHub request.
 */
export function useHomeInbox(enabled: boolean, refresh?: unknown): [HomeInbox | null, (next: HomeInbox) => void] {
	const [inbox, setInbox] = useState<HomeInbox | null>(null)
	useEffect(() => {
		if (!enabled) return
		let live = true
		const load = (): void => void window.review.homeInbox().then((r) => live && r.ok && setInbox(r.value))
		load()
		const off = window.review.onInboxChanged(load)
		const t = window.setInterval(load, 30_000)
		return () => {
			live = false
			off()
			window.clearInterval(t)
		}
	}, [enabled, refresh])
	return [inbox, setInbox]
}

// A requested PR you already reviewed was asked again; "new" needs the per-clone "seen" marks, so it isn't used here.
function statusOf(pr: HomePr): InboxStatus {
	return pr.requested !== false ? (pr.reviewed ? 're-requested' : 'waiting') : 'updated'
}

const ORDER: Record<InboxStatus, number> = { 're-requested': 0, new: 1, waiting: 1, updated: 2, reviewed: 3 }

/** What needs you most first: asked again, then waiting, then new commits; drafts last; newest first within each. */
function sortHome(prs: ReadonlyArray<HomePr>): Array<HomePr> {
	return [...prs].sort(
		(a, b) =>
			Number(a.draft) - Number(b.draft) ||
			ORDER[statusOf(a)] - ORDER[statusOf(b)] ||
			(b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') ||
			b.number - a.number,
	)
}

/**
 * The start page: one list of every pull request waiting for your review, in every repository on GitHub, whether or
 * not its clone is open here. Opening one in a repository without a clone asks for the clone first.
 */
export function Home(props: {
	inbox: HomeInbox | null
	notifications: boolean
	onOpen(pr: HomePr): void
	onMute(repo: string, muted: boolean): void
	onRefresh(): Promise<void>
	onConnect(): void
	onOpenRepo(): void
	onDeleteClone(repoId: string): void
	onManageClones(): void
}) {
	const { inbox } = props
	const prs = useMemo(() => inbox?.prs ?? [], [inbox])
	const [repo, setRepo] = useState<string | null>(null) // lower case; null: all repositories
	const [muted, setMuted] = useStored<'hide' | 'show'>('home.muted', 'hide', ['hide', 'show'])
	const [refreshing, setRefreshing] = useState(false)
	// How many clones the app made, for the button that lists them (with Delete) in Settings · GitHub.
	const [clones, setClones] = useState(0)
	useEffect(() => void window.review.appClones().then((r) => r.ok && setClones(r.value.length)), [inbox])
	const refresh = useCallback(async () => {
		setRefreshing(true)
		await props.onRefresh().finally(() => setRefreshing(false))
	}, [props])

	// Every repository with something listed, the most waiting first, for the filter.
	const repos = useMemo(() => {
		const by = new Map<string, { name: string; muted: boolean; clone: string | null; prs: Array<HomePr> }>()
		for (const p of prs) {
			const key = p.repo.toLowerCase()
			const r = by.get(key) ?? { name: p.repo, muted: p.muted, clone: p.appClone ? p.repoId : null, prs: [] }
			r.prs.push(p)
			by.set(key, r)
		}
		return [...by.entries()]
			.map(([key, r]) => ({ key, name: r.name, muted: r.muted, clone: r.clone, count: homeCount(r.prs) }))
			.sort((a, b) => Number(a.muted) - Number(b.muted) || b.count - a.count || a.key.localeCompare(b.key))
	}, [prs])
	const chosen = repos.find((r) => r.key === repo) ?? null
	const mutedRepos = repos.filter((r) => r.muted).length
	const rows = useMemo(
		() => sortHome(prs.filter((p) => (chosen ? p.repo.toLowerCase() === chosen.key : muted === 'show' || !p.muted))),
		[prs, chosen, muted],
	)
	const total = homeCount(prs)

	if (inbox?.state === 'disconnected')
		return (
			<div className="empty">
				<h1>Review</h1>
				<p className="muted">Connect GitHub to see the pull requests waiting for your review, in all your repositories.</p>
				<div className="row">
					<button className="btn primary" onClick={props.onConnect}>
						Connect GitHub
					</button>
					<button className="btn" onClick={props.onOpenRepo}>
						Open repository
					</button>
				</div>
			</div>
		)

	return (
		<div className="home">
			<div className="home-head">
				<h1>Waiting for you</h1>
				{total > 0 && <span className="home-total">{total}</span>}
				<span className="spacer" />
				{inbox?.at && (
					<span className="muted small" title={new Date(inbox.at).toLocaleString()}>
						Checked {ago(inbox.at)}
					</span>
				)}
				{clones > 0 && (
					<button
						className="btn small ghost"
						onClick={props.onManageClones}
						title="The clones the app made for you, with their size; delete them there"
					>
						Clones ({clones})
					</button>
				)}
				<button className="btn small" onClick={() => void refresh()} disabled={refreshing}>
					{refreshing ? 'Checking…' : 'Check now'}
				</button>
			</div>
			{repos.length > 0 && (
				<div className="home-tools">
					<select
						className="home-filter"
						value={chosen?.key ?? ''}
						onChange={(e) => setRepo(e.target.value || null)}
						aria-label="Repository"
					>
						<option value="">All repositories</option>
						{repos.map((r) => (
							<option key={r.key} value={r.key}>
								{r.name}
								{r.muted ? ' (muted)' : r.count ? ` (${r.count})` : ''}
							</option>
						))}
					</select>
					{chosen ? (
						<button
							className="btn small ghost"
							onClick={() => props.onMute(chosen.name, !chosen.muted)}
							title={
								chosen.muted
									? 'Notify and count this repository again'
									: 'Stop notifying and counting this repository. Its pull requests stay listed.'
							}
						>
							{chosen.muted ? 'Unmute' : 'Mute'} {chosen.name}
						</button>
					) : (
						mutedRepos > 0 && (
							<label className="home-check small muted">
								<input type="checkbox" checked={muted === 'show'} onChange={(e) => setMuted(e.target.checked ? 'show' : 'hide')} />
								Show muted ({mutedRepos})
							</label>
						)
					)}
					{chosen?.clone && (
						<button
							className="btn small ghost danger"
							onClick={() => props.onDeleteClone(chosen.clone!)}
							title="Move the clone the app made for this repository to the Trash. You can clone it again from any of its pull requests."
						>
							Delete clone
						</button>
					)}
					{!props.notifications && <span className="muted small">Notifications are off, so these are not announced.</span>}
				</div>
			)}
			{!inbox || (!inbox.at && !prs.length) ? (
				<p className="muted home-note">Checking GitHub…</p>
			) : !rows.length ? (
				<p className="muted home-note">Nothing is waiting for your review.</p>
			) : (
				<ul className="home-list" aria-label="Waiting for you">
					{rows.map((pr) => {
						const status = statusOf(pr)
						return (
							<li key={`${pr.repo}#${pr.number}`} className={pr.muted ? 'muted-row' : undefined}>
								<button className="home-row" onClick={() => props.onOpen(pr)} title={`${pr.title}\nOpen ${pr.repo}#${pr.number}`}>
									<div className="pr-line1">
										{pr.draft ? (
											<span className="pill small-pill home-status">Draft</span>
										) : (
											<span className={`pill small-pill inbox-pill home-status ${status}`}>{INBOX_LABEL[status]}</span>
										)}
										<span className="pr-title ellipsis">{pr.title}</span>
										<span className="muted mono small">#{pr.number}</span>
									</div>
									<div className="pr-line2 small muted">
										<span className="ellipsis">
											{pr.repo} · {pr.author ?? 'ghost'}
											{pr.updatedAt ? ` · ${ago(pr.updatedAt)}` : ''}
										</span>
										<span className="spacer" />
										{pr.muted && <span className="nowrap">muted</span>}
										{!pr.repoId && (
											<span className="nowrap" title="Opening it asks for your local clone first; after that it opens directly.">
												no clone yet
											</span>
										)}
									</div>
								</button>
							</li>
						)
					})}
				</ul>
			)}
		</div>
	)
}
