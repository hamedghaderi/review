import { findingRoots, findingState, preparedLine } from '../shared/findings.ts'
import { publicRepo, screenFinding } from '../shared/screen.ts'
import { watchKey } from '../shared/inbox.ts'
import { hasWriteRole } from '../shared/trust.ts'
import type {
	BotThreadCheck,
	PreparedReview,
	Discussion,
	DiscussionReview,
	AiRun,
	AutoReviewRecord,
	Comparison,
	Finding,
	FindingLevel,
	PrAutoMerge,
	PublishOutcome,
	PublishPlan,
	PublishedReview,
	Review,
	ReviewerChoice,
	ReviewEvent,
} from '../shared/types.ts'
import { baseLabel, type HeadChecks } from '../shared/ci.ts'
import { AppFail } from './git.ts'
import type { RepoEvent } from './inboxWatch.ts'
import type { ReviewStore } from './store.ts'

/** Levels that stand in the way of an approval, whether or not they were posted. */
const CONCERNS: ReadonlyArray<string> = ['blocking', 'should_fix', 'question']

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const paused = (label: string, why: string): string => `Automatic review of ${label} is paused: ${why} It starts once the budget allows.`

/**
 * What an automatic review submits. Request changes when a blocking finding stands (not dismissed, not held back and
 * not shown likely wrong by the double-check); approve only when every file was reviewed, nothing was posted, no
 * blocking, should-fix or question finding is left, and CI for the head commit finished without a failure (`ci` null:
 * it couldn't be read); otherwise comment. Dismissed findings never count. A finding whose text a person should read
 * first (see screenFinding) is never posted; it rules out an approval but doesn't request changes, since its text may
 * be what someone steered the AI into writing. `ciStopped` says when CI alone stood in the way of an approval, so the
 * caller can wait for checks that haven't finished. `pr` is the pull request as GitHub reports it just before submitting
 * (left out while waiting for CI). An approval only covers the commit reviewed (`head` null: it couldn't be read), and
 * GitHub keeps an approval on new commits unless the repository dismisses stale ones. With auto-merge on or a place in
 * the merge queue, an approval could merge the pull request without a person, so it is never given automatically. With
 * other reviewers' concerns still open (see othersConcerns; null: the discussion couldn't be read), it isn't either: an
 * approval in your name next to a colleague's unanswered change request reads as overruling them unread.
 */
