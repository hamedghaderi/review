import type {
	Hunk,
	Publication,
	PublishedComment,
	PublishedReview,
	PublishItem,
	PublishOutcome,
	PublishPlacement,
	PublishPlan,
	Review,
	ReviewComment,
	ReviewEvent,
} from '../shared/types.ts'
import { PUBLISH_BATCH } from '../shared/types.ts'
import { AppFail } from './git.ts'
import { errorOf, type GitHubService, type ReviewState, type ReviewWrite, type ThreadInput } from './github.ts'
import { placeComment } from './placement.ts'
import type { ReviewStore } from './store.ts'

/** Reads a file's diff hunks for the loaded comparison, or null when GitHub would not show a text diff either. */
export type HunkSource = (reviewId: string, fileKey: string) => Promise<Array<Hunk> | null>

/** Errors that would fail every other comment the same way: publishing stops on them instead of trying the rest. */
const FATAL = new Set(['github-auth', 'github-forbidden', 'github-rate-limited', 'github-not-found', 'invalid-input'])

/** An outcome, and whether the comment is worth sending again (its whole request failed, not GitHub's answer to it). */
type Attempted = PublishOutcome & { retry: boolean }

/**
 * Publishes a local PR review to GitHub as the viewer's pending review. Every round of writes is preceded by a fresh
 * read of GitHub's state, runs one at a time, and is recorded as soon as it succeeds, so retries and restarts never post
 * a comment twice. Nothing becomes visible to others until the user submits the review.
 */
export class Publisher {
	private store: ReviewStore
	private github: GitHubService
	private hunks: HunkSource
	private queue: Promise<unknown> = Promise.resolve()
	private retryMs: number

	constructor(store: ReviewStore, github: GitHubService, hunks: HunkSource, opts: { retryMs?: number } = {}) {
		this.store = store
		this.github = github
		this.hunks = hunks
		this.retryMs = opts.retryMs ?? 2000
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
		// A comment from a finding that read MCP tools may quote what they returned (issue #159): say which.
		const findings = new Map(
			(this.store.read().repos[repoId]?.aiRuns?.[reviewId] ?? []).flatMap((run) => run.findings.map((f) => [f.id, f] as const)),
		)
		for (const c of r.comments) {
			const item = await this.item(r, c)
			const external = c.findingId ? findings.get(c.findingId)?.external : undefined
			items.push(external?.length ? { ...item, external } : item)
		}
		return {
			pr: {
				repo: pr.repo,
				number: pr.number,
				url: state?.url ?? pr.url,
				headSha: state?.headSha ?? null,
				state: pr.state,
				autoMerge: state?.autoMerge ?? null,
				private: pr.private ?? null,
			},
			snapshotHead: r.headSha,
			headMoved: !!state && state.headSha !== r.headSha,
			pending: pending
				? {
						kind: ours ? 'ours' : 'other',
						url: pending.url,
						commit: pending.commit,
						usable: pending.commit === r.headSha,
						comments: pending.comments.length,
					}
				: { kind: 'none' },
			blocked,
			items,
			drafts: r.drafts.filter((d) => d.body.trim()).length,
			removed: Object.keys(pub?.comments ?? {}).filter((id) => !r.comments.some((c) => c.id === id)).length,
			submitted: (pub?.reviews ?? []).filter((x) => x.state === 'submitted'),
		}
	}

	/**
	 * Sends these comments to your pending review, creating it first if needed. GitHub's state is read once for the lot
	 * and the comments go in batches (see reviewWrites), each recorded as soon as GitHub answers. A batch whose request
	 * failed as a whole (the network, a GitHub error) is tried once more after a short wait, starting again from a fresh
	 * read, so a comment that did get through is adopted rather than posted twice. Errors that would fail every comment
	 * the same way (access, rate limit) are thrown.
	 */
	publish(
		repoId: string,
		reviewId: string,
		commentIds: ReadonlyArray<string>,
		outsideDiff: 'file' | 'skip',
	): Promise<Array<PublishOutcome>> {
		return this.serial(async () => {
			const first = await this.attempt(repoId, reviewId, commentIds, outsideDiff)
			const again = first.filter((o) => o.retry).map((o) => o.commentId)
			let second = new Map<string, Attempted>()
			if (again.length) {
				await new Promise((r) => setTimeout(r, this.retryMs))
				second = new Map((await this.attempt(repoId, reviewId, again, outsideDiff)).map((o) => [o.commentId, o]))
			}
			return first.map((o) => {
				const { retry: _, ...out } = second.get(o.commentId) ?? o
				return out
			})
		})
	}

