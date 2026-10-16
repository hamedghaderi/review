import { findingRoots, findingState } from '../shared/findings.ts'
import { watchKey } from '../shared/inbox.ts'
import type {
	AiRun,
	AutoReviewRecord,
	Comparison,
	Finding,
	FindingLevel,
	PublishOutcome,
	PublishPlan,
	PublishedReview,
	Review,
	ReviewerChoice,
	ReviewEvent,
} from '../shared/types.ts'
import { AppFail } from './git.ts'
import type { RepoEvent } from './inboxWatch.ts'
import type { ReviewStore } from './store.ts'

/** Levels that stand in the way of an approval, whether or not they were posted. */
const CONCERNS: ReadonlyArray<string> = ['blocking', 'should_fix', 'question']

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * What an automatic review submits. Request changes when a blocking finding stands (not dismissed, not held back and
 * not shown likely wrong by the double-check); approve only when every file was reviewed, nothing was posted and no
 * blocking, should-fix or question finding is left; otherwise comment. Dismissed findings never count.
 */
export function autoVerdict(
	run: AiRun,
	review: Review,
	runs: Array<AiRun>,
	posted: number,
	who: { reviewer: string; viewer: string | null },
): { event: ReviewEvent; body: string } {
	const roots = findingRoots(runs)
	const byId = new Map(runs.flatMap((r) => r.findings.map((f) => [f.id, f] as const)))
	const state = (f: Finding) => findingState(review, roots, f, byId)
	const live = run.findings.filter((f) => !f.mergedInto && state(f) !== 'dismissed')
	const doubted = (f: Finding): boolean => f.verification?.verdict === 'wrong' && !f.verification.error
	const blocking = live.filter((f) => f.severity === 'blocking' && !f.heldBack && !doubted(f))
	const concerns = live.filter((f) => CONCERNS.includes(f.severity))
	const unposted = concerns.filter((f) => state(f) === 'open').length
	const complete = run.status === 'completed'
	const event: ReviewEvent = blocking.length ? 'REQUEST_CHANGES' : concerns.length || posted || !complete ? 'COMMENT' : 'APPROVE'
	const lines = [
		`🤖 This review was written and submitted automatically by AI (${who.reviewer}, in the Review app)${who.viewer ? ` on behalf of ${who.viewer}` : ''}.`,
	]
	if (event === 'APPROVE') lines.push('It found no blocking, should-fix or question findings in the changed files.')
	else {
		const parts: Array<string> = []
		if (blocking.length) parts.push(`${plural(blocking.length, 'blocking finding')}.`)
		if (posted) parts.push(`${plural(posted, 'comment')} below.`)
		if (unposted) parts.push(`${plural(unposted, 'finding')} not posted, left for a person to check.`)
		if (!complete) parts.push('Some files were not reviewed, so this is not an approval.')
		lines.push(parts.join(' '))
	}
	return { event, body: lines.join('\n\n') }
}

export interface AutoReviewDeps {
	store: ReviewStore
	enabled(): boolean
	viewer(): string | null
	/** The model or team the next run uses, as picked in the AI settings, with a name for the review body. */
	reviewer(): { choice: ReviewerChoice; label: string }
	levels(): ReadonlyArray<FindingLevel>
	busy(): boolean
	runsFor(repoId: string, reviewId: string): Array<AiRun>
	whenDone(runId: string): Promise<AiRun> | null
	open(repoId: string, pr: { repo: string; number: number }, signal: AbortSignal): Promise<Comparison>
	start(reviewId: string, choice: ReviewerChoice, label: string): Promise<AiRun>
	addFindings(repoId: string, reviewId: string, runId: string, levels: ReadonlyArray<FindingLevel>): Promise<Array<string>>
	plan(repoId: string, reviewId: string): Promise<PublishPlan>
	publish(repoId: string, reviewId: string, commentId: string, outsideDiff: 'file' | 'skip'): Promise<PublishOutcome>
	submit(repoId: string, reviewId: string, event: ReviewEvent, body: string): Promise<PublishedReview>
	/** The automatic review added comments to a stored review, so a window showing it can load them. */
	reviewChanged(repoId: string, reviewId: string): void
	/** It finished (posted, skipped or failed); tell the user. */
	finished(event: RepoEvent, record: AutoReviewRecord): void
	waitMs?: number
}

const OUTCOME: Record<ReviewEvent, AutoReviewRecord['outcome']> = {
	APPROVE: 'approved',
	REQUEST_CHANGES: 'changes-requested',
	COMMENT: 'commented',
}

/**
 * Reviews new review requests with AI and submits the result on GitHub as you, when automatic review is turned on.
 * One pull request at a time, after any AI review you are running. Each head commit is reviewed at most once. It never
 * posts into a pending review of yours, since submitting would send your comments too.
 */
export class AutoReviewer {
	private d: AutoReviewDeps
	private queue: Promise<void> = Promise.resolve()
	private queued = new Set<string>()

	constructor(deps: AutoReviewDeps) {
		this.d = deps
	}