export function autoVerdict(
	run: AiRun,
	review: Review,
	runs: Array<AiRun>,
	posted: number,
	who: { reviewer: string; viewer: string | null; prepared?: boolean }, // prepared: you submit it (Prepare mode)
	ci: HeadChecks | null,
	pr?: { head: string | null; autoMerge: PrAutoMerge | null; others?: OthersConcerns | null },
): { event: ReviewEvent; body: string; ciStopped: 'failed' | 'pending' | 'unreadable' | null } {
	const roots = findingRoots(runs)
	const byId = new Map(runs.flatMap((r) => r.findings.map((f) => [f.id, f] as const)))
	const state = (f: Finding) => findingState(review, roots, f, byId)
	const live = run.findings.filter((f) => !f.mergedInto && state(f) !== 'dismissed')
	const doubted = (f: Finding): boolean => f.verification?.verdict === 'wrong' && !f.verification.error
	const repo = review.pr?.repo ?? null
	const screened = new Set(
		live.filter((f) => state(f) === 'open' && !f.heldBack && screenFinding(f, repo, publicRepo(review.pr)).length).map((f) => f.id),
	)
	const blocking = live.filter((f) => f.severity === 'blocking' && !f.heldBack && !doubted(f) && !screened.has(f.id))
	const concerns = live.filter((f) => CONCERNS.includes(f.severity))
	const unposted = concerns.filter((f) => state(f) === 'open' && !screened.has(f.id)).length
	const complete = run.status === 'completed'
	const findingsAllow = !blocking.length && !concerns.length && !screened.size && !posted && complete
	const ciStopped = !findingsAllow ? null : !ci ? 'unreadable' : ci.failed.length ? 'failed' : ci.pending.length ? 'pending' : null
	const moved = !!pr && pr.head !== run.headSha
	const merges = pr?.autoMerge ?? null
	const others = pr && pr.others !== undefined ? pr.others : undefined
	const held = others === null || !!(others && (others.changes.length || others.threads.length || others.bots.length))
	const event: ReviewEvent = blocking.length
		? 'REQUEST_CHANGES'
		: findingsAllow && !ciStopped && !moved && !merges && !held
			? 'APPROVE'
			: 'COMMENT'
	const lines = [
		who.prepared
			? `🤖 This review was written by AI (${who.reviewer}, in the Review app)${who.viewer ? ` and submitted by ${who.viewer}` : ''}.`
			: `🤖 This review was written and submitted automatically by AI (${who.reviewer}, in the Review app)${who.viewer ? ` on behalf of ${who.viewer}` : ''}.`,
	]
	if (run.carriedFrom) {
		const carried = run.coverage.files.filter((f) => f.state === 'carried').length
		lines.push(
			`It reviewed the commits since ${run.carriedFrom.headSha.slice(0, 7)}: only the files whose changes differ since then. ${plural(carried, 'file')} and ${carried === 1 ? 'its' : 'their'} findings carry over from the review of ${run.carriedFrom.headSha.slice(0, 7)}, and are not posted again.`,
		)
	}
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
			// A failure the base has too still stops an approval, but the author should know it isn't theirs.
			const old = ci.base ? ci.failed.filter((f) => f.atBase === 'fails').length : 0
			const also = !old
				? ''
				: old === ci.failed.length
					? ` ${old === 1 ? 'It also fails' : 'They all also fail'} at ${baseLabel(ci.base!)}, so this change didn't cause ${old === 1 ? 'it' : 'them'}.`
					: ` ${plural(old, 'of them also fails', 'of them also fail')} at ${baseLabel(ci.base!)}.`
			parts.push(`CI failed on this commit (${ci.failed[0].name}${more}), so this is not an approval.${also}`)
		} else if (ciStopped === 'pending') parts.push('CI had not finished on this commit, so this is not an approval.')
		else if (ciStopped === 'unreadable') parts.push('CI for this commit could not be read, so this is not an approval.')
		else if (findingsAllow && moved)
			parts.push(
				pr!.head
					? `It reviewed ${run.headSha.slice(0, 7)}, and newer commits (up to ${pr!.head.slice(0, 7)}) were pushed since, so this is not an approval.`
					: `The pull request's latest commit could not be read before submitting, so this is not an approval of ${run.headSha.slice(0, 7)}.`,
			)
		else if (findingsAllow && merges)
			parts.push(
				`${merges === 'merge-queue' ? 'It is in the merge queue' : 'Auto-merge is on'}, so an approval could merge it without a person checking first. This is not an approval${who.viewer ? `; ${who.viewer} can approve it` : ''}.`,
			)
		else if (findingsAllow && held) parts.push(othersLine(others ?? null))
		if (findingsAllow) parts.unshift('It found no blocking, should-fix or question findings in the changed files.')
		lines.push(parts.join(' '))
	}
	return { event, body: lines.join('\n\n'), ciStopped }
}

/**
 * What others raised on the pull request that still stands, by people with write access only (an outsider's comment
 * can't hold an approval back, or anyone could steer an automatic review): a change request they haven't replaced, a
 * thread they started that is open, current and unanswered by the pull request's author, and a bot's comment the
 * double-check could not disprove (see BotThreadCheck). Never the viewer's or the author's own, never a bot's role.
 */
export interface OthersConcerns {
	changes: Array<{ login: string; at: string | null; url: string | null }>
	threads: Array<{ login: string; path: string; url: string | null }>
	bots: Array<{ bot: string; path: string; url: string | null }>
}

export function othersConcerns(
	d: Discussion,
	o: { viewer: string | null; author: string | null; botChecks: ReadonlyArray<BotThreadCheck> },
): OthersConcerns {
	const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase()
	const counts = (login: string | null, association: string | null | undefined, bot?: boolean): login is string =>
		!!login && !bot && hasWriteRole(association) && !same(login, o.viewer) && !same(login, o.author)
	// A standing change request: someone's newest approve, request-changes or dismissal, as GitHub keeps them.
	const standing = new Map<string, DiscussionReview>()
	for (const r of [...d.reviews].sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? '')))
		if (r.author && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) standing.set(r.author.toLowerCase(), r)
	const changes = [...standing.values()]
		.filter((r) => r.state === 'CHANGES_REQUESTED' && counts(r.author, r.association, r.bot))
		.map((r) => ({ login: r.author!, at: r.submittedAt, url: r.url }))
	const live = d.threads.filter((t) => t.resolved !== true && !t.outdated)
	const threads = live
		.filter((t) => {
			const [root, ...replies] = t.comments
			return !!root && counts(root.author, root.association, root.bot) && !replies.some((c) => same(c.author, o.author))
		})
		.map((t) => ({ login: t.comments[0].author!, path: t.path, url: t.url }))
	const bots = live.flatMap((t) => {
		const check = o.botChecks.find((c) => c.threadId === t.id)
		return check && check.verdict === 'holds' && !check.error ? [{ bot: check.bot ?? 'a bot', path: t.path, url: t.url }] : []
	})
	return { changes, threads, bots }
}