	private async attempt(
		repoId: string,
		reviewId: string,
		commentIds: ReadonlyArray<string>,
		outsideDiff: 'file' | 'skip',
	): Promise<Array<Attempted>> {
		const state = await this.reconcile(repoId, reviewId)
		const r = this.review(repoId, reviewId)
		const out = new Map<string, Attempted>()
		const done = (commentId: string, status: PublishOutcome['status'], message: string | null, url: string | null, retry = false) =>
			out.set(commentId, { commentId, status, message, url, retry })
		const pending = state.pending
		// Pending comments already recorded, or adopted below, aren't adopted again.
		const claimed = new Set(Object.values(r.publication?.comments ?? {}).map((p) => p.githubId))
		const adopted: Array<{ commentId: string; githubId: string; url: string; body: string }> = []
		const sends: Array<{ c: ReviewComment; write: 'thread' | 'update'; thread: ThreadInput; prev?: PublishedComment; file: boolean }> = []
		for (const commentId of commentIds) {
			const c = r.comments.find((x) => x.id === commentId)
			if (!c) {
				done(commentId, 'failed', 'That comment no longer exists.', null)
				continue
			}
			const item = await this.item(r, c)
			const prev = r.publication?.comments[commentId]
			if (item.status === 'published') {
				done(commentId, 'skipped', 'Already on GitHub.', item.url)
				continue
			}
			if (prev) {
				const inPending = state.pending?.comments.some((x) => x.id === prev.githubId)
				if (!inPending) done(commentId, 'skipped', 'Already submitted on GitHub; edit it there.', item.url)
				else sends.push({ c, write: 'update', thread: threadFor(item, c, 'file')!, prev, file: false })
				continue
			}
			const thread = threadFor(item, c, outsideDiff)
			if (!thread) {
				done(commentId, 'skipped', item.placement.kind === 'outside-diff' ? item.placement.reason : null, item.url)
				continue
			}
			if (pending && pending.commit !== r.headSha)
				throw new AppFail(
					'github-failed',
					`Your pending review on GitHub is for commit ${pending.commit.slice(0, 7)}, not this snapshot. Submit or delete it on GitHub first.`,
				)
			// A comment sent before a crash, but not recorded, is already in the pending review: adopt it instead of posting it twice.
			const found = pending?.comments.find((x) => x.path === thread.path && x.body === thread.body && !claimed.has(x.id))
			if (found) {
				claimed.add(found.id)
				adopted.push({ commentId, githubId: found.id, url: found.url, body: c.body })
				done(commentId, 'published', null, found.url)
				continue
			}
			sends.push({ c, write: 'thread', thread, file: thread.subjectType === 'FILE' && item.placement.kind === 'outside-diff' })
		}

		let reviewInfo: { id: string; url: string } | null = pending
		const ensureReview = (p: Publication, info: { id: string; url: string }): void => {
			if (!p.reviews.some((x) => x.id === info.id))
				p.reviews.push({ id: info.id, url: info.url, commit: r.headSha, state: 'pending', event: null, submittedAt: null })
		}
		if (adopted.length && pending)
			await this.record(repoId, reviewId, (p) => {
				ensureReview(p, pending)
				for (const a of adopted)
					p.comments[a.commentId] = { githubId: a.githubId, reviewId: pending.id, url: a.url, body: a.body, at: now() }
			})

		// A failure that would fail the rest the same way is thrown; any other leaves these comments to try again.
		const failAll = (list: typeof sends, e: unknown): void => {
			if (!(e instanceof AppFail) || FATAL.has(e.code)) throw e
			for (const s of list) done(s.c.id, 'failed', e.message, null, true)
		}
		if (!reviewInfo && sends.some((s) => s.write === 'thread')) {
			// Two steps, because addPullRequestReview's inline threads cannot be file-level (they have no subjectType).
			// An empty pending review left by a failure in between is found and reused by the next attempt.
			try {
				const info = (await this.github.addReview(state.prId, r.headSha)).review
				await this.record(repoId, reviewId, (p) => ensureReview(p, info))
				reviewInfo = info
			} catch (e) {
				failAll(
					sends.filter((s) => s.write === 'thread'),
					e,
				)
			}
		}
		const ready = sends.filter((s) => s.write === 'update' || reviewInfo)
		for (let i = 0; i < ready.length; i += PUBLISH_BATCH) {
			const batch = ready.slice(i, i + PUBLISH_BATCH)
			let results: Array<{ id: string; url: string } | AppFail>
			try {
				results = await this.github.reviewWrites(
					batch.map((s): ReviewWrite =>
						s.write === 'update'
							? { kind: 'update', commentId: s.prev!.githubId, body: s.thread.body }
							: { kind: 'thread', reviewId: reviewInfo!.id, thread: s.thread },
					),
				)
			} catch (e) {
				failAll(batch, e)
				continue
			}
			await this.record(repoId, reviewId, (p) => {
				batch.forEach((s, j) => {
					const res = results[j]
					if (res instanceof AppFail) return
					if (s.write === 'update') p.comments[s.c.id] = { ...s.prev!, body: s.c.body, url: res.url, at: now() }
					else {
						ensureReview(p, reviewInfo!)
						p.comments[s.c.id] = { githubId: res.id, reviewId: reviewInfo!.id, url: res.url, body: s.c.body, at: now() }
					}
				})
			})
			batch.forEach((s, j) => {
				const res = results[j]
				if (res instanceof AppFail) done(s.c.id, 'failed', res.message, null)
				else if (s.write === 'update') done(s.c.id, 'updated', null, res.url)
				else done(s.c.id, 'published', s.file ? 'Posted as a file comment.' : null, res.url)
			})
			const fatal = results.find((x): x is AppFail => x instanceof AppFail && FATAL.has(x.code))
			if (fatal) throw fatal
		}
		return commentIds.map((id) => out.get(id)!)
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
			// A review an automatic review prepared is done once you submit one.
			await this.store.update((d) => {
				const stored = d.repos[repoId]?.reviews[reviewId]
				if (stored?.prepared) stored.prepared = null
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
		const path = c.anchor.newPath ?? c.anchor.oldPath ?? c.anchor.fileKey
		const placement: PublishPlacement = old
			? { kind: 'outside-diff', path, reason: `Outdated: ${old.reason}` }
			: r.stackedOn && c.anchor.side === 'old'
				? {
						kind: 'outside-diff',
						path,
						reason: `GitHub’s diff of this pull request starts before #${r.stackedOn.number}, so lines of #${r.stackedOn.number}’s last commit have no place on its left side.`,
					}
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
