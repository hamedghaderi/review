import { findingRoots, findingState } from '../shared/findings.ts'
import { screenFinding } from '../shared/screen.ts'
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
import type { HeadChecks } from '../shared/ci.ts'
import { AppFail } from './git.ts'
import type { RepoEvent } from './inboxWatch.ts'
import type { ReviewStore } from './store.ts'

/** Levels that stand in the way of an approval, whether or not they were posted. */
const CONCERNS: ReadonlyArray<string> = ['blocking', 'should_fix', 'question']

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * What an automatic review submits. Request changes when a blocking finding stands (not dismissed, not held back and
 * not shown likely wrong by the double-check); approve only when every file was reviewed, nothing was posted, no
 * blocking, should-fix or question finding is left, and CI for the head commit finished without a failure (`ci` null:
 * it couldn't be read); otherwise comment. Dismissed findings never count. A finding whose text a person should read
 * first (see screenFinding) is never posted; it rules out an approval but doesn't request changes, since its text may
 * be what someone steered the AI into writing. `ciStopped` says when CI alone stood in the way of an approval, so the
 * caller can wait for checks that haven't finished.
 */
export function autoVerdict(
	run: AiRun,
	review: Review,
	runs: Array<AiRun>,
	posted: number,
	who: { reviewer: string; viewer: string | null },
	ci: HeadChecks | null,
): { event: ReviewEvent; body: string; ciStopped: 'failed' | 'pending' | 'unreadable' | null } {
	const roots = findingRoots(runs)
	const byId = new Map(runs.flatMap((r) => r.findings.map((f) => [f.id, f] as const)))
	const state = (f: Finding) => findingState(review, roots, f, byId)
	const live = run.findings.filter((f) => !f.mergedInto && state(f) !== 'dismissed')
	const doubted = (f: Finding): boolean => f.verification?.verdict === 'wrong' && !f.verification.error
	const repo = review.pr?.repo ?? null
	const screened = new Set(live.filter((f) => state(f) === 'open' && !f.heldBack && screenFinding(f, repo).length).map((f) => f.id))
	const blocking = live.filter((f) => f.severity === 'blocking' && !f.heldBack && !doubted(f) && !screened.has(f.id))
	const concerns = live.filter((f) => CONCERNS.includes(f.severity))
	const unposted = concerns.filter((f) => state(f) === 'open' && !screened.has(f.id)).length
	const complete = run.status === 'completed'
	const findingsAllow = !blocking.length && !concerns.length && !screened.size && !posted && complete
	const ciStopped = !findingsAllow ? null : !ci ? 'unreadable' : ci.failed.length ? 'failed' : ci.pending.length ? 'pending' : null
	const event: ReviewEvent = blocking.length ? 'REQUEST_CHANGES' : findingsAllow && !ciStopped ? 'APPROVE' : 'COMMENT'
	const lines = [
		`🤖 This review was written and submitted automatically by AI (${who.reviewer}, in the Review app)${who.viewer ? ` on behalf of ${who.viewer}` : ''}.`,
	]
	if (event === 'APPROVE') lines.push('It found no blocking, should-fix or question findings in the changed files.')
	else {
		const parts: Array<string> = []
		if (blocking.length) parts.push(`${plural(blocking.length, 'blocking finding')}.`)
		if (posted) parts.push(`${plural(posted, 'comment')} below.`)
		if (unposted) parts.push(`${plural(unposted, 'finding')} not posted, left for a person to check.`)
		if (screened.size)
			parts.push(
				`${plural(screened.size, 'finding')} not posted because ${screened.size === 1 ? 'its' : 'their'} text needs a person to read it first, so this is not an approval.`,
			)
		if (!complete) parts.push('Some files were not reviewed, so this is not an approval.')
		if (ci?.failed.length) {
			const more = ci.failed.length > 1 ? ` and ${ci.failed.length - 1} more` : ''
			parts.push(`CI failed on this commit (${ci.failed[0].name}${more}), so this is not an approval.`)
		} else if (ciStopped === 'pending') parts.push('CI had not finished on this commit, so this is not an approval.')
		else if (ciStopped === 'unreadable') parts.push('CI for this commit could not be read, so this is not an approval.')
		if (findingsAllow) parts.unshift('It found no blocking, should-fix or question findings in the changed files.')
		lines.push(parts.join(' '))
	}
	return { event, body: lines.join('\n\n'), ciStopped }
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
	/** CI for the snapshot's head commit, as GitHub reports it now. */
	checks(repoId: string, reviewId: string): Promise<HeadChecks>
	/** The automatic review added comments to a stored review, so a window showing it can load them. */
	reviewChanged(repoId: string, reviewId: string): void
	/** It finished (posted, skipped or failed); tell the user. */
	finished(event: RepoEvent, record: AutoReviewRecord): void
	waitMs?: number
	ciPollMs?: number // how often unfinished CI is read again before approving (default 1 minute)
	ciWaitMs?: number // how long to wait for it (default 20 minutes)
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
			const who = { reviewer, viewer: this.d.viewer() }
			const readCi = () => this.d.checks(e.repoId, c.id).catch(() => null)
			let verdict = autoVerdict(final, stored, this.d.runsFor(e.repoId, c.id), posted, who, await readCi())
			// Nothing but unfinished CI stands in the way of an approval: wait for it, then decide.
			const until = Date.now() + (this.d.ciWaitMs ?? 20 * 60_000)
			while (verdict.ciStopped === 'pending' && Date.now() < until) {
				await new Promise((r) => setTimeout(r, this.d.ciPollMs ?? 60_000))
				if (!this.d.enabled())
					return record('skipped', `Automatic review was turned off while waiting for CI. The findings for ${label} are in the app.`)
				verdict = autoVerdict(final, stored, this.d.runsFor(e.repoId, c.id), posted, who, await readCi())
			}
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
