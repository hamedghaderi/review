import type {
	Hunk,
	Publication,
	PublishedReview,
	PublishItem,
	PublishOutcome,
	PublishPlacement,
	PublishPlan,
	Review,
	ReviewComment,
	ReviewEvent,
} from '../shared/types.ts'
import { AppFail } from './git.ts'
import { errorOf, type GitHubService, type ReviewState, type ThreadInput } from './github.ts'
import { placeComment } from './placement.ts'
import type { ReviewStore } from './store.ts'

/** Reads a file's diff hunks for the loaded comparison, or null when GitHub would not show a text diff either. */
export type HunkSource = (reviewId: string, fileKey: string) => Promise<Array<Hunk> | null>

/**
 * Publishes a local PR review to GitHub as the viewer's pending review. Every write is preceded by a fresh read of
 * GitHub's state, runs one at a time, and is recorded as soon as it succeeds, so retries and restarts never post a
 * comment twice. Nothing becomes visible to others until the user submits the review.
 */
export class Publisher {
	private store: ReviewStore
	private github: GitHubService
	private hunks: HunkSource
	private queue: Promise<unknown> = Promise.resolve()

	constructor(store: ReviewStore, github: GitHubService, hunks: HunkSource) {
		this.store = store
		this.github = github
		this.hunks = hunks
	}

	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const p = this.queue.then(fn, fn)
		this.queue = p.catch(() => {})
		return p
	}

	async plan(repoId: string, reviewId: string): Promise<PublishPlan> {
		const review = this.review(repoId, reviewId)
		const pr = review.pr!
		let state: ReviewState | null = null
		let blocked = null
		try {
			state = await this.reconcile(repoId, reviewId)
		} catch (e) {
			if (!(e instanceof AppFail) || e.code === 'invalid-input') throw e
			blocked = errorOf(e)
		}
		const r = this.review(repoId, reviewId)
		const pub = r.publication
		const pending = state?.pending ?? null
		const ours = !!pending && !!pub?.reviews.some((x) => x.id === pending.id)
		if (pending && pending.commit !== r.headSha && !blocked) {
			blocked = {
				code: 'github-failed' as const,
				message: `You already have a pending review on GitHub for commit ${pending.commit.slice(0, 7)}, but this snapshot is ${r.headSha.slice(0, 7)}. GitHub allows one pending review per pull request, so submit or delete that one on GitHub first, or open the snapshot it belongs to.`,
			}
		}
		const items: Array<PublishItem> = []
		for (const c of r.comments) items.push(await this.item(r, c))
		return {
			pr: { repo: pr.repo, number: pr.number, url: state?.url ?? pr.url, headSha: state?.headSha ?? null, state: pr.state },
			snapshotHead: r.headSha,
			headMoved: !!state && state.headSha !== r.headSha,
			pending: pending
				? { kind: ours ? 'ours' : 'other', url: pending.url, commit: pending.commit, usable: pending.commit === r.headSha }
				: { kind: 'none' },
			blocked,
			items,
			drafts: r.drafts.filter((d) => d.body.trim()).length,
			removed: Object.keys(pub?.comments ?? {}).filter((id) => !r.comments.some((c) => c.id === id)).length,
			submitted: (pub?.reviews ?? []).filter((x) => x.state === 'submitted'),
		}
	}

	publish(repoId: string, reviewId: string, commentId: string, outsideDiff: 'file' | 'skip'): Promise<PublishOutcome> {
		return this.serial(async () => {
			const state = await this.reconcile(repoId, reviewId)
			const r = this.review(repoId, reviewId)
			const c = r.comments.find((x) => x.id === commentId)
			if (!c) throw new AppFail('not-found', 'That comment no longer exists.')
			const item = await this.item(r, c)
			const done = (status: PublishOutcome['status'], message: string | null, url: string | null = item.url): PublishOutcome => ({
				commentId,
				status,
				message,
				url,
			})
			const prev = r.publication?.comments[commentId]
			if (item.status === 'published') return done('skipped', 'Already on GitHub.')
			if (prev) {
				const inPending = state.pending?.comments.some((x) => x.id === prev.githubId)
				if (!inPending) return done('skipped', 'Already submitted on GitHub; edit it there.')
				const u = await this.github.updateComment(prev.githubId, threadFor(item, c, 'file')!.body)
				await this.record(repoId, reviewId, (p) => (p.comments[commentId] = { ...prev, body: c.body, url: u.url, at: now() }))
				return done('updated', null, u.url)
			}
			const thread = threadFor(item, c, outsideDiff)
			if (!thread) return done('skipped', item.placement.kind === 'outside-diff' ? item.placement.reason : null)
			const pending = state.pending
			if (pending && pending.commit !== r.headSha)
				throw new AppFail(
					'github-failed',
					`Your pending review on GitHub is for commit ${pending.commit.slice(0, 7)}, not this snapshot. Submit or delete it on GitHub first.`,
				)
			// A comment sent before a crash, but not recorded, is already in the pending review: adopt it instead of posting it twice.
			const adopted = pending?.comments.find(
				(x) =>
					x.path === thread.path &&
					x.body === thread.body &&
					!Object.values(r.publication?.comments ?? {}).some((p) => p.githubId === x.id),
			)
			let reviewInfo: { id: string; url: string }
			let comment: { id: string; url: string }
			if (adopted && pending) {
				reviewInfo = pending
				comment = adopted
			} else if (pending) {
				reviewInfo = pending
				comment = await this.github.addThread(pending.id, thread)
			} else {
				// Two steps, because addPullRequestReview's inline threads cannot be file-level (they have no subjectType).
				// An empty pending review left by a failure in between is found and reused by the next attempt.
				const res = await this.github.addReview(state.prId, r.headSha)
				reviewInfo = res.review
				await this.record(repoId, reviewId, (p) => {
					if (!p.reviews.some((x) => x.id === reviewInfo.id))
						p.reviews.push({ id: reviewInfo.id, url: reviewInfo.url, commit: r.headSha, state: 'pending', event: null, submittedAt: null })
				})
				comment = await this.github.addThread(reviewInfo.id, thread)
			}
			await this.record(repoId, reviewId, (p) => {
				if (!p.reviews.some((x) => x.id === reviewInfo.id))
					p.reviews.push({ id: reviewInfo.id, url: reviewInfo.url, commit: r.headSha, state: 'pending', event: null, submittedAt: null })
				p.comments[commentId] = { githubId: comment.id, reviewId: reviewInfo.id, url: comment.url, body: c.body, at: now() }
			})
			return done(
				'published',
				thread.subjectType === 'FILE' && item.placement.kind === 'outside-diff' ? 'Posted as a file comment.' : null,
				comment.url,
			)
		})
	}

	submit(repoId: string, reviewId: string, event: ReviewEvent, body: string): Promise<PublishedReview> {
		return this.serial(async () => {
			const state = await this.reconcile(repoId, reviewId)
			const r = this.review(repoId, reviewId)
			const pending = state.pending
			if (pending && pending.commit !== r.headSha)
				throw new AppFail(
					'github-failed',
					`Your pending review on GitHub is for commit ${pending.commit.slice(0, 7)}, not this snapshot. Submit it on GitHub instead.`,
				)
			if (!pending && event !== 'APPROVE' && !body.trim())
				throw new AppFail('invalid-input', 'Write a summary, or publish at least one comment, before submitting.')
			let result: PublishedReview
			if (pending) {
				const s = await this.github.submitReview(pending.id, event, body)
				result = { id: s.id, url: s.url, commit: pending.commit, state: 'submitted', event, submittedAt: s.submittedAt ?? now() }
			} else {
				const s = await this.github.addReview(state.prId, r.headSha, { event, body })
				result = { id: s.review.id, url: s.review.url, commit: r.headSha, state: 'submitted', event, submittedAt: now() }
			}
			await this.record(repoId, reviewId, (p) => {
				const i = p.reviews.findIndex((x) => x.id === result.id)
				if (i >= 0) p.reviews[i] = result
				else p.reviews.push(result)
			})
			return result
		})
	}

	/**
	 * Reads GitHub and brings the local record up to date: reviews submitted or deleted elsewhere, and pending
	 * comments deleted on GitHub (which become publishable again).
	 */
	private async reconcile(repoId: string, reviewId: string): Promise<ReviewState> {
		const r = this.review(repoId, reviewId)
		const pub = r.publication
		const state = await this.github.reviewState(
			r.pr!.repo,
			r.pr!.number,
			(pub?.reviews ?? []).map((x) => x.id),
		)
		if (!pub) return state
		await this.record(repoId, reviewId, (p) => {
			const known = new Map(state.known.map((k) => [k.id, k]))
			p.reviews = p.reviews.flatMap((rv) => {
				const k = known.get(rv.id)
				if (state.pending?.id === rv.id) return [{ ...rv, state: 'pending' as const, url: state.pending.url }]
				if (!k) return [] // deleted on GitHub
				if (k.state === 'PENDING') return [rv]
				return [
					{
						...rv,
						state: 'submitted' as const,
						url: k.url,
						submittedAt: k.submittedAt ?? rv.submittedAt,
						event: rv.event ?? eventOf(k.state),
					},
				]
			})
			const live = new Set(p.reviews.map((x) => x.id))
			const pendingComments = new Set(state.pending?.comments.map((x) => x.id) ?? [])
			for (const [id, c] of Object.entries(p.comments)) {
				if (!live.has(c.reviewId)) delete p.comments[id]
				else if (c.reviewId === state.pending?.id && !pendingComments.has(c.githubId)) delete p.comments[id]
			}
		})
		return state
	}

	private async item(r: Review, c: ReviewComment): Promise<PublishItem> {
		const old = c.carried?.outdated
		const placement: PublishPlacement = old
			? { kind: 'outside-diff', path: c.anchor.newPath ?? c.anchor.oldPath ?? c.anchor.fileKey, reason: `Outdated: ${old.reason}` }
			: placeComment(c.anchor, await this.hunks(r.id, c.anchor.fileKey))
		const prev = r.publication?.comments[c.id]
		// Published from an earlier snapshot: it is already on GitHub, which carries it forward itself.
		const earlier = !prev ? (c.carried?.published ?? null) : null
		const a = old ? c.carried!.anchor : c.anchor
		const range = a.startLine === null ? '' : a.startLine === a.endLine ? `:${a.startLine}` : `:${a.startLine}–${a.endLine}`
		return {
			commentId: c.id,
			fileKey: a.fileKey,
			label: `${a.newPath ?? a.oldPath ?? a.fileKey}${range}${a.side === 'old' ? ' (old)' : ''}`,
			body: c.body,
			status: earlier ? 'published' : !prev ? 'new' : prev.body === c.body ? 'published' : 'changed',
			placement,
			url: prev?.url ?? earlier?.url ?? null,
		}
	}

	private review(repoId: string, reviewId: string): Review {
		const r = this.store.read().repos[repoId]?.reviews[reviewId]
		if (!r) throw new AppFail('not-found', 'That review no longer exists.')
		if (!r.pr) throw new AppFail('invalid-input', 'Only reviews opened from a pull request can be published to GitHub.')
		return r
	}

	private record(repoId: string, reviewId: string, fn: (p: Publication) => void): Promise<void> {
		return this.store.update((d) => {
			const r = d.repos[repoId]?.reviews[reviewId]
			if (!r?.pr) return
			r.publication ??= { repo: r.pr.repo, number: r.pr.number, reviews: [], comments: {} }
			fn(r.publication)
		})
	}
}