/** Why it isn't an approval, naming people without @ so the review doesn't notify them. */
function othersLine(o: OthersConcerns | null): string {
	if (!o) return "The other reviewers' threads could not be read, so this is not an approval."
	const parts = [
		...o.changes.map((c) => `${c.login} requested changes${c.at ? ` (${c.at.slice(0, 10)})` : ''}`),
		o.threads.length
			? `${plural(o.threads.length, 'thread')} from ${[...new Set(o.threads.map((t) => t.login))].join(', ')} ${o.threads.length === 1 ? 'is' : 'are'} unanswered`
			: null,
		o.bots.length
			? `${plural(o.bots.length, 'bot comment')} (${o.bots.map((b) => `${b.bot} on ${b.path}`).join(', ')}) could not be disproved`
			: null,
	].filter(Boolean)
	return `Not an approval while others' concerns are open: ${parts.join('; ')}.`
}

export interface AutoReviewDeps {
	store: ReviewStore
	enabled(): boolean
	/** New commits on a pull request it reviewed are reviewed too (only matters while `enabled`). */
	commits(): boolean
	viewer(): string | null
	/** The model or team the next run uses, as picked in the AI settings, with a name for the review body. */
	reviewer(): { choice: ReviewerChoice; label: string }
	levels(): ReadonlyArray<FindingLevel>
	busy(): boolean
	runsFor(repoId: string, reviewId: string): Array<AiRun>
	whenDone(runId: string): Promise<AiRun> | null
	open(repoId: string, pr: { repo: string; number: number }, signal: AbortSignal): Promise<Comparison>
	start(reviewId: string, choice: ReviewerChoice, label: string): Promise<AiRun>
	/** Starts a run on only the files whose diff changed since the newest finished run, or says why it can't. */
	startIncremental(reviewId: string, choice: ReviewerChoice, label: string): Promise<AiRun | { refused: string }>
	/** The daily or monthly budget the next run would go over, in words; null when none is reached or none is set. */
	budgetReached?(): string | null
	addFindings(
		repoId: string,
		reviewId: string,
		runId: string,
		levels: ReadonlyArray<FindingLevel>,
		prepared?: boolean, // for you to post: their AI line doesn't say "posted automatically"
	): Promise<Array<string>>
	/** Submits as you (false: prepares the review for you to submit; see PreparedReview). Absent: submits. */
	submits?(): boolean
	/** Keeps a prepared review on the stored review, for the banner that offers it. */
	prepare?(repoId: string, reviewId: string, prepared: PreparedReview): Promise<void>
	plan(repoId: string, reviewId: string): Promise<PublishPlan>
	publish(repoId: string, reviewId: string, commentId: string, outsideDiff: 'file' | 'skip'): Promise<PublishOutcome>
	submit(repoId: string, reviewId: string, event: ReviewEvent, body: string): Promise<PublishedReview>
	/** The pull request's threads and reviews, as GitHub reports them now. */
	discussion?(repoId: string, reviewId: string): Promise<Discussion>
	/** CI for the snapshot's head commit, as GitHub reports it now. */
	checks(repoId: string, reviewId: string): Promise<HeadChecks>
	/** The automatic review added comments to a stored review, so a window showing it can load them. */
	reviewChanged(repoId: string, reviewId: string): void
	/** It finished (posted, skipped or failed); tell the user. */
	finished(event: RepoEvent, record: AutoReviewRecord): void
	waitMs?: number
	ciPollMs?: number // how often unfinished CI is read again before approving (default 1 minute)
	ciWaitMs?: number // how long to wait for it (default 20 minutes)
	quietMs?: number // how long the head must stay the same before new commits are reviewed (default 5 minutes)
}

const OUTCOME: Record<ReviewEvent, AutoReviewRecord['outcome']> = {
	APPROVE: 'approved',
	REQUEST_CHANGES: 'changes-requested',
	COMMENT: 'commented',
}

