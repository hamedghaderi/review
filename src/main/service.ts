import { stat } from 'node:fs/promises'
import type {
	AiRun,
	AiScope,
	BranchPr,
	PastDecision,
	BranchPreview,
	BrowserState,
	CompareTarget,
	Comparison,
	Discussion,
	FileLinesResult,
	GitHubMapping,
	LoadedComparison,
	ModelSelection,
	PatchResult,
	PrDetail,
	PrGraph,
	PrPage,
	PrQuery,
	RepoInfo,
	RepoSession,
	Review,
	ReviewComment,
	ReviewEvent,
	ReviewerChoice,
	ReviewRule,
	ReviewTarget,
	SearchSlot,
	TargetProbe,
} from '../shared/types.ts'
import {
	aheadBehind,
	AppFail,
	compareBranches,
	compareSnapshot,
	ensureCommits,
	findRoot,
	mergeBase,
	ObjectUnavailable,
	readBlob,
	readPatch,
	readRepo,
	resolveBranchTarget,
	shortRef,
	type ComparisonData,
} from './git.ts'
import { errorOf, type GitHubService } from './github.ts'
import { parsePatch, pickSection } from './patch.ts'
import { Publisher } from './publish.ts'
import { carryComments } from './carry.ts'
import { discussionOf, placeThreads } from './discussion.ts'
import { findRelated } from './ai/related.ts'
import { loadFacts } from './ai/facts.ts'
import { createReviewTools } from './ai/lookup.ts'
import type { McpService } from './ai/mcp.ts'
import type { AiController, ComparisonAccess } from './ai/controller.ts'
import { findingRoots } from '../shared/findings.ts'
import { inboxStatus, sortInbox } from '../shared/inbox.ts'
import type { ReviewStore, StoreData } from './store.ts'
import { aiScope, reviewUpdate } from './validate.ts'

const PATCH_LIMIT = 1024 * 1024 // 1 MB of patch text renders normally
const PATCH_FORCE_LIMIT = 16 * 1024 * 1024
const CHANGED_LINES_LIMIT = 10_000
const FILE_LINES_LIMIT = 8 * 1024 * 1024
const PR_ATTEMPTS = 3

export function defaultBrowserState(): BrowserState {
	return {
		view: 'browse',
		section: 'prs',
		prFilter: 'open',
		prQuery: '',
		branchQuery: '',
		selected: null,
		baseRef: null,
		expanded: ['sec:pinned', 'sec:local', 'sec:remotes'],
		pinned: [],
		scroll: {},
		prStacks: false,
	}
}

/** Repository reads and review persistence. Only repositories the user opened (or previously opened) can be addressed. */
export class ReviewService {
	private repos = new Map<string, RepoInfo>()
	private comparisons = new Map<string, ComparisonData>()
	private store: ReviewStore
	private ai: AiController | null = null
	private mcp: McpService | null = null
	private github: GitHubService | null
	private loadGen = 0
	private opening: AbortController | null = null
	private searching = new Map<SearchSlot, AbortController>()
	private publisher: Publisher | null
	private branchPrs = new Map<string, { at: number; value: BranchPr }>()

	constructor(store: ReviewStore, github: GitHubService | null = null) {
		this.store = store
		this.github = github
		this.publisher = github && new Publisher(store, github, (reviewId, key) => this.hunksFor(reviewId, key))
	}

	/** The 3-line-context hunks GitHub shows for a file, or null when it has no text diff (binary, too large). */
	private async hunksFor(reviewId: string, fileKey: string) {
		if (!this.comparisons.has(reviewId)) throw new AppFail('not-found', 'Open this review before publishing it.')
		const p = await this.loadPatch(reviewId, fileKey, false)
		return p.kind === 'text' ? p.hunks : null
	}

	private requirePublisher(repoId: string): Publisher {
		this.repo(repoId)
		if (!this.publisher) throw new AppFail('github-failed', 'GitHub is not available.')
		return this.publisher
	}

	publishPlan(repoId: string, reviewId: string) {
		return this.requirePublisher(repoId).plan(repoId, reviewId)
	}

	publishComment(repoId: string, reviewId: string, commentId: string, outsideDiff: 'file' | 'skip') {
		return this.requirePublisher(repoId).publish(repoId, reviewId, commentId, outsideDiff)
	}

	submitReview(repoId: string, reviewId: string, event: ReviewEvent, body: string) {
		return this.requirePublisher(repoId).submit(repoId, reviewId, event, body)
	}

