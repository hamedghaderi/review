import type { InboxStatus, PrSummary, ReviewVerdict } from './types.ts'

/**
 * Your standing on one open pull request. `requested`: your review is requested now (directly or through a team).
 * GitHub removes your request when you submit a review, so requested plus a review of yours means you were asked again.
 */
export function inboxStatus(pr: PrSummary, viewer: string | null, requested: boolean, seen: boolean): InboxStatus | null {
	const mine = viewer ? pr.review?.reviewers.find((r) => r.login.toLowerCase() === viewer.toLowerCase()) : undefined
	if (requested) return mine ? 're-requested' : seen ? 'waiting' : 'new'
	if (!mine) return null
	return mine.stale ? 'updated' : 'reviewed'
}

export const INBOX_ORDER: Record<InboxStatus, number> = { 're-requested': 0, new: 1, waiting: 2, updated: 3, reviewed: 4 }

export const INBOX_LABEL: Record<InboxStatus, string> = {
	new: 'New',
	waiting: 'Waiting for you',
	're-requested': 'Re-requested',
	updated: 'New commits since your review',
	reviewed: 'Reviewed',
}

/** Requested PRs first (asked again, then new, then seen), then the ones you reviewed; newest first within each. */
export function sortInbox(items: Array<PrSummary>): Array<PrSummary> {
	return [...items].sort(
		(a, b) => INBOX_ORDER[a.inbox ?? 'reviewed'] - INBOX_ORDER[b.inbox ?? 'reviewed'] || b.updatedAt.localeCompare(a.updatedAt),
	)
}

// ─── Notifications ────────────────────────────────────────────────────────────

/**
 * One open pull request that requests your review, or that you reviewed, as seen by the watcher. `requested` is
 * absent in state written before reviewed pull requests were watched, and means requested then.
 */
export interface WatchedPr {
	repo: string // "owner/name"
	number: number
	title: string
	url: string
	author: string | null
	draft: boolean
	reviewed: boolean // you have reviewed it before
	requested?: boolean // your review is requested now (false: listed only because you reviewed it)
	head?: string | null // head commit
	stale?: boolean // your latest review is on an older commit than `head`
	verdict?: ReviewVerdict | null // what your latest review said; absent on older stored state
}

// Keyed by "owner/name#number". `head` is absent in state written before new commits were watched.
export type WatchState = Record<string, { draft: boolean; reviewed: boolean; requested?: boolean; head?: string | null }>

export interface InboxEvent {
	kind: 'requested' | 're-requested' | 'ready' | 'updated'
	pr: WatchedPr
}

export const watchKey = (pr: { repo: string; number: number }): string => `${pr.repo.toLowerCase()}#${pr.number}`

/** Open, non-draft pull requests in a GitHub repository ("owner/name") that request your review, as the dock badge counts them. */
export function requestCount(state: WatchState, repo: string): number {
	const prefix = `${repo.toLowerCase()}#`
	return Object.entries(state).filter(([key, s]) => key.startsWith(prefix) && s.requested !== false && !s.draft).length
}

/**
 * What changed since the last look at your review requests and reviewed pull requests. Without an earlier look (first
 * run, or another account) nothing is reported, so connecting does not announce every existing request. Drafts are not
 * announced until they are marked ready. `updated`: a pull request you reviewed, and that does not request you again,
 * got new commits since your review; reported once per new head commit, and only for a pull request seen before with
 * a known head, so the first look after an upgrade does not announce every older review.
 */
export function diffInbox(prev: WatchState | null, now: Array<WatchedPr>): { events: Array<InboxEvent>; state: WatchState } {
	const state: WatchState = {}
	const events: Array<InboxEvent> = []
	for (const pr of now) {
		const key = watchKey(pr)
		const requested = pr.requested !== false
		state[key] = { draft: pr.draft, reviewed: pr.reviewed, requested, head: pr.head ?? null }
		if (!prev) continue
		const before = prev[key]
		if (pr.draft) continue
		if (requested) {
			if (!before) events.push({ kind: pr.reviewed ? 're-requested' : 'requested', pr })
			else if (before.draft) events.push({ kind: pr.reviewed ? 're-requested' : 'ready', pr })
			// Listed last time only because you had reviewed it: you are asked again.
			else if (before.requested === false) events.push({ kind: 're-requested', pr })
			// Your review removes your request, so still being requested with a review you did not have last time means asked again.
			else if (pr.reviewed && !before.reviewed) events.push({ kind: 're-requested', pr })
		} else if (pr.stale && pr.head && before?.head && before.head !== pr.head) events.push({ kind: 'updated', pr })
	}
	return { events, state }
}