const SUBMITTED: ReadonlyArray<AutoReviewRecord['outcome']> = Object.values(OUTCOME)
// Outcomes that reviewed the commits (and cost a run): what a follow-up round is.
const REVIEWED: ReadonlyArray<AutoReviewRecord['outcome']> = [...SUBMITTED, 'quiet', 'failed']
// Follow-ups per request (issue #166): enough for a few rounds of fixes, more while something risky is still open.
export const FOLLOW_UPS = 3
export const FOLLOW_UPS_RISKY = 5

/**
 * Reviews new review requests with AI and submits the result on GitHub as you, when automatic review is turned on.
 * One pull request at a time, after any AI review you are running. Each head commit is reviewed at most once. It never
 * posts into a pending review of yours, since submitting would send your comments too. With `commits` on, new commits
 * on a pull request it submitted a review for are reviewed too, incrementally, once the head has stopped moving.
 */
export class AutoReviewer {
	private d: AutoReviewDeps
	private queue: Promise<void> = Promise.resolve()
	private queued = new Set<string>()
	private quiet = new Map<string, ReturnType<typeof setTimeout>>() // new commits waiting for the head to settle, by pull request

	constructor(deps: AutoReviewDeps) {
		this.d = deps
	}

	/**
	 * Takes the watcher's events; new requests, requests after an earlier review, and drafts marked ready are reviewed.
	 * New commits are reviewed with `commits` on, when an automatic review was submitted for the pull request, once its
	 * head has stayed the same for `quietMs`: each push restarts the wait, so a series of pushes is reviewed once.
	 */
	take(events: Array<RepoEvent>): void {
		if (!this.d.enabled()) return
		const viewer = this.d.viewer()?.toLowerCase() ?? null
		for (const e of events) {
			if (e.pr.draft) continue
			if (viewer && e.pr.author?.toLowerCase() === viewer) continue
			const key = watchKey(e.pr)
			clearTimeout(this.quiet.get(key))
			this.quiet.delete(key)
			if (e.kind === 'updated') {
				if (!this.d.commits() || !this.followsUp(key)) continue
				this.quiet.set(
					key,
					setTimeout(
						() => {
							this.quiet.delete(key)
							if (this.d.enabled() && this.d.commits()) this.enqueue(e)
						},
						this.d.quietMs ?? 5 * 60_000,
					),
				)
				continue
			}
			this.enqueue(e)
		}
	}

	/**
	 * Whether new commits on this pull request are for the automatic review: it submitted one, or it followed one up,
	 * and it hasn't used up its follow-ups (see followLimit).
	 */
	private followsUp(key: string): boolean {
		const r = this.d.store.read().autoReviews?.[key]
		return !!r && !r.stopped && (SUBMITTED.includes(r.outcome) || r.commits === true)
	}

	private enqueue(e: RepoEvent): void {
		const key = watchKey(e.pr)
		const id = `${key}@${e.pr.head ?? ''}`
		if (this.queued.has(id) || (e.pr.head && this.d.store.read().autoReviews?.[key]?.head === e.pr.head)) return
		this.queued.add(id)
		this.queue = this.queue.then(() => this.review(e).finally(() => this.queued.delete(id)))
	}

	/**
	 * Takes again the reviews a budget paused. Each one stops at the start again, quietly, while the budget is still
	 * reached; called when budgets change and from time to time, since a new day or month frees a daily or monthly one.
	 */
	resumePaused(): void {
		const waiting = Object.values(this.d.store.read().autoReviews ?? {}).flatMap((r) =>
			r.outcome === 'paused' && r.waiting ? [{ kind: r.commits ? ('updated' as const) : ('requested' as const), ...r.waiting }] : [],
		)
		if (waiting.length) this.take(waiting)
	}

	/** Resolves once everything queued so far is done (for tests and shutdown). New commits still settling are not queued yet. */
	idle(): Promise<void> {
		return this.queue
	}