	/**
	 * The open PR review's existing activity on GitHub, placed on this snapshot. Read-only, and never fatal: a failed
	 * read comes back as `unavailable` so the UI never implies the PR has no history.
	 */
	async prDiscussion(repoId: string, reviewId: string): Promise<Discussion> {
		this.repo(repoId)
		const stored = this.store.read().repos[repoId]?.reviews[reviewId]
		const data = this.comparisons.get(reviewId)
		if (!stored?.pr || !data) throw new AppFail('not-found', 'Open this pull request review first.')
		const empty = { threads: 0, comments: 0, reviews: 0, conversation: 0 }
		try {
			const activity = await this.requireGitHub().activity(stored.pr.repo, stored.pr.number)
			return discussionOf(data.comparison, activity, await placeThreads(data.root, data.comparison, activity))
		} catch (e) {
			const reason = `The existing discussion couldn't be read from GitHub, so earlier comments may exist that aren't shown. ${errorOf(e).message}`
			return {
				status: 'unavailable',
				reason,
				fetchedAt: new Date().toISOString(),
				prHead: null,
				threads: [],
				reviews: [],
				conversation: [],
				omitted: empty,
			}
		}
	}

	attachAi(ai: AiController): void {
		this.ai = ai
	}

	attachMcp(mcp: McpService): void {
		this.mcp = mcp
	}

	/** The root of an open repository, where MCP servers are started and Claude Code's project settings are read. */
	repoRoot(repoId: string | null): string | null {
		return repoId ? (this.repos.get(repoId)?.root ?? null) : null
	}

	async open(dir: string): Promise<RepoSession> {
		const root = await findRoot(dir)
		const repo = await readRepo(root)
		this.repos.set(repo.id, repo)
		this.ai?.cancelUnless(null)
		// Switching repositories abandons network work that belongs to the previous one.
		this.cancelOpen()
		for (const c of this.searching.values()) c.abort()
		this.loadGen++
		await this.store.update((d) => {
			d.lastRepoId = repo.id
			const s = (d.repos[repo.id] ??= { repoId: repo.id, root, selectedBase: null, activeReviewId: null, reviews: {}, aiRuns: {} })
			s.root = root
			s.githubResolved = mapping(repo, s.githubRepo ?? null).selected
		})
		return this.session(repo)
	}

	/** Opens a repository from the store by id (e.g. from a notification), without a folder dialog. */
	async openKnown(repoId: string): Promise<RepoSession> {
		const s = this.store.read().repos[repoId]
		if (!s) throw new AppFail('not-found', 'That repository is not known to the app. Open it first.')
		return this.open(s.root)
	}

	/** GitHub repositories ("owner/name", lower case) of every repository opened in the app, mapped to their ids. */
	knownGitHubRepos(): Map<string, string> {
		const out = new Map<string, string>()
		for (const s of Object.values(this.store.read().repos)) {
			const gh = s.githubRepo ?? s.githubResolved
			if (gh) out.set(gh.toLowerCase(), s.repoId)
		}
		return out
	}

	async restoreLast(): Promise<RepoSession | null> {
		const d = this.store.read()
		const s = d.lastRepoId ? d.repos[d.lastRepoId] : undefined
		if (!s) return null
		const exists = await stat(s.root).then(
			(st) => st.isDirectory(),
			() => false,
		)
		if (!exists) return null
		return this.open(s.root)
	}

	async refresh(repoId: string): Promise<RepoSession> {
		return this.session(await this.reread(repoId))
	}

	private async reread(repoId: string): Promise<RepoInfo> {
		const repo = await readRepo(this.repo(repoId).root)
		this.repos.set(repo.id, repo)
		return repo
	}

	cancelOpen(): boolean {
		const had = !!this.opening
		this.opening?.abort()
		this.opening = null
		return had
	}

