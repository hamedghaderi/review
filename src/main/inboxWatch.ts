import {
	canMarkSeen,
	diffInbox,
	homeCount,
	keepSeen,
	watchKey,
	withSeen,
	type InboxEvent,
	type SeenHeads,
	type WatchedPr,
	type WatchState,
} from '../shared/inbox.ts'
import type { GitHubService } from './github.ts'
import type { ReviewStore } from './store.ts'

const MAX_BASE_CHECKS = 20 // pull requests compared with your review per look, two GitHub requests each

export type RepoEvent = InboxEvent & { repoId: string }
/** A change in any repository; `repoId` is null when no clone of it has been opened in the app. */
export type WatchEvent = InboxEvent & { repoId: string | null }

export interface InboxWatcherOptions {
	github: GitHubService
	store: ReviewStore
	/** GitHub repositories ("owner/name", lower case) of repositories opened in the app → their ids. */
	known(): Map<string, string>
	/** Changes in every repository that is not muted, whether or not it was opened in the app. */
	notify(events: Array<WatchEvent>): void
	/** Pull requests waiting for you in repositories that are not muted, as the start page counts them (0 clears the badge). */
	badge(count: number): void
	/** The requests or reviewed pull requests changed since the last check, so open lists can reload. */
	changed?(): void
	intervalMs?: number
}

/**
 * Checks your review requests and reviewed pull requests on GitHub every minute and reports what changed: a new
 * request, a request after you already reviewed, a draft marked ready, or new commits on one you reviewed (unless they only merged
 * the base branch in). The last state is stored, so changes made while the app was closed
 * are reported at the next start. Every repository is tracked (one search covers them all) and notifies unless muted,
 * whether or not it was opened in the app. It runs whenever GitHub is connected, since the start page lists what it saw.
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

	/**
	 * New heads on pull requests you reviewed whose own changes are the same as at your review: the push only merged the
	 * base branch in (or rebased onto it without changing anything). Returned as marks, so they neither notify, count
	 * nor start a follow-up review. Each new head is checked once, at most MAX_BASE_CHECKS per look; one that can't be
	 * checked counts as new commits.
	 */
	private async baseOnly(prs: ReadonlyArray<WatchedPr>, prev: WatchState | null, seen: SeenHeads): Promise<SeenHeads> {
		const fresh = prs
			.filter((p) => {
				const key = watchKey(p)
				return canMarkSeen(p) && !!p.base && !!p.reviewedCommit && seen[key] !== p.head && prev?.[key]?.head !== p.head
			})
			.slice(0, MAX_BASE_CHECKS)
		const quiet: SeenHeads = {}
		for (const p of fresh) {
			try {
				const [before, after] = await Promise.all([
					this.o.github.ownChanges(p.repo, p.base!, p.reviewedCommit!),
					this.o.github.ownChanges(p.repo, p.base!, p.head!),
				])
				if (before !== null && before === after) quiet[watchKey(p)] = p.head!
			} catch (e) {
				console.warn(`[inbox] could not compare ${p.repo}#${p.number} with your review:`, e instanceof Error ? e.message : e)
			}
		}
		return quiet
	}

	private async poll(): Promise<void> {
		const { github, store } = this.o
		this.lastCheck = Date.now()
		const notify = github.notifications.enabled
		if (github.status().state !== 'connected') return this.o.badge(0)
		try {
			const r = await github.watchRequests()
			if (!r) return this.o.badge(0)
			const saved = store.read().inboxWatch
			const prev = saved && saved.login === r.viewer ? saved.state : null
			// New commits you marked as seen neither notify nor count; a mark is dropped once the pull request moves on.
			// A push that only brought in the base branch is marked seen here, as if you had.
			const kept = keepSeen(store.read().seenHeads, r.prs)
			const quiet = await this.baseOnly(r.prs, prev, kept)
			const seen = { ...kept, ...quiet }
			const prs = r.prs.map((p) => withSeen(p, seen))
			const { events, state } = diffInbox(prev, prs)
			await store.update((d) => {
				d.inboxWatch = { login: r.viewer, state, at: new Date().toISOString(), prs: r.prs }
				d.seenHeads = { ...keepSeen(d.seenHeads, r.prs), ...quiet } // re-read, so a mark made during this check is kept
			})
			const known = this.o.known()
			const muted = new Set(store.read().mutedRepos ?? [])
			const isMuted = (repo: string): boolean => muted.has(repo.toLowerCase())
			this.o.badge(notify ? homeCount(prs.map((p) => ({ ...p, repoId: null, muted: isMuted(p.repo), appClone: false }))) : 0)
			if (!prev || JSON.stringify(prev) !== JSON.stringify(state)) this.o.changed?.()
			const loud = events.filter((e) => !isMuted(e.pr.repo)).map((e) => ({ ...e, repoId: known.get(e.pr.repo.toLowerCase()) ?? null }))
			if (loud.length) this.o.notify(loud)
		} catch (e) {
			// Offline, rate-limited or a revoked token: try again at the next interval; the status shows the cause.
			console.warn('[inbox] could not check review requests:', e instanceof Error ? e.message : e)
		}
	}
}