	private async review(e: RepoEvent): Promise<void> {
		const key = watchKey(e.pr)
		const label = `${e.pr.repo}#${e.pr.number}`
		const commits = e.kind === 'updated'
		let reviewId: string | null = null
		let head = e.pr.head ?? ''
		let posted = 0
		const record = async (
			outcome: AutoReviewRecord['outcome'],
			message: string,
			url: string | null = null,
			round: { posted?: number; usd?: number | null; limit?: number; stop?: boolean } = {},
		): Promise<void> => {
			const paused = outcome === 'paused'
			const before = this.d.store.read().autoReviews?.[key]
			const at = new Date().toISOString()
			// Rounds count the follow-ups that reviewed something; a new request starts the count and the history over.
			const counted = commits && REVIEWED.includes(outcome)
			const rounds = commits ? (before?.rounds ?? 0) + (counted ? 1 : 0) : 0
			// Any round that reviewed counts toward the limit, a failed one too; the caller words the stop when it knows more.
			const limit = round.limit ?? (commits ? before?.followLimit : undefined) ?? FOLLOW_UPS
			const stop = !!round.stop || (counted && rounds >= limit)
			if (stop && !round.stop) message += ` Stopped following ${label} after ${plural(rounds, 'round')} of new commits.`
			const history = paused
				? (before?.history ?? [])
				: [...(commits ? (before?.history ?? []) : []), { head, at, outcome, posted: round.posted ?? 0, usd: round.usd ?? null }].slice(-10)
			// A paused review has not reviewed this head, so it keeps none; it remembers the request to take it again.
			const r: AutoReviewRecord = {
				head: paused ? '' : head,
				at,
				reviewId,
				outcome,
				message,
				url,
				...(paused ? { waiting: { repoId: e.repoId, pr: e.pr } } : {}),
				...(commits ? { commits: true } : {}),
				...(rounds ? { rounds } : {}),
				...(commits ? { followLimit: limit } : {}),
				...(stop ? { stopped: true } : {}),
				...(history.length ? { history } : {}),
			}
			await this.d.store.update((s) => void ((s.autoReviews ??= {})[key] = r))
			// Told once: taking it again while the budget is still reached says nothing new. A quiet round says nothing either,
			// unless it is the last one.
			if (!(paused && before?.outcome === 'paused') && !(outcome === 'quiet' && !stop)) this.d.finished(e, r)
		}
		try {
			if (!(await this.turn())) return
			// Checked before the pull request is fetched, so a paused review costs nothing while it waits.
			const reached = this.d.budgetReached?.() ?? null
			if (reached) return record('paused', paused(label, reached))
			const c = await this.d.open(e.repoId, e.pr, AbortSignal.timeout(5 * 60_000))
			reviewId = c.id
			head = c.headSha
			if (this.d.store.read().autoReviews?.[key]?.head === head) return
			// Pushed again since the event: that push's own event comes next and waits for the head to settle.
			if (commits && e.pr.head && head !== e.pr.head) return
			const plan = await this.d.plan(e.repoId, c.id)
			if (plan.blocked) return record('skipped', `Not reviewed automatically: ${plan.blocked.message}`)
			if (plan.pr.state !== 'open') return record('skipped', `Not reviewed automatically: ${label} is ${plan.pr.state}.`)
			// Preparing writes nothing on GitHub, so a pending review of yours is no reason to stop.
			const submitting = this.d.submits?.() ?? true
			if (plan.pending.kind !== 'none' && submitting)
				return record(
					'skipped',
					`Not reviewed automatically: you have a pending review on ${label} on GitHub, and submitting would send your comments too.`,
				)
			const { choice, label: reviewer } = this.d.reviewer()
			let run: AiRun | null = null
			while (!run) {
				if (!(await this.turn())) return
				try {
					if (!commits) run = await this.d.start(c.id, choice, label)
					else {
						const started = await this.d.startIncremental(c.id, choice, label)
						if ('refused' in started)
							return record(
								'skipped',
								`New commits on ${label} were not reviewed automatically: ${started.refused} Review them yourself, or run a review of all files.`,
							)
						run = started
					}
				} catch (err) {
					if (err instanceof AppFail && err.code === 'over-budget') return record('paused', paused(label, err.message))
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
			const ids = await this.d.addFindings(e.repoId, c.id, final.id, this.d.levels(), !submitting)
			if (ids.length) this.d.reviewChanged(e.repoId, c.id)
			// Prepared, the comments wait in the app for you; they count as posted for the verdict, since you'll post them.
			if (!submitting) posted = ids.length
			else
				for (const id of ids) {
					const out = await this.d.publish(e.repoId, c.id, id, 'file')
					if (out.status === 'published' || out.status === 'updated') posted++
				}
			const stored = this.d.store.read().repos[e.repoId]?.reviews[c.id]
			if (!stored) throw new AppFail('not-found', 'The review was removed while it was being posted.')
			const who = { reviewer, viewer: this.d.viewer(), prepared: !submitting }
			const readCi = () => this.d.checks(e.repoId, c.id).catch(() => null)
			let ci = await readCi()
			let verdict = autoVerdict(final, stored, this.d.runsFor(e.repoId, c.id), posted, who, ci)
			// Nothing but unfinished CI stands in the way of an approval: wait for it, then decide.
			const until = Date.now() + (this.d.ciWaitMs ?? 20 * 60_000)
			while (verdict.ciStopped === 'pending' && Date.now() < until) {
				await new Promise((r) => setTimeout(r, this.d.ciPollMs ?? 60_000))
				if (!this.d.enabled())
					return record('skipped', `Automatic review was turned off while waiting for CI. The findings for ${label} are in the app.`)
				ci = await readCi()
				verdict = autoVerdict(final, stored, this.d.runsFor(e.repoId, c.id), posted, who, ci)
			}
			// The author may have pushed, or turned on auto-merge, and others may have commented, during the run or the wait:
			// read it all right before submitting.
			const [state, discussion] = await Promise.all([
				this.d.plan(e.repoId, c.id).then(
					(p) => ({ head: p.pr.headSha, autoMerge: p.pr.autoMerge }),
					() => ({ head: null, autoMerge: null }),
				),
				this.d.discussion ? this.d.discussion(e.repoId, c.id).catch(() => null) : Promise.resolve(undefined),
			])
			const others =
				discussion === undefined
					? undefined
					: discussion && discussion.status !== 'unavailable'
						? othersConcerns(discussion, { viewer: this.d.viewer(), author: stored.pr?.author ?? null, botChecks: final.botChecks ?? [] })
						: null
			const pr = { ...state, others }
			verdict = autoVerdict(final, stored, this.d.runsFor(e.repoId, c.id), posted, who, ci, pr)
			if (!submitting) {
				const prepared: PreparedReview = {
					event: verdict.event,
					body: verdict.body,
					head: final.headSha,
					at: new Date().toISOString(),
					runId: final.id,
					reviewer,
					comments: ids.length,
				}
				await this.d.prepare?.(e.repoId, c.id, prepared)
				this.d.reviewChanged(e.repoId, c.id)
				return record('prepared', `Prepared ${label}: ${preparedLine(prepared)}. Open it to check and submit.`)
			}
			// A follow-up round (issue #166): the last one allowed says it stops; one with nothing new posts nothing.
			const usd = final.cost?.usd ?? null
			let round: { posted: number; usd: number | null; limit?: number; stop?: boolean } = { posted, usd }
			let stopLine = ''
			if (commits) {
				const before = this.d.store.read().autoReviews?.[key]
				const n = (before?.rounds ?? 0) + 1
				const riskOf = (k: string) => (final.coverage?.files ?? []).find((f) => f.fileKey === k)?.risk?.level
				const open = final.findings.filter(
					(f) => f.severity === 'blocking' && !f.mergedInto && !f.heldBack && stored.findingDecisions?.[f.id]?.status !== 'dismissed',
				)
				const limit = open.some((f) => riskOf(f.anchor.fileKey) === 'high') ? FOLLOW_UPS_RISKY : FOLLOW_UPS
				const stop = n >= limit
				round = { ...round, limit, ...(stop ? { stop: true } : {}) }
				if (stop)
					stopLine = ` Stopped following ${label} after ${plural(n, 'round')} of new commits${open.length ? `: ${plural(open.length, 'blocking finding')} still open` : ''}. Review new commits yourself, or ask for a review again to start over.`
				// Nothing new and the same verdict: the earlier review still says it. An approval is given again, so it covers
				// the new head where approvals on older commits are dismissed.
				const last = [...(before?.history ?? [])].reverse().find((h) => SUBMITTED.includes(h.outcome))?.outcome
				if (!posted && last && last === OUTCOME[verdict.event] && verdict.event !== 'APPROVE')
					return record(
						'quiet',
						`Nothing new on ${label} (round ${n}); the earlier review still stands, so nothing was posted.${stopLine}`,
						null,
						round,
					)
			}
			const done = await this.d.submit(e.repoId, c.id, verdict.event, verdict.body)
			const said =
				verdict.event === 'APPROVE'
					? 'Approved'
					: verdict.event === 'REQUEST_CHANGES'
						? `Requested changes with ${plural(posted, 'comment')}`
						: `Commented${posted ? ` with ${plural(posted, 'comment')}` : ''}`
			await record(OUTCOME[verdict.event], `${said} on ${label}, automatically.${stopLine}`, done.url, round)
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