	async loadComparison(repoId: string, target: CompareTarget): Promise<LoadedComparison> {
		this.repo(repoId)
		const gen = ++this.loadGen
		this.cancelOpen()
		const ctl = new AbortController()
		this.opening = ctl
		let data: ComparisonData
		let notice: string | null = null
		try {
			if (target.kind === 'snapshot') {
				const stored = this.store.read().repos[repoId]?.reviews[target.reviewId]
				if (!stored) throw new AppFail('not-found', 'That review no longer exists.')
				data = await compareSnapshot(this.repo(repoId).root, snapshotOf(stored))
			} else if (target.target.kind === 'branch') {
				const repo = await this.reread(repoId)
				data = await compareBranches(repo, target.target.headRef, target.target.baseRef)
			} else {
				;({ data, notice } = await this.openPr(repoId, target.target, ctl.signal))
			}
		} finally {
			if (this.opening === ctl) this.opening = null
		}
		// A newer open request (or a repository switch) supersedes this one; its result must not become active.
		if (gen !== this.loadGen || ctl.signal.aborted) throw new AppFail('cancelled', 'A newer review was opened.')
		const c = data.comparison
		this.comparisons.set(c.id, data)
		this.ai?.cancelUnless(c.id)
		const carry = target.kind === 'target' ? await this.carry(repoId, data, target.from ?? null) : null
		if (gen !== this.loadGen) throw new AppFail('cancelled', 'A newer review was opened.')
		if (carry?.notice) notice = notice ? `${notice} ${carry.notice}` : carry.notice
		const now = new Date().toISOString()
		await this.store.update((d) => {
			const s = d.repos[repoId]
			const existing = s.reviews[c.id]
			if (existing) {
				existing.target ??= c.target
				existing.pr ??= c.pr
				if (carry?.comments.length) {
					const have = new Set([...(existing.carriedOrigins ?? []), ...existing.comments.map((x) => x.carried?.originId ?? x.id)])
					const add = carry.comments.filter((x) => !have.has(x.carried!.originId))
					existing.comments.push(...add)
					existing.carriedOrigins = [...(existing.carriedOrigins ?? []), ...add.map((x) => x.carried!.originId)]
					if (add.length) existing.updatedAt = now
				}
			} else {
				s.reviews[c.id] = {
					id: c.id,
					repoId,
					baseRef: c.baseRef,
					baseTipSha: c.baseTipSha,
					baseSha: c.baseSha,
					headSha: c.headSha,
					headRef: c.headRef,
					target: c.target,
					pr: c.pr,
					createdAt: now,
					updatedAt: now,
					comments: carry?.comments ?? [],
					drafts: [],
					viewed: [],
					findingDecisions: {},
					...(carry?.comments.length ? { carriedOrigins: carry.comments.map((x) => x.carried!.originId) } : {}),
				}
			}
			s.activeReviewId = c.id
		})
		return {
			comparison: c,
			review: this.store.read().repos[repoId].reviews[c.id],
			aiRuns: this.ai?.runsFor(repoId, c.id) ?? [],
			notice,
		}
	}

	/**
	 * Comments to carry into the snapshot `data` from `from`, or, when this snapshot is new, from the latest snapshot
	 * of the same target (for a pull request, else the latest review of its head branch). The earlier snapshot is
	 * never changed. A failure here (for example the earlier commits were garbage-collected) never blocks opening.
	 */
	private async carry(
		repoId: string,
		data: ComparisonData,
		from: string | null,
	): Promise<{ comments: Array<ReviewComment>; notice: string | null } | null> {
		const c = data.comparison
		const reviews = this.store.read().repos[repoId]?.reviews ?? {}
		const existing = reviews[c.id]
		let src = from && from !== c.id ? reviews[from] : undefined
		if (!src && !existing) src = this.predecessor(repoId, c, Object.values(reviews))
		if (!src?.comments.length) return null
		const skip = new Set([...(existing?.carriedOrigins ?? []), ...(existing?.comments.map((x) => x.carried?.originId ?? x.id) ?? [])])
		const label = `${src.pr ? 'snapshot' : 'branch review'} ${src.baseSha.slice(0, 7)}…${src.headSha.slice(0, 7)}`
		try {
			const comments = await carryComments(data.root, src, c, skip)
			if (!comments.length) return null
			const outdated = comments.filter((x) => x.carried?.outdated).length
			const n = comments.length
			return {
				comments,
				notice: `Carried ${n} comment${n === 1 ? '' : 's'} over from ${label}.${outdated ? ` ${outdated} ${outdated === 1 ? 'is' : 'are'} outdated because the code changed; ${outdated === 1 ? 'it shows' : 'they show'} the old code.` : ''} The earlier snapshot keeps its own copy.`,
			}
		} catch (e) {
			return { comments: [], notice: `Comments could not be carried over from ${label}: ${errorOf(e).message}` }
		}
	}

