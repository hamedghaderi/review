import { diffInbox, type InboxEvent } from '../shared/inbox.ts'
import type { GitHubService } from './github.ts'
import type { ReviewStore } from './store.ts'

export type RepoEvent = InboxEvent & { repoId: string }

export interface InboxWatcherOptions {
	github: GitHubService
	store: ReviewStore
	/** GitHub repositories ("owner/name", lower case) of repositories opened in the app → their ids. */
	known(): Map<string, string>
	notify(events: Array<RepoEvent>): void
	/** Open, non-draft requests in known repositories (0 clears the badge). */
	badge(count: number): void
	/** The requests or reviewed pull requests changed since the last check, so open lists can reload. */
	changed?(): void
	intervalMs?: number
}

/**
 * Checks your review requests and reviewed pull requests on GitHub every minute and reports what changed: a new
 * request, a request after you already reviewed, a draft marked ready, or new commits on one you reviewed. The last state is stored, so changes made while the app was closed
 * are reported at the next start. Every repository is tracked (one search covers them all), but only repositories
 * opened in the app notify, so opening a repository for the first time does not announce its existing requests.
 */
export class InboxWatcher {
	private timer: ReturnType<typeof setTimeout> | null = null
	private running: Promise<void> | null = null
	private stopped = false
	private lastCheck = 0
	private o: InboxWatcherOptions

	constructor(o: InboxWatcherOptions) {
		this.o = o
	}

	start(delayMs = 5_000): void {
		this.stopped = false
		this.schedule(delayMs)
	}

	stop(): void {
		this.stopped = true
		if (this.timer) clearTimeout(this.timer)
		this.timer = null
	}

	/** Checks now (e.g. after GitHub connects or settings change); a check already running is reused. */
	check(): Promise<void> {
		this.running ??= this.poll().finally(() => {
			this.running = null
			this.schedule(this.o.intervalMs ?? 60_000)
		})
		return this.running
	}

	/** Checks now unless the last check started less than `ms` ago (e.g. when the window gains focus). */
	checkIfOlder(ms: number): void {
		if (!this.stopped && Date.now() - this.lastCheck >= ms) void this.check()
	}

	private schedule(ms: number): void {
		if (this.stopped) return
		if (this.timer) clearTimeout(this.timer)
		this.timer = setTimeout(() => void this.check(), ms)
	}

	private async poll(): Promise<void> {
		const { github, store } = this.o
		this.lastCheck = Date.now()
		if (!github.notifications.enabled || github.status().state !== 'connected') return this.o.badge(0)
		try {
			const r = await github.watchRequests()
			if (!r) return this.o.badge(0)
			const saved = store.read().inboxWatch
			const prev = saved && saved.login === r.viewer ? saved.state : null
			const { events, state } = diffInbox(prev, r.prs)
			await store.update((d) => void (d.inboxWatch = { login: r.viewer, state, at: new Date().toISOString() }))
			const known = this.o.known()
			this.o.badge(r.prs.filter((p) => p.requested !== false && !p.draft && known.has(p.repo.toLowerCase())).length)
			if (!prev || JSON.stringify(prev) !== JSON.stringify(state)) this.o.changed?.()
			const mine = events.flatMap((e) => {
				const repoId = known.get(e.pr.repo.toLowerCase())
				return repoId ? [{ ...e, repoId }] : []
			})
			if (mine.length) this.o.notify(mine)
		} catch (e) {
			// Offline, rate-limited or a revoked token: try again at the next interval; the status shows the cause.
			console.warn('[inbox] could not check review requests:', e instanceof Error ? e.message : e)
		}
	}
}