	/** Takes the watcher's events; new requests, requests after an earlier review, and drafts marked ready are reviewed. */
	take(events: Array<RepoEvent>): void {
		if (!this.d.enabled()) return
		const viewer = this.d.viewer()?.toLowerCase() ?? null
		for (const e of events) {
			if (e.kind === 'updated' || e.pr.draft) continue
			if (viewer && e.pr.author?.toLowerCase() === viewer) continue
			const key = watchKey(e.pr)
			const id = `${key}@${e.pr.head ?? ''}`
			if (this.queued.has(id) || (e.pr.head && this.d.store.read().autoReviews?.[key]?.head === e.pr.head)) continue
			this.queued.add(id)
			this.queue = this.queue.then(() => this.review(e).finally(() => this.queued.delete(id)))
		}
	}

	/** Resolves once everything queued so far is done (for tests and shutdown). */
	idle(): Promise<void> {
		return this.queue
	}

	private async review(e: RepoEvent): Promise<void> {
		const key = watchKey(e.pr)
		const label = `${e.pr.repo}#${e.pr.number}`
		let reviewId: string | null = null
		let head = e.pr.head ?? ''
		let posted = 0
		const record = async (outcome: AutoReviewRecord['outcome'], message: string, url: string | null = null): Promise<void> => {
			const r: AutoReviewRecord = { head, at: new Date().toISOString(), reviewId, outcome, message, url }
			await this.d.store.update((s) => void ((s.autoReviews ??= {})[key] = r))
			this.d.finished(e, r)
		}
		try {
			if (!(await this.turn())) return
			const c = await this.d.open(e.repoId, e.pr, AbortSignal.timeout(5 * 60_000))
			reviewId = c.id
			head = c.headSha
			if (this.d.store.read().autoReviews?.[key]?.head === head) return
			const plan = await this.d.plan(e.repoId, c.id)
			if (plan.blocked) return record('skipped', `Not reviewed automatically: ${plan.blocked.message}`)
			if (plan.pr.state !== 'open') return record('skipped', `Not reviewed automatically: ${label} is ${plan.pr.state}.`)
			if (plan.pending.kind !== 'none')
				return record(
					'skipped',
					`Not reviewed automatically: you have a pending review on ${label} on GitHub, and submitting would send your comments too.`,
				)
			const { choice, label: reviewer } = this.d.reviewer()
			let run: AiRun | null = null
			while (!run) {
				if (!(await this.turn())) return
				try {
					run = await this.d.start(c.id, choice, label)
				} catch (err) {
					// Someone started a run between the check and the start: wait for it.
					if (!(err instanceof AppFail && err.code === 'ai-busy')) throw err
				}
			}
			await this.d.whenDone(run.id)
			const final = this.d.runsFor(e.repoId, c.id).find((r) => r.id === run.id) ?? run
			if (final.status !== 'completed' && final.status !== 'partial') {
				const why = final.status === 'cancelled' ? 'it was cancelled' : (final.errors[0] ?? 'the AI review failed')
				return record('failed', `Automatic review of ${label} did not finish: ${why}. Nothing was posted.`)
			}
			if (!this.d.enabled())
				return record('skipped', `Automatic review was turned off before posting. The findings for ${label} are in the app.`)
			const ids = await this.d.addFindings(e.repoId, c.id, final.id, this.d.levels())
			if (ids.length) this.d.reviewChanged(e.repoId, c.id)
			for (const id of ids) {
				const out = await this.d.publish(e.repoId, c.id, id, 'file')
				if (out.status === 'published' || out.status === 'updated') posted++
			}
			const stored = this.d.store.read().repos[e.repoId]?.reviews[c.id]
			if (!stored) throw new AppFail('not-found', 'The review was removed while it was being posted.')
			const verdict = autoVerdict(final, stored, this.d.runsFor(e.repoId, c.id), posted, { reviewer, viewer: this.d.viewer() })
			const done = await this.d.submit(e.repoId, c.id, verdict.event, verdict.body)
			const said =
				verdict.event === 'APPROVE'
					? 'Approved'
					: verdict.event === 'REQUEST_CHANGES'
						? `Requested changes with ${plural(posted, 'comment')}`
						: `Commented${posted ? ` with ${plural(posted, 'comment')}` : ''}`
			await record(OUTCOME[verdict.event], `${said} on ${label}, automatically.`, done.url)
		} catch (err) {
			const why = err instanceof Error ? err.message : String(err)
			const sent = posted
				? ` ${plural(posted, 'comment')} already sent ${posted === 1 ? 'is' : 'are'} in your pending review on GitHub; submit or delete it there.`
				: ''
			await record('failed', `Automatic review of ${label} failed: ${why}${sent}`).catch(() => {})
		}
	}

	/** Waits until no AI review is running. False when automatic review was turned off meanwhile. */
	private async turn(): Promise<boolean> {
		while (this.d.busy()) {
			if (!this.d.enabled()) return false
			await new Promise((r) => setTimeout(r, this.d.waitMs ?? 30_000))
		}
		return this.d.enabled()
	}
}