	/**
	 * Findings the reviewer dismissed in any snapshot of this comparison's target (the same pull request, else the same
	 * branch), newest first, one per place and title.
	 */
	private pastDecisions(repoId: string, c: Comparison): Array<PastDecision> {
		const repo = this.store.read().repos[repoId]
		if (!repo) return []
		const key = targetKey(targetOf(c))
		const out: Array<PastDecision> = []
		for (const r of Object.values(repo.reviews)) {
			if (r.id !== c.id && targetKey(targetOf(r)) !== key) continue
			const byId = new Map((repo.aiRuns[r.id] ?? []).flatMap((run) => run.findings.map((f) => [f.id, f] as const)))
			for (const [id, d] of Object.entries(r.findingDecisions)) {
				const f = byId.get(id)
				if (d.status !== 'dismissed' || !f) continue
				out.push({
					path: f.anchor.newPath ?? f.anchor.oldPath ?? f.anchor.fileKey,
					line: f.anchor.startLine,
					title: f.title,
					category: f.category ?? null,
					reason: d.reason ?? null,
					note: d.note ?? null,
					decidedAt: d.decidedAt,
				})
			}
		}
		const seen = new Set<string>()
		return out
			.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))
			.filter((d) => {
				const k = `${d.path}\u0000${d.title}`
				if (seen.has(k)) return false
				seen.add(k)
				return true
			})
			.slice(0, 80)
	}

	private predecessor(repoId: string, c: Comparison, reviews: Array<Review>): Review | undefined {
		const latest = (xs: Array<Review>) => xs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
		const key = targetKey(targetOf(c))
		const same = latest(reviews.filter((r) => r.id !== c.id && targetKey(targetOf(r)) === key))
		if (same || !c.pr) return same
		// A pull request's first snapshot picks up the review of its head branch, if there is one.
		const [owner, branch] = c.pr.headLabel.includes(':') ? c.pr.headLabel.split(/:(.*)/s) : [c.pr.repo.split('/')[0], c.pr.headLabel]
		const head = `${owner}:${branch}`.toLowerCase()
		const repo = this.repo(repoId)
		return latest(
			reviews.filter((r) => {
				const t = targetOf(r)
				return !r.pr && t.kind === 'branch' && pushHead(repo, t.headRef)?.toLowerCase() === head
			}),
		)
	}

	/**
	 * Resolves a pull request to one consistent (base, head) pair, fetches exactly those commits into app-owned refs
	 * and compares merge-base(base, head)..head. Metadata is re-read after the fetch; if the PR moved in between, the
	 * newer pair is fetched instead, so a comparison never mixes two versions of the PR.
	 */
	private async openPr(repoId: string, t: Extract<ReviewTarget, { kind: 'pr' }>, signal: AbortSignal) {
		const gh = this.requireGitHub()
		const repo = this.repo(repoId)
		let d = await gh.detail(t.repo, t.number, signal)
		let changed = false
		for (let attempt = 1; ; attempt++) {
			const remote = fetchRemote(repo, [d.repo, t.repo])
			let unavailable: AppFail | null = null
			try {
				await ensureCommits(repo.root, remote, [d.baseSha, d.headSha], signal)
			} catch (e) {
				if (!(e instanceof ObjectUnavailable)) throw e
				unavailable = e
			}
			const again = await gh.detail(t.repo, t.number, signal)
			const moved = again.headSha !== d.headSha || again.baseSha !== d.baseSha
			if (moved) {
				changed = true
				d = again
				if (attempt < PR_ATTEMPTS) continue
				throw new AppFail('pr-changed', `#${t.number} kept changing while it was loading. Try again in a moment.`)
			}
			if (unavailable) throw historicalError(d, unavailable.message)
			d = again
			break
		}
		const baseSha = await mergeBase(repo.root, d.baseSha, d.headSha, prHeadLabel(d), d.baseRef ?? 'base')
		if (baseSha === d.headSha && d.state !== 'open' && d.state !== 'draft') {
			throw new AppFail(
				'pr-unavailable',
				`GitHub's recorded base for #${d.number} (${d.baseSha.slice(0, 7)}) already contains its head commit, so the original comparison cannot be reconstructed here. Open it on GitHub to see the changes as they were reviewed.`,
			)
		}
		const data = await compareSnapshot(repo.root, {
			repoId,
			baseRef: d.baseRef ?? 'base',
			baseTipSha: d.baseSha,
			baseSha,
			headSha: d.headSha,
			headRef: prHeadLabel(d),
			target: { kind: 'pr', repo: t.repo, number: t.number },
			pr: {
				repo: d.repo,
				number: d.number,
				title: d.title,
				url: d.url,
				state: d.state,
				baseRef: d.baseRef ?? '',
				headLabel: prHeadLabel(d),
				baseSha: d.baseSha,
				headSha: d.headSha,
				body: d.body.slice(0, 8000),
			},
		})
		const notice = changed
			? `#${d.number} was updated while it was loading. Showing the latest consistent version (head ${d.headSha.slice(0, 7)}).`
			: null
		return { data, notice }
	}

	/** Detects new commits on the open review's target. Reads only; nothing is fetched. */
	async probeTarget(repoId: string, reviewId: string): Promise<TargetProbe> {
		const stored = this.store.read().repos[repoId]?.reviews[reviewId]
		if (!stored) throw new AppFail('not-found', 'That review no longer exists.')
		const target = targetOf(stored)
		try {
			if (target.kind === 'pr') {
				const d = await this.requireGitHub().detail(target.repo, target.number)
				const head = d.headSha !== stored.headSha
				const base = !!stored.pr && d.baseSha !== stored.pr.baseSha
				const summary = head ? `New head ${d.headSha.slice(0, 7)}` : base ? `Base moved to ${d.baseSha.slice(0, 7)}` : null
				return { repo: null, changed: head || base, summary, error: null }
			}
			const repo = await this.reread(repoId)
			const s = await resolveBranchTarget(repo, target.headRef, target.baseRef)
			const head = s.headSha !== stored.headSha
			const base = s.baseSha !== stored.baseSha
			const summary = head
				? `${target.headRef === 'HEAD' ? 'HEAD' : shortRef(target.headRef)} is now at ${s.headSha.slice(0, 7)}`
				: base
					? `The merge base with ${shortRef(target.baseRef)} is now ${s.baseSha.slice(0, 7)}`
					: null
			return { repo, changed: head || base, summary, error: null }
		} catch (e) {
			return { repo: null, changed: false, summary: null, error: errorOf(e) }
		}
	}

	async branchPreview(repoId: string, headRef: string, baseRef: string): Promise<BranchPreview> {
		const repo = this.repo(repoId)
		try {
			const s = await resolveBranchTarget(repo, headRef, baseRef)
			const ab = await aheadBehind(repo.root, s.baseTipSha, s.headSha)
			return {
				headSha: s.headSha,
				baseTipSha: s.baseTipSha,
				mergeBase: s.baseSha,
				ahead: ab?.ahead ?? null,
				behind: ab?.behind ?? null,
				error: null,
			}
		} catch (e) {
			const find = (r: string) => repo.branches.find((b) => b.ref === r)?.sha ?? ''
			return { headSha: find(headRef), baseTipSha: find(baseRef), mergeBase: null, ahead: null, behind: null, error: errorOf(e) }
		}
	}

	/** A newer search in the same slot (the list or the quick-open palette) cancels the previous one. */
	async searchPrs(repoId: string, query: PrQuery, slot: SearchSlot = 'list'): Promise<PrPage> {
		const repo = this.githubRepoFor(repoId)
		this.searching.get(slot)?.abort()
		const ctl = new AbortController()
		this.searching.set(slot, ctl)
		try {
			const page = await this.requireGitHub().search(repo, query, ctl.signal)
			return query.filter === 'inbox' ? this.withInboxStatus(repoId, page) : page
		} finally {
			if (this.searching.get(slot) === ctl) this.searching.delete(slot)
		}
	}

	async branchPr(repoId: string, headRef: string): Promise<BranchPr> {
		const repo = this.githubRepoFor(repoId)
		const info = this.repo(repoId)
		// refs/remotes/pr/<n> style refs (fetched with `git fetch origin pull/<n>/head:…`) belong to no configured remote.
		const b = info.branches.find((x) => x.ref === headRef)
		if (b?.kind === 'remote' && !info.remotes.some((r) => r.name === b.remote) && /^\d{1,9}$/.test(b.short))
			return { repo, head: `#${b.short}`, prs: [await this.requireGitHub().detail(repo, Number(b.short))] }
		const head = pushHead(info, headRef)
		if (!head) return { repo, head: null, prs: [] }
		const key = `${repo}|${head}`
		const hit = this.branchPrs.get(key)
		// ponytail: 2-minute cache per head keeps branch browsing within the anonymous rate limit; no invalidation on push.
		if (hit && Date.now() - hit.at < 120_000) return hit.value
		const rank = (s: string): number => (s === 'open' || s === 'draft' ? 0 : 1)
		const prs = (await this.requireGitHub().pullsForHead(repo, head)).sort(
			(a, b) => rank(a.state) - rank(b.state) || b.updatedAt.localeCompare(a.updatedAt),
		)
		const value = { repo, head, prs: prs.slice(0, 5) }
		if (this.branchPrs.size > 200) this.branchPrs.clear()
		this.branchPrs.set(key, { at: Date.now(), value })
		return value
	}

	/** Details for the preview and an open PR review, with who approved or reviewed it. A failed review read leaves `review` null. */
	async prDetail(repoId: string, number: number): Promise<PrDetail> {
		const repo = this.githubRepoFor(repoId)
		const gh = this.requireGitHub()
		const d = await gh.detail(repo, number)
		const review = await gh.prReviews(repo, number, d.headSha, d.author).catch(() => null)
		return { ...d, review }
	}

	private withInboxStatus(repoId: string, page: PrPage): PrPage {
		const viewer = this.github?.status().login ?? null
		const seen = this.store.read().repos[repoId]?.seenPrs ?? {}
		const items = page.items.flatMap((pr) => {
			const inbox = inboxStatus(pr, viewer, pr.reviewRequested === 'you', !!seen[pr.number])
			return inbox ? [{ ...pr, inbox }] : []
		})
		return { ...page, items: sortInbox(items), total: items.length }
	}

	async markPrSeen(repoId: string, number: number): Promise<boolean> {
		if (!this.store.read().repos[repoId]) throw new AppFail('not-found', 'That repository is not open.')
		await this.store.update((d) => {
			const seen = (d.repos[repoId].seenPrs ??= {})
			seen[number] = new Date().toISOString()
			const keys = Object.keys(seen)
			// ponytail: oldest marks past 1,000 are dropped; those PRs would show as "new" again if re-requested unseen
			if (keys.length > 1000)
				for (const k of keys.sort((a, b) => seen[a].localeCompare(seen[b])).slice(0, keys.length - 1000)) delete seen[k]
		})
		return true
	}

	prGraph(repoId: string): Promise<PrGraph | null> {
		return this.requireGitHub().openPrGraph(this.githubRepoFor(repoId))
	}

	async setGitHubRepo(repoId: string, repo: string): Promise<GitHubMapping> {
		const info = this.repo(repoId)
		if (!mapping(info, null).candidates.some((c) => c.repo === repo))
			throw new AppFail('invalid-input', 'That repository is not one of the remotes.')
		await this.store.update((d) => {
			d.repos[repoId].githubRepo = repo
		})
		return mapping(info, repo)
	}

	async saveBrowserState(repoId: string, state: BrowserState): Promise<boolean> {
		this.repo(repoId)
		await this.store.update((d) => {
			d.repos[repoId].browser = state
		})
		return true
	}

	async loadPatch(comparisonId: string, fileKey: string, force: boolean): Promise<PatchResult> {
		const { data, file } = this.file(comparisonId, fileKey)
		if (file.binary) return { kind: 'binary' }
		const changed = (file.additions ?? 0) + (file.deletions ?? 0)
		if (!force && changed > CHANGED_LINES_LIMIT) {
			return {
				kind: 'too-large',
				reason: `${changed.toLocaleString()} changed lines (display limit ${CHANGED_LINES_LIMIT.toLocaleString()})`,
				canForce: true,
			}
		}
		const limit = force ? PATCH_FORCE_LIMIT : PATCH_LIMIT
		const { text, truncated } = await readPatch(data, file, limit)
		if (truncated) {
			return force
				? { kind: 'too-large', reason: `Patch exceeds the hard limit of ${mb(PATCH_FORCE_LIMIT)}`, canForce: false }
				: { kind: 'too-large', reason: `Patch exceeds ${mb(PATCH_LIMIT)}`, canForce: true }
		}
		const section = pickSection(parsePatch(text), file.status)
		if (!section) return { kind: 'text', hunks: [], bytes: 0 }
		if (section.binary) return { kind: 'binary' }
		return { kind: 'text', hunks: section.hunks, bytes: Buffer.byteLength(text) }
	}

	/** Full text of the newer version (older for deletions), used to expand unchanged context. */
	async loadFileLines(comparisonId: string, fileKey: string): Promise<FileLinesResult> {
		const { data } = this.file(comparisonId, fileKey)
		const b = data.blobs.get(fileKey)
		const blob = b?.newBlob ?? b?.oldBlob
		if (!blob) return { kind: 'text', lines: [] }
		const { buf, truncated } = await readBlob(data.root, blob, FILE_LINES_LIMIT)
		if (truncated) return { kind: 'too-large', reason: `File exceeds ${mb(FILE_LINES_LIMIT)}` }
		if (buf.subarray(0, 8000).includes(0)) return { kind: 'binary' }
		const lines = buf.toString('utf8').split('\n')
		if (lines[lines.length - 1] === '') lines.pop()
		return { kind: 'text', lines: lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)) }
	}

	async saveReview(input: unknown): Promise<{ savedAt: string }> {
		const o = input as Partial<Review> | null
		const repoId = typeof o?.repoId === 'string' ? o.repoId : ''
		const id = typeof o?.id === 'string' ? o.id : ''
		const stored = this.store.read().repos[repoId]?.reviews[id]
		if (!stored || !this.repos.has(repoId)) throw new AppFail('not-found', 'This review is not open.')
		const next = reviewUpdate(input, stored, findingRoots(this.ai?.runsFor(repoId, id) ?? []))
		const savedAt = new Date().toISOString()
		await this.store.update((d) => {
			Object.assign(d.repos[repoId].reviews[id], next, { updatedAt: savedAt })
		})
		return { savedAt }
	}

	async startAi(reviewId: string, scopeInput: unknown, selection: ModelSelection | ReviewerChoice): Promise<AiRun> {
		const { ai, access } = this.aiAccess(reviewId)
		const scope: AiScope = aiScope(scopeInput, new Set(access.comparison.files.map((f) => f.key)))
		return ai.start(access, reviewId, scope, selection)
	}

	async retryAiRules(reviewId: string, runId: string, rules: Array<ReviewRule>): Promise<AiRun> {
		const { ai, access } = this.aiAccess(reviewId)
		return ai.retryRules(access, reviewId, runId, rules)
	}

	async askFinding(reviewId: string, findingId: string, question: string): Promise<AiRun> {
		const { ai, access } = this.aiAccess(reviewId)
		return ai.ask(access, reviewId, findingId, question)
	}

	private aiAccess(reviewId: string): { ai: AiController; access: ComparisonAccess } {
		if (!this.ai) throw new AppFail('ai-unavailable', 'AI review is not available.')
		const data = this.comparisons.get(reviewId)
		if (!data) throw new AppFail('not-found', 'That comparison is not loaded.')
		const repoId = data.comparison.repoId
		if (!this.store.read().repos[repoId]?.reviews[reviewId]) throw new AppFail('not-found', 'That review is not open.')
		return {
			ai: this.ai,
			access: {
				comparison: data.comparison,
				loadPatch: (key) => this.loadPatch(reviewId, key, false),
				loadFileLines: (key) => this.loadFileLines(reviewId, key),
				findRelated: (sources, signal) => findRelated(data.root, data.comparison.headSha, sources, signal),
				pastDecisions: () => this.pastDecisions(repoId, data.comparison),
				tools: (budget, external) =>
					createReviewTools({ root: data.root, baseSha: data.comparison.baseSha, headSha: data.comparison.headSha }, budget, external),
				openExternal: this.mcp ? (signal) => this.mcp!.open(data.root, signal) : undefined,
				loadFacts: (sources, signal) => {
					const c = data.comparison
					const gh = this.github
					// CI results for exactly the commit under review: the PR's repository, or the branch's mapped GitHub repository.
					const repo = c.pr?.repo ?? mapping(this.repo(repoId), this.store.read().repos[repoId]?.githubRepo ?? null).selected
					return loadFacts({
						root: data.root,
						baseSha: c.baseSha,
						headSha: c.headSha,
						sources,
						checks: gh && repo ? () => gh.checks(repo, c.headSha, signal) : null,
						annotations: gh && repo ? (id) => gh.annotations(repo, id, signal) : null,
						signal,
					})
				},
			},
		}
	}

	private requireGitHub(): GitHubService {
		if (!this.github) throw new AppFail('github-failed', 'GitHub is not available.')
		return this.github
	}

	private githubRepoFor(repoId: string): string {
		const m = mapping(this.repo(repoId), this.store.read().repos[repoId]?.githubRepo ?? null)
		if (!m.selected) throw new AppFail('github-not-found', 'None of this repository’s remotes point to github.com.')
		return m.selected
	}

	private repo(repoId: string): RepoInfo {
		const r = this.repos.get(repoId)
		if (!r) throw new AppFail('not-found', 'That repository is not open.')
		return r
	}

	private file(comparisonId: string, fileKey: string) {
		const data = this.comparisons.get(comparisonId)
		if (!data) throw new AppFail('not-found', 'That comparison is not loaded.')
		const file = data.comparison.files.find((f) => f.key === fileKey)
		if (!file) throw new AppFail('not-found', 'That file is not part of this comparison.')
		return { data, file }
	}

	private session(repo: RepoInfo): RepoSession {
		const s = (this.store.read() as StoreData).repos[repo.id]
		return {
			repo,
			activeReviewId: s?.activeReviewId ?? null,
			browser: s?.browser
				? { ...defaultBrowserState(), ...s.browser }
				: { ...defaultBrowserState(), section: repo.remotes.some((r) => r.github) ? 'prs' : 'local' },
			github: mapping(repo, s?.githubRepo ?? null),
			reviews: Object.values(s?.reviews ?? {})
				.map((r) => ({
					id: r.id,
					baseRef: r.baseRef,
					baseSha: r.baseSha,
					headSha: r.headSha,
					headRef: r.headRef,
					target: r.target ?? null,
					pr: r.pr ?? null,
					updatedAt: r.updatedAt,
					comments: r.comments.length,
					drafts: r.drafts.filter((d) => d.body.trim()).length,
				}))
				.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
		}
	}
}