function threadFor(item: PublishItem, c: ReviewComment, outsideDiff: 'file' | 'skip'): ThreadInput | null {
	const p = item.placement
	if (p.kind === 'line')
		return {
			body: c.body,
			path: p.path,
			subjectType: 'LINE',
			side: p.side,
			line: p.line,
			...(p.startLine !== null ? { startLine: p.startLine, startSide: p.side } : {}),
		}
	if (p.kind === 'file') return { body: c.body, path: p.path, subjectType: 'FILE' }
	if (outsideDiff === 'skip') return null
	// Keep the reference to the lines the comment was about, since GitHub can only attach it to the file.
	const a = c.carried?.outdated ? c.carried.anchor : c.anchor
	if (a.startLine === null) return { body: c.body, path: p.path, subjectType: 'FILE' }
	const where = a.startLine === a.endLine ? `line ${a.startLine}` : `lines ${a.startLine}–${a.endLine}`
	const when = c.carried?.outdated ? ` at ${a.headSha.slice(0, 7)}` : ''
	return { body: `**${where}${a.side === 'old' ? ' (before the change)' : ''}${when}:** ${c.body}`, path: p.path, subjectType: 'FILE' }
}

function eventOf(state: string): ReviewEvent | null {
	return state === 'APPROVED' ? 'APPROVE' : state === 'CHANGES_REQUESTED' ? 'REQUEST_CHANGES' : state === 'COMMENTED' ? 'COMMENT' : null
}

function now(): string {
	return new Date().toISOString()
}