/**
 * The "owner:branch" a branch is published as on GitHub: its upstream's remote owner and branch name, a remote
 * branch's own remote, or (for a local branch without an upstream) the same name on origin.
 */
export function pushHead(repo: RepoInfo, headRef: string): string | null {
	const b = headRef === 'HEAD' ? repo.branches.find((x) => x.current) : repo.branches.find((x) => x.ref === headRef)
	if (!b) return null
	let remote = b.remote
	let name = b.short
	if (b.kind === 'local') {
		const names = repo.remotes.map((r) => r.name).sort((x, y) => y.length - x.length)
		const rest = b.upstream?.startsWith('refs/remotes/') ? b.upstream.slice('refs/remotes/'.length) : null
		const r = rest ? names.find((n) => rest.startsWith(`${n}/`)) : undefined
		if (r && rest) {
			remote = r
			name = rest.slice(r.length + 1)
		} else remote = repo.remotes.some((x) => x.name === 'origin') ? 'origin' : (repo.remotes.find((x) => x.github)?.name ?? null)
	}
	const owner = repo.remotes.find((x) => x.name === remote)?.github?.split('/')[0]
	return owner && name ? `${owner}:${name}` : null
}

/** Reviews saved before milestone 3 compared HEAD with their base branch. */
function targetOf(r: Pick<Review, 'target' | 'baseRef'>): ReviewTarget {
	return r.target ?? { kind: 'branch', headRef: 'HEAD', baseRef: r.baseRef }
}

function targetKey(t: ReviewTarget): string {
	return t.kind === 'pr' ? `pr:${t.repo.toLowerCase()}#${t.number}` : `branch:${t.headRef}|${t.baseRef}`
}

function snapshotOf(r: Review): Omit<Comparison, 'id' | 'files'> {
	return {
		repoId: r.repoId,
		baseRef: r.baseRef,
		baseTipSha: r.baseTipSha,
		baseSha: r.baseSha,
		headSha: r.headSha,
		headRef: r.headRef,
		target: r.target ?? null,
		pr: r.pr ?? null,
	}
}

/**
 * GitHub repositories reachable through this clone's remotes. Without an explicit choice, `upstream` wins over
 * `origin`: in a fork, pull requests live in the parent repository.
 */
export function mapping(repo: RepoInfo, chosen: string | null): GitHubMapping {
	const byRepo = new Map<string, { repo: string; remotes: Array<string> }>()
	for (const r of repo.remotes) {
		if (!r.github) continue
		const key = r.github.toLowerCase()
		const entry = byRepo.get(key) ?? { repo: r.github, remotes: [] }
		entry.remotes.push(r.name)
		byRepo.set(key, entry)
	}
	const candidates = [...byRepo.values()]
	const pick = (name: string) => candidates.find((c) => c.remotes.includes(name))?.repo
	const valid = chosen && candidates.find((c) => c.repo === chosen)?.repo
	return {
		candidates,
		selected: valid || pick('upstream') || pick('origin') || candidates[0]?.repo || null,
		chosen: !!valid,
	}
}

/** Fetches from a configured remote for this GitHub repository (so the user's own Git credentials apply), else from its HTTPS URL. */
function fetchRemote(repo: RepoInfo, names: Array<string>): string {
	const want = names.filter(Boolean).map((n) => n.toLowerCase())
	return (
		repo.remotes.find((r) => r.github && want.includes(r.github.toLowerCase()))?.name ?? `https://github.com/${names.find(Boolean)}.git`
	)
}

function prHeadLabel(d: PrDetail): string {
	const branch = d.headRef ?? 'unknown'
	return d.crossRepo ? `${d.headOwner ?? 'deleted fork'}:${branch}` : branch
}

function historicalError(d: PrDetail, detail: string): AppFail {
	const kind = d.state === 'merged' ? 'merged' : d.state === 'closed' ? 'closed' : 'open'
	return new AppFail(
		'pr-unavailable',
		`The commits GitHub records for #${d.number} (base ${d.baseSha.slice(0, 7)}, head ${d.headSha.slice(0, 7)}) can no longer be fetched${kind === 'open' ? '' : ` now that it is ${kind}`}, so its original comparison cannot be reconstructed. ${detail} Open it on GitHub instead.`,
	)
}

function mb(n: number): string {
	return `${Math.round(n / 1024 / 1024)} MB`
}
