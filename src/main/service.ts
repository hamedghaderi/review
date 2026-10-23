import { lstat, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
	AppClone,
	AiRun,
	CarriedRun,
	FileCoverage,
	Finding,
	IncrementalOffer,
	OutcomeFilter,
	OutcomeSummary,
	BranchPr,
	CodeQuestion,
	PastDecision,
	EarlierLimitations,
	BranchPreview,
	BrowserState,
	CompareTarget,
	Comparison,
	Discussion,
	FileLinesResult,
	FindingLevel,
	GitHubMapping,
	LoadedComparison,
	ModelSelection,
	PatchResult,
	PrDescription,
	PrDetail,
	PrGraph,
	PrPage,
	PrQuery,
	RepoInfo,
	RepoSession,
	RepoTab,
	Review,
	ReviewComment,
	ReviewContext,
	ContextImage,
	ReviewEvent,
	ReviewerChoice,
	RunEstimate,
	ReviewRule,
	ReviewTarget,
	SearchSlot,
	Side,
	SymbolKind,
	StackedBase,
	SymbolLookup,
	TargetProbe,
} from '../shared/types.ts'
import { targetKey } from '../shared/types.ts'
import {
	aheadBehind,
	AppFail,
	cloneGitHub,
	compareBranches,
	compareCommits,
	changesBetween,
	compareSnapshot,
	ensureCommits,
	filesAt,
	findRoot,
	isAncestor,
	isManagedClone,
	setAppCloneRoots,
	mergeBase,
	ObjectUnavailable,
	readAt,
	readBlob,
	readPatch,
	readPatchBetween,
	readRepo,
	resolveBranchTarget,
	shortRef,
	type ComparisonData,
} from './git.ts'
import { errorOf, type GitHubService, type LinkedIssue } from './github.ts'
import { parsePatch, pickSection } from './patch.ts'
import { Publisher } from './publish.ts'
import { carryComments } from './carry.ts'
import { discussionOf, placeThreads } from './discussion.ts'
import { findRelated } from './ai/related.ts'
import { findImporters } from './ai/imports.ts'
import { MAX_EXAMPLE_CHARS } from './ai/reproduce.ts'
import { findSymbol } from './symbols.ts'
import { issueRefs } from './ai/background.ts'
import { ContextImages, isImageType } from './contextImages.ts'
import { loadFacts } from './ai/facts.ts'
import { summarizeOutcomes } from './ai/outcomes.ts'
import { createReviewTools } from './ai/lookup.ts'
import type { McpService } from './ai/mcp.ts'
import type { AiController, ComparisonAccess } from './ai/controller.ts'
import { CI_FAILED, CI_PASSED, tallyChecks, type HeadChecks } from '../shared/ci.ts'
import { readBaseChecks, type BaseChecks } from './baseCi.ts'
import { autoAddFindings, findingRoots } from '../shared/findings.ts'
import { screenFinding } from '../shared/screen.ts'
import { inboxStatus, requestCount, sortInbox, waitsForYou, type HomeInbox, type WatchedPr } from '../shared/inbox.ts'
import type { MyReview } from '../shared/prStack.ts'
import type { ReviewStore, StoreData } from './store.ts'
import { aiStartScope, anchor, reviewUpdate } from './validate.ts'
import { carryFindings, citersOfChangedFiles, mergeRechecks, planIncremental, trustGap, usersOfChangedNames } from './ai/incremental.ts'
import { findingBaseline, type Baseline } from './ai/history.ts'
import type { FileSource } from './ai/context.ts'

const PATCH_LIMIT = 1024 * 1024 // 1 MB of patch text renders normally
const PATCH_FORCE_LIMIT = 16 * 1024 * 1024
const CHANGED_LINES_LIMIT = 10_000
const FILE_LINES_LIMIT = 8 * 1024 * 1024
const PR_ATTEMPTS = 3
const MAX_EARLIER_LIMITATIONS = 12

function blobLines(buf: Buffer, truncated: boolean): FileLinesResult {
	if (truncated) return { kind: 'too-large', reason: `File exceeds ${mb(FILE_LINES_LIMIT)}` }
	if (buf.subarray(0, 8000).includes(0)) return { kind: 'binary' }
	const lines = buf.toString('utf8').split('\n')
	if (lines[lines.length - 1] === '') lines.pop()
	return { kind: 'text', lines: lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)) }
}

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
	private images: ContextImages
	private watched: { at: number; prs: Array<WatchedPr> } | null = null
	private ai: AiController | null = null
	private mcp: McpService | null = null
	private github: GitHubService | null
	private loadGen = 0
	private opening: AbortController | null = null
	private searching = new Map<SearchSlot, AbortController>()
	private publisher: Publisher | null
	private branchPrs = new Map<string, { at: number; value: BranchPr }>()
	private unseenComments = new Map<string, Set<string>>() // review id → comments an automatic review added
	private baseCi = new Map<string, BaseChecks | null>() // "repo@merge base" → its control, once every check there has finished

	constructor(store: ReviewStore, github: GitHubService | null = null) {
		this.store = store
		this.images = new ContextImages(join(store.dir, 'context-images'))
		this.github = github
		this.publisher = github && new Publisher(store, github, (reviewId, key) => this.hunksFor(reviewId, key))
	}

	/** The 3-line-context hunks GitHub shows for a file, or null when it has no text diff (binary, too large). */
	private async hunksFor(reviewId: string, fileKey: string) {
		const data = this.comparisons.get(reviewId)
		if (!data) throw new AppFail('not-found', 'Open this review before publishing it.')
		const stack = data.comparison.stackedOn
		if (!stack) {
			const p = await this.loadPatch(reviewId, fileKey, false)
			return p.kind === 'text' ? p.hunks : null
		}
		// GitHub diffs this PR from the merge base, not from the merged PR's last commit, so lines are placed on that diff.
		const { file } = this.file(reviewId, fileKey)
		if (file.binary || !file.newPath) return null
		const { text, truncated } = await readPatchBetween(
			data.root,
			stack.githubBaseSha,
			data.comparison.headSha,
			file.newPath,
			PATCH_FORCE_LIMIT,
		)
		if (truncated) return null
		const section = parsePatch(text).find((s) => !s.isDeleted)
		if (!section) return []
		if (section.binary) return null
		// Its old side is the code before the merged PR, which this comparison's old line numbers don't describe.
		return section.hunks.map((h) => ({ ...h, lines: h.lines.map((l) => ({ ...l, oldNo: null })) }))
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

	replyToThread(repoId: string, reviewId: string, threadId: string, body: string, resolve: boolean): Promise<void> {
		this.repo(repoId)
		const pr = this.store.read().repos[repoId]?.reviews[reviewId]?.pr
		if (!pr) throw new AppFail('not-found', 'Open this pull request review first.')
		return this.requireGitHub().replyToThread(pr.repo, pr.number, threadId, body, resolve)
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

	/**
	 * The checks GitHub reports now for the snapshot's head commit, so an approval can be weighed against CI that failed
	 * or has not finished. Read fresh each time; CI can fail after the review was opened.
	 */
	async headChecks(repoId: string, reviewId: string): Promise<HeadChecks> {
		const pr = this.openPrOf(repoId, reviewId)
		const { headSha, baseSha } = this.store.read().repos[repoId].reviews[reviewId]
		const gh = this.requireGitHub()
		const [head, base] = await Promise.all([
			gh.checks(pr.repo, headSha),
			// Failures are shown without the comparison when the base can't be read; never hidden.
			this.baseChecks(this.repo(repoId).root, pr.repo, baseSha).catch(() => null),
		])
		return tallyChecks(head, base)
	}

	/**
	 * The CI a head failure is compared with (see readBaseChecks). Kept once every check there has finished, since it
	 * can't change after that; read again otherwise.
	 */
	private async baseChecks(root: string, repo: string, mergeBase: string, signal?: AbortSignal): Promise<BaseChecks | null> {
		const key = `${repo}@${mergeBase}`
		if (this.baseCi.has(key)) return this.baseCi.get(key)!
		const gh = this.requireGitHub()
		const found = await readBaseChecks(root, mergeBase, (sha) => gh.checks(repo, sha, signal), signal)
		const settled = (r: string) => CI_FAILED.has(r) || CI_PASSED.has(r)
		if (found && found.checks.runs.every((r) => settled(r.result)) && found.checks.statuses.every((x) => settled(x.result)))
			this.baseCi.set(key, found)
		return found
	}

	/** The open PR review's description, read from GitHub each time (it can change without a new commit). */
	prDescription(repoId: string, reviewId: string): Promise<PrDescription> {
		const pr = this.openPrOf(repoId, reviewId)
		return this.requireGitHub().description(pr.repo, pr.number)
	}

	previewDescription(repoId: string, reviewId: string, text: string): Promise<string> {
		const pr = this.openPrOf(repoId, reviewId)
		return this.requireGitHub().renderMarkdown(pr.repo, text)
	}

	/**
	 * Saves a new description on GitHub, then gives it to this review's next AI run too: the run sends the loaded
	 * comparison's description, which would otherwise stay as it was when the review was opened.
	 */
	async updateDescription(repoId: string, reviewId: string, expected: string, body: string): Promise<PrDescription> {
		const pr = this.openPrOf(repoId, reviewId)
		const saved = await this.requireGitHub().updateDescription(pr.repo, pr.number, expected, body)
		const clipped = saved.body.slice(0, 8000)
		const loaded = this.comparisons.get(reviewId)?.comparison.pr
		if (loaded) loaded.body = clipped
		await this.store.update((d) => {
			const p = d.repos[repoId]?.reviews[reviewId]?.pr
			if (p) p.body = clipped
		})
		return saved
	}

	private openPrOf(repoId: string, reviewId: string): { repo: string; number: number } {
		this.repo(repoId)
		const pr = this.store.read().repos[repoId]?.reviews[reviewId]?.pr
		if (!pr) throw new AppFail('not-found', 'Open this pull request review first.')
		return pr
	}

	/**
	 * What a PR review's reviewer is told besides the description: the issues the PR closes or its description mentions,
	 * and the conversation so far. Either part failing becomes a note; the run goes on with what could be read.
	 */
	private async prBackground(
		repoId: string,
		reviewId: string,
		signal: AbortSignal,
	): Promise<{ issues: Array<LinkedIssue>; discussion: Discussion | null; notes: Array<string> }> {
		const pr = this.comparisons.get(reviewId)?.comparison.pr
		const gh = this.github
		if (!pr || !gh) return { issues: [], discussion: null, notes: [] }
		const notes: Array<string> = []
		const [issues, discussion] = await Promise.all([
			gh.linkedIssues(pr.repo, pr.number, issueRefs(pr.body ?? '', pr.repo, pr.number), signal).catch((e) => {
				if (signal.aborted) throw e
				notes.push(`Linked issues could not be read from GitHub, so the reviewer did not see them: ${errorOf(e).message}`)
				return []
			}),
			this.prDiscussion(repoId, reviewId),
		])
		if (discussion.status === 'unavailable')
			notes.push(`The PR conversation was not sent to the reviewer. ${discussion.reason ?? ''}`.trim())
		return { issues, discussion, notes }
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
			if (!d.openRepoIds?.includes(repo.id)) d.openRepoIds = [...(d.openRepoIds ?? []), repo.id]
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

	/** Stores an image for a review's context; the bytes are checked here, whatever the renderer claims. */
	async addContextImage(name: string, bytes: Uint8Array): Promise<ContextImage> {
		const stored = await this.images.add(bytes)
		return { ...stored, name: name.trim().slice(0, 255) || 'image', addedAt: new Date().toISOString() }
	}

	async contextImage(id: string, mediaType: unknown): Promise<string> {
		if (!isImageType(mediaType)) throw new AppFail('invalid-input', 'Invalid image type.')
		return `data:${mediaType};base64,${(await this.images.read(id, mediaType)).toString('base64')}`
	}

	/** Closes a repository's tab; the repository stays known (reviews, notifications). Returns the tabs left. */
	async closeTab(repoId: string): Promise<Array<RepoTab>> {
		await this.store.update((d) => {
			d.openRepoIds = (d.openRepoIds ?? []).filter((id) => id !== repoId)
			// A closed repository is never what the next start restores; that is another tab, or the empty state.
			if (d.lastRepoId === repoId) d.lastRepoId = d.openRepoIds[0] ?? null
		})
		return this.tabs()
	}

	tabs(): Array<RepoTab> {
		const d = this.store.read()
		// The background check stores what it last saw; while it is off (disconnected, notifications off) that is stale.
		const gh = this.github
		const watch = gh && gh.notifications.enabled && gh.status().state === 'connected' ? d.inboxWatch?.state : undefined
		return (d.openRepoIds ?? []).flatMap((id) => {
			const s = d.repos[id]
			if (!s) return []
			const repo = s.githubRepo ?? s.githubResolved
			return [{ id, name: basename(s.root), root: s.root, requests: watch && repo ? requestCount(watch, repo) : null }]
		})
	}

	/** GitHub repositories ("owner/name", lower case) of every repository opened in the app, mapped to their ids. */
	knownGitHubRepos(): Map<string, string> {
		const out = new Map<string, string>()
		const repos = Object.values(this.store.read().repos)
		// A clone you opened yourself wins over the app's own clone of the same repository.
		for (const s of [...repos.filter((r) => isManagedClone(r.root)), ...repos.filter((r) => !isManagedClone(r.root))]) {
			const gh = s.githubRepo ?? s.githubResolved
			if (gh) out.set(gh.toLowerCase(), s.repoId)
		}
		return out
	}

	/**
	 * Opens a GitHub repository ("owner/name") without a clone of your own: the app clones it into `parent`/name (with
	 * the GitHub token, for private repositories), remembers the clone as its own so it can be deleted here, and opens it
	 * like any other. A clone the app already knows is opened instead.
	 */
	async openGitHubClone(repo: string, parent: string, signal?: AbortSignal): Promise<RepoSession> {
		const known = this.knownGitHubRepos().get(repo.toLowerCase())
		if (known) return this.openKnown(known)
		const { root, created } = await cloneGitHub(repo, parent, signal)
		await this.store.update((d) => {
			d.cloneParent = parent
			if (created) (d.appClones ??= {})[root] = { repo, at: new Date().toISOString() }
		})
		setAppCloneRoots(Object.keys(this.store.read().appClones ?? {}))
		return this.open(root)
	}

	/** The folders the app cloned itself, with their size on disk. */
	async appClones(): Promise<Array<AppClone>> {
		const d = this.store.read()
		const byRoot = new Map(Object.values(d.repos).map((r) => [r.root, r.repoId]))
		return Promise.all(
			Object.entries(d.appClones ?? {}).map(async ([root, c]) => ({
				repoId: byRoot.get(root) ?? root,
				repo: c.repo,
				root,
				at: c.at,
				missing: !(await exists(root)),
				bytes: await folderSize(root).catch(() => null),
			})),
		)
	}

	/**
	 * Deletes one of the app's own clones: `trash` moves the folder to the Trash first, so nothing is forgotten if that
	 * fails; then the app forgets the repository, with its reviews. Folders you cloned yourself are never deleted.
	 */
	async deleteAppClone(repoId: string, trash: (path: string) => Promise<void>): Promise<Array<RepoTab>> {
		const d = this.store.read()
		const root = d.repos[repoId]?.root ?? repoId
		if (!d.appClones?.[root]) throw new AppFail('invalid-input', 'That folder was not cloned by the app, so it is not deleted here.')
		// Already gone (deleted by hand): there is nothing to move, only the app's record of it to forget.
		if (await exists(root)) await trash(root)
		this.repos.delete(repoId)
		await this.store.update((d) => {
			delete d.repos[repoId]
			delete d.appClones![root]
			d.openRepoIds = (d.openRepoIds ?? []).filter((id) => id !== repoId)
			if (d.lastRepoId === repoId) d.lastRepoId = d.openRepoIds[0] ?? null
		})
		setAppCloneRoots(Object.keys(this.store.read().appClones ?? {}))
		return this.tabs()
	}

	/** One of the app's own clones: its folder, GitHub repository, and whether the folder is still there. */
	async appCloneOf(repoId: string): Promise<{ root: string; repo: string; missing: boolean }> {
		const d = this.store.read()
		const root = d.repos[repoId]?.root ?? repoId
		const c = d.appClones?.[root]
		if (!c) throw new AppFail('not-found', 'That folder was not cloned by the app.')
		return { root, repo: c.repo, missing: !(await exists(root)) }
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
			} else if (target.target.kind === 'commits') {
				const t = target.target
				data = await compareCommits(this.repo(repoId), t.from, t.to, t.mergeBase)
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
		const context = target.kind === 'target' ? this.carriedContext(repoId, c, target.from ?? null) : null
		if (gen !== this.loadGen) throw new AppFail('cancelled', 'A newer review was opened.')
		if (carry?.notice) notice = notice ? `${notice} ${carry.notice}` : carry.notice
		await this.saveSnapshot(repoId, c, carry, context, true)
		return {
			comparison: c,
			review: this.store.read().repos[repoId].reviews[c.id],
			aiRuns: this.ai?.runsFor(repoId, c.id) ?? [],
			notice,
		}
	}

	/**
	 * Opens a pull request for an automatic review without touching what is on screen: no open request is superseded,
	 * no run is cancelled and the repository's active review stays as it is. Comments carry over as when you open it.
	 */
	async openInBackground(repoId: string, pr: { repo: string; number: number }, signal: AbortSignal): Promise<Comparison> {
		if (!this.repos.has(repoId)) {
			const s = this.store.read().repos[repoId]
			if (!s) throw new AppFail('not-found', 'That repository is not known to the app. Open it first.')
			this.repos.set(repoId, await readRepo(s.root))
		}
		const { data } = await this.openPr(repoId, { kind: 'pr', repo: pr.repo, number: pr.number }, signal)
		const c = data.comparison
		this.comparisons.set(c.id, data)
		await this.saveSnapshot(repoId, c, await this.carry(repoId, data, null), this.carriedContext(repoId, c, null), false)
		return c
	}

	/** Starts an automatic review's run; it keeps going when you open other reviews. */
	startAutoAi(reviewId: string, choice: ReviewerChoice, label: string): Promise<AiRun> {
		const { ai, access } = this.aiAccess(reviewId)
		return ai.start(access, reviewId, { kind: 'all' }, choice, { background: label })
	}

	/**
	 * Starts an automatic review's run on new commits: only the files whose diff changed since the newest finished run,
	 * carrying that run's results for the rest. Returns why not when nothing can be carried or nothing changed.
	 */
	async startAutoIncremental(reviewId: string, choice: ReviewerChoice, label: string): Promise<AiRun | { refused: string }> {
		const plan = await this.incrementalPlan(reviewId, choice)
		if (!plan) return { refused: 'There is no earlier run to build on.' }
		if (plan.offer.refused !== null) return { refused: plan.offer.refused }
		if (!plan.offer.review.length) return { refused: `No file's diff changed since ${plan.offer.from.headSha.slice(0, 7)}.` }
		const { ai, access } = this.aiAccess(reviewId)
		return ai.start(access, reviewId, { kind: 'files', fileKeys: plan.offer.review }, choice, {
			background: label,
			carried: { from: plan.offer.from, files: plan.files, findings: plan.findings, recheck: plan.offer.recheck },
		})
	}

	/**
	 * Adds a finished automatic run's findings at `levels` to the stored review as comments and returns their ids. They
	 * are kept through the window's saves until it has seen them, so a review open on screen can't drop them. Carried
	 * findings are left out: the earlier review already posted them, or left them for a person on purpose.
	 */
	async addAutoFindings(repoId: string, reviewId: string, runId: string, levels: ReadonlyArray<FindingLevel>): Promise<Array<string>> {
		let ids: Array<string> = []
		await this.store.update((d) => {
			const repo = d.repos[repoId]
			const r = repo?.reviews[reviewId]
			const runs = repo?.aiRuns[reviewId] ?? []
			const run = runs.find((x) => x.id === runId)
			if (!r || !run) return
			// Nobody reads these before they go out: a finding whose text needs a person stays in the app.
			const res = autoAddFindings(
				r,
				run,
				runs,
				findingRoots(runs),
				levels,
				(f) => !!f.carried || screenFinding(f, r.pr?.repo ?? null).length > 0,
			)
			if (!res.added) return
			r.comments = res.review.comments
			r.findingDecisions = res.review.findingDecisions
			r.updatedAt = new Date().toISOString()
			ids = res.commentIds
		})
		if (ids.length) {
			const unseen = this.unseenComments.get(reviewId) ?? new Set()
			for (const id of ids) unseen.add(id)
			this.unseenComments.set(reviewId, unseen)
		}
		return ids
	}

	/** Stores a comparison's review (created on first open, else updated with carried comments). */
	private async saveSnapshot(
		repoId: string,
		c: Comparison,
		carry: { comments: Array<ReviewComment> } | null,
		context: ReviewContext | null,
		activate: boolean,
	): Promise<void> {
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
					...(c.stackedOn ? { stackedOn: c.stackedOn } : {}),
					createdAt: now,
					updatedAt: now,
					comments: carry?.comments ?? [],
					drafts: [],
					viewed: [],
					findingDecisions: {},
					...(carry?.comments.length ? { carriedOrigins: carry.comments.map((x) => x.carried!.originId) } : {}),
					...(context ? { context } : {}),
				}
			}
			if (activate) s.activeReviewId = c.id
		})
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

	/** The context you gave the reviewer, copied into a new snapshot from the one it replaces (as comments are). */
	private carriedContext(repoId: string, c: Comparison, from: string | null): ReviewContext | null {
		const reviews = this.store.read().repos[repoId]?.reviews ?? {}
		if (reviews[c.id]) return null
		const src = (from && from !== c.id ? reviews[from] : undefined) ?? this.predecessor(repoId, c, Object.values(reviews))
		return src?.context ? structuredClone(src.context) : null
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

	/**
	 * What the newest finished run of this comparison's target (the same pull request, else the same branch) could not
	 * settle, so the next run settles it first. Fixture runs and runs that settled everything give nothing.
	 */
	private earlierLimitations(repoId: string, c: Comparison): EarlierLimitations | null {
		const repo = this.store.read().repos[repoId]
		if (!repo) return null
		const key = targetKey(targetOf(c))
		const runs = Object.values(repo.reviews)
			.filter((r) => r.id === c.id || targetKey(targetOf(r)) === key)
			.flatMap((r) => repo.aiRuns[r.id] ?? [])
			.filter((run) => (run.status === 'completed' || run.status === 'partial') && !run.fixture && run.finishedAt)
			.sort((a, b) => b.finishedAt!.localeCompare(a.finishedAt!))
		const last = runs[0]
		return last?.limitations.length
			? { runId: last.id, headSha: last.headSha, items: last.limitations.slice(0, MAX_EARLIER_LIMITATIONS) }
			: null
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
		const stack = await this.stackedBase(repo.root, fetchRemote(repo, [d.repo, t.repo]), t, d, baseSha, signal)
		const data = await compareSnapshot(repo.root, {
			repoId,
			baseRef: d.baseRef ?? 'base',
			baseTipSha: d.baseSha,
			baseSha: stack && 'base' in stack ? stack.base : baseSha,
			...(stack && 'base' in stack ? { stackedOn: stack.stackedOn } : {}),
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
				author: d.author,
				authorAssociation: d.authorAssociation ?? null,
			},
		})
		const notes = [
			changed
				? `#${d.number} was updated while it was loading. Showing the latest consistent version (head ${d.headSha.slice(0, 7)}).`
				: null,
			stack && 'base' in stack
				? `#${d.number} was stacked on #${stack.stackedOn.number}, which was squash- or rebase-merged into ${d.baseRef ?? 'its base'}. Showing only #${d.number}’s own changes, compared with #${stack.stackedOn.number}’s last commit (${stack.base.slice(0, 7)}). GitHub’s diff of #${d.number} still includes #${stack.stackedOn.number}’s changes.`
				: (stack?.note ?? null),
		].filter(Boolean)
		return { data, notice: notes.length ? notes.join(' ') : null }
	}

	/**
	 * When this pull request was stacked on another that was then squash- or rebase-merged, its base branch has that
	 * PR's changes as new commits, so merge-base..head would show them again. Returns the merged PR's last commit that
	 * this one contains, to compare with instead. Null when the merge base is right: the merged PR landed as a merge
	 * commit, or this PR has since merged or been rebased onto its base. A failed lookup never stops the review from
	 * opening; it gives the usual comparison and a note.
	 */
	private async stackedBase(
		root: string,
		remote: string,
		t: { repo: string; number: number },
		d: { baseSha: string; headSha: string; baseRef: string | null },
		normal: string,
		signal: AbortSignal,
	): Promise<{ base: string; stackedOn: StackedBase } | { note: string } | null> {
		let parent: Awaited<ReturnType<GitHubService['mergedStackParent']>>
		try {
			parent = await this.requireGitHub().mergedStackParent(t.repo, t.number, signal)
		} catch (e) {
			if (signal.aborted) throw e
			return {
				note: `Could not check whether #${t.number} was stacked on a merged pull request (${errorOf(e).message}), so it is compared with the merge base and may show that pull request’s changes too.`,
			}
		}
		if (!parent) return null
		try {
			await ensureCommits(root, remote, [parent.headSha, parent.mergeCommit], signal)
			// Landed as a merge commit, or this PR already merged its base since: the merge base is right.
			if (await isAncestor(root, parent.mergeCommit, normal)) return null
			// Landed on some other branch than this PR's base.
			if (!(await isAncestor(root, parent.mergeCommit, d.baseSha))) return null
			const base = await mergeBase(root, parent.headSha, d.headSha, `#${t.number}`, `#${parent.number}`)
			// Rebased onto its base since, so it no longer contains the merged PR's commits.
			if (base === normal || !(await isAncestor(root, normal, base))) return null
			return { base, stackedOn: { ...parent, githubBaseSha: normal } }
		} catch (e) {
			if (signal.aborted) throw e
			return {
				note: `#${t.number} was stacked on #${parent.number}, which was merged, but its last commit could not be read (${errorOf(e).message}), so #${parent.number}’s changes may show here too.`,
			}
		}
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
				// The base branch's tip moving (a busy main) leaves merge-base..head as it was; only a retarget changes the diff.
				const base = !!stored.pr && (d.baseRef ?? '') !== stored.pr.baseRef
				const summary = head ? `New head ${d.headSha.slice(0, 7)}` : base ? `Retargeted to ${d.baseRef}` : null
				return { repo: null, changed: head || base, summary, error: null }
			}
			// Pinned to the SHAs it was opened with: there is nothing newer to update to.
			if (target.kind === 'commits') return { repo: null, changed: false, summary: null, error: null }
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

	/**
	 * Every pull request waiting for you, in every repository, from the background check's last look. Reads only the
	 * store, so it is free to call often.
	 */
	/** What became of AI findings in every repository's reviews: read from the store, nothing is fetched. */
	outcomes(filter: OutcomeFilter): OutcomeSummary {
		return summarizeOutcomes(Object.values(this.store.read().repos), filter)
	}

	homeInbox(): HomeInbox {
		const d = this.store.read()
		const gh = this.github
		if (!gh || gh.status().state !== 'connected') return { state: 'disconnected', at: null, prs: [] }
		const watch = d.inboxWatch
		const login = gh.status().login
		// Another account's last look says nothing about this one.
		if (!watch?.prs || (login && watch.login && watch.login.toLowerCase() !== login.toLowerCase()))
			return { state: 'ready', at: null, prs: [] }
		const known = this.knownGitHubRepos()
		const muted = new Set(d.mutedRepos ?? [])
		return {
			state: 'ready',
			at: watch.at,
			prs: watch.prs.filter(waitsForYou).map((p) => ({
				...p,
				repoId: known.get(p.repo.toLowerCase()) ?? null,
				muted: muted.has(p.repo.toLowerCase()),
				appClone: isManagedClone(d.repos[known.get(p.repo.toLowerCase()) ?? '']?.root ?? ''),
			})),
		}
	}

	async setRepoMuted(repo: string, muted: boolean): Promise<HomeInbox> {
		const key = repo.toLowerCase()
		await this.store.update((d) => {
			const rest = (d.mutedRepos ?? []).filter((r) => r !== key)
			d.mutedRepos = muted ? [...rest, key] : rest
		})
		return this.homeInbox()
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

	/**
	 * Where you stand on each open PR of this repository that involves you, by number: your review is wanted (requested,
	 * or new commits since you reviewed) or you're up to date. From the same two searches the notification check runs,
	 * shared across repositories and cached briefly. Null without a GitHub token.
	 */
	/** Review requests changed (seen by the background check): the next myReviews asks GitHub again. */
	forgetMyReviews(): void {
		this.watched = null
	}

	async myReviews(repoId: string): Promise<Record<number, MyReview> | null> {
		const gh = this.github
		const repo = mapping(this.repo(repoId), this.store.read().repos[repoId]?.githubRepo ?? null).selected
		if (!gh || !repo) return null
		if (!this.watched || Date.now() - this.watched.at > MY_REVIEWS_TTL_MS) {
			const r = await gh.watchRequests()
			if (!r) return null
			this.watched = { at: Date.now(), prs: r.prs }
		}
		return myReviewsIn(this.watched.prs, repo)
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
		return blobLines(buf, truncated)
	}

	/** Any file at the head commit (base for `side: 'old'`), for the read-only view of files outside the change. */
	async loadFileAt(comparisonId: string, path: string, side: Side): Promise<FileLinesResult> {
		const data = this.loaded(comparisonId)
		const sha = side === 'old' ? data.comparison.baseSha : data.comparison.headSha
		const r = await readAt(data.root, sha, path, FILE_LINES_LIMIT)
		if (!r) throw new AppFail('not-found', `${path} is not in the ${side === 'old' ? 'base' : 'head'} commit.`)
		return blobLines(r.buf, r.truncated)
	}

	/** Which of `paths` (from file references in a finding's text) are files at the head commit. */
	async filesAtHead(comparisonId: string, paths: Array<string>): Promise<Array<string>> {
		const data = this.loaded(comparisonId)
		return [...(await filesAt(data.root, data.comparison.headSha, paths))]
	}

	/** Go to definition and find uses: text matches at one commit, with the lines this change touched marked. */
	async lookupSymbol(comparisonId: string, name: string, side: Side, kind: SymbolKind): Promise<SymbolLookup> {
		const data = this.loaded(comparisonId)
		const c = data.comparison
		const found = await findSymbol(data.root, side === 'old' ? c.baseSha : c.headSha, name, side, kind)
		const byPath = new Map(
			c.files.flatMap((f) => ((side === 'old' ? f.oldPath : f.newPath) ? [[(side === 'old' ? f.oldPath : f.newPath)!, f]] : [])),
		)
		const changed = new Map<string, Set<number>>() // file key → the lines it added (head) or removed (base)
		for (const h of found.hits) {
			const f = byPath.get(h.path)
			if (!f) continue
			h.fileKey = f.key
			if (!changed.has(f.key)) {
				const p = await this.loadPatch(comparisonId, f.key, false).catch(() => null)
				const lines = p?.kind === 'text' ? p.hunks.flatMap((x) => x.lines) : []
				changed.set(
					f.key,
					new Set(lines.flatMap((l) => (side === 'old' ? (l.kind === 'del' ? [l.oldNo!] : []) : l.kind === 'add' ? [l.newNo!] : []))),
				)
			}
			h.inDiff = changed.get(f.key)!.has(h.line)
		}
		return found
	}

	async saveReview(input: unknown): Promise<{ savedAt: string }> {
		const o = input as Partial<Review> | null
		const repoId = typeof o?.repoId === 'string' ? o.repoId : ''
		const id = typeof o?.id === 'string' ? o.id : ''
		const stored = this.store.read().repos[repoId]?.reviews[id]
		if (!stored || !this.repos.has(repoId)) throw new AppFail('not-found', 'This review is not open.')
		const next = reviewUpdate(input, stored, findingRoots(this.ai?.runsFor(repoId, id) ?? []))
		// Comments an automatic review added that this window has not loaded yet stay; once it saves them, it owns them.
		const unseen = this.unseenComments.get(id)
		if (unseen) {
			for (const c of next.comments) unseen.delete(c.id)
			next.comments.push(...stored.comments.filter((c) => unseen.has(c.id)))
			if (!unseen.size) this.unseenComments.delete(id)
		}
		for (const i of next.context?.images ?? [])
			if (!this.images.has(i.id, i.mediaType)) throw new AppFail('invalid-input', `The image “${i.name}” is not stored; add it again.`)
		const savedAt = new Date().toISOString()
		await this.store.update((d) => {
			Object.assign(d.repos[repoId].reviews[id], next, { updatedAt: savedAt })
		})
		return { savedAt }
	}

	async startAi(reviewId: string, scopeInput: unknown, selection: ModelSelection | ReviewerChoice, overBudget = false): Promise<AiRun> {
		const { ai, access } = this.aiAccess(reviewId)
		const scope = aiStartScope(scopeInput, new Set(access.comparison.files.map((f) => f.key)))
		if (scope.kind !== 'changed') return ai.start(access, reviewId, scope, selection, { overBudget })
		const choice: ReviewerChoice = 'kind' in selection ? selection : { kind: 'model', selection }
		const plan = await this.incrementalPlan(reviewId, choice)
		// The offer was made when the dialog opened; a run that finished since, or a changed setting, can withdraw it.
		if (!plan || plan.offer.refused !== null)
			throw new AppFail('invalid-input', `${plan?.offer.refused ?? 'There is no earlier run to build on.'} Review all files instead.`)
		return ai.start(access, reviewId, { kind: 'files', fileKeys: plan.offer.review }, choice, {
			carried: { from: plan.offer.from, files: plan.files, findings: plan.findings, recheck: plan.offer.recheck },
			overBudget,
		})
	}

	/** What a run would send and cost; the changed-files scope estimates the files the incremental run would send. */
	async estimateAi(reviewId: string, choice: ReviewerChoice, scopeInput: unknown): Promise<RunEstimate> {
		const { ai, access } = this.aiAccess(reviewId)
		const scope = aiStartScope(scopeInput, new Set(access.comparison.files.map((f) => f.key)))
		if (scope.kind !== 'changed') return ai.estimate(access, scope, choice)
		const plan = await this.incrementalPlan(reviewId, choice)
		if (!plan || plan.offer.refused !== null) return ai.estimate(access, { kind: 'all' }, choice)
		const carried = new Set(plan.files.filter((f) => f.state === 'carried').map((f) => f.fileKey))
		return ai.estimate(access, { kind: 'files', fileKeys: plan.offer.review }, choice, carried)
	}

	/** Whether a run with `choice` can review only the files whose diff changed since the newest finished run. */
	async incrementalOffer(reviewId: string, choice: ReviewerChoice): Promise<IncrementalOffer | null> {
		return (await this.incrementalPlan(reviewId, choice))?.offer ?? null
	}

	/**
	 * The newest finished run of this review's pull request or branch, when it is on an earlier snapshot, and what a run
	 * with `choice` would carry from it. Null when there is none, or when this snapshot already has a newer finished run.
	 */
	private async incrementalPlan(
		reviewId: string,
		choice: ReviewerChoice,
	): Promise<{ offer: IncrementalOffer; files: Array<FileCoverage>; findings: Array<Finding> } | null> {
		const { ai } = this.aiAccess(reviewId)
		const data = this.loaded(reviewId)
		const c = data.comparison
		const repo = this.store.read().repos[c.repoId]
		const earlier = this.finishedRuns(c)[0]
		if (!earlier || earlier.reviewId === c.id) return null
		const from: CarriedRun = { runId: earlier.id, reviewId: earlier.reviewId, headSha: earlier.headSha }
		const print = ai.reviewerPrint(choice)
		const gap = print ? trustGap(earlier, print) : 'That review team no longer exists.'
		if (gap) return { offer: { from, refused: gap }, files: [], findings: [] }
		let before: Awaited<ReturnType<typeof changesBetween>>
		try {
			before = await changesBetween(data.root, earlier.baseSha, earlier.headSha, false)
		} catch {
			return {
				offer: { from, refused: `The commits the run on ${from.headSha.slice(0, 7)} reviewed are no longer in this clone.` },
				files: [],
				findings: [],
			}
		}
		const planned = planIncremental(earlier, from, before, { files: c.files, blobs: data.blobs })
		const since = await this.changedSince(data, earlier.headSha, planned.review)
		const carried = planned.carry.filter((f) => f.state === 'carried').map((f) => f.fileKey)
		const recheck = mergeRechecks(
			usersOfChangedNames(
				since,
				await Promise.all(
					carried.map(async (fileKey) => ({
						fileKey,
						patch: await this.loadPatch(reviewId, fileKey, false).catch((): PatchResult => ({ kind: 'binary' })),
					})),
				),
			),
			citersOfChangedFiles(
				earlier.findings,
				carried,
				since.map((s) => s.file),
			),
		)
		const again = new Set(recheck.map((r) => r.fileKey))
		const review = c.files.map((f) => f.key).filter((k) => planned.review.includes(k) || again.has(k))
		const kept = planned.carry.filter((f) => !again.has(f.fileKey))
		const carry = kept.filter((f) => f.state === 'carried').map((f) => f.fileKey)
		if (!carry.length)
			return { offer: { from, refused: `Every file changed since the run on ${from.headSha.slice(0, 7)}.` }, files: [], findings: [] }
		const earlierReview = repo.reviews[earlier.reviewId]
		return {
			offer: { from, review, carry, recheck, refused: null },
			files: kept,
			findings: carryFindings(earlier, from, earlierReview, repo.aiRuns[earlier.reviewId] ?? [], kept, c),
		}
	}

	/** Finished runs of every snapshot of the comparison's pull request or branch, newest first. */
	private finishedRuns(c: Comparison): Array<AiRun> {
		const repo = this.store.read().repos[c.repoId]
		const key = targetKey(targetOf(c))
		return Object.values(repo.reviews)
			.filter((r) => r.id === c.id || targetKey(targetOf(r)) === key)
			.flatMap((r) => repo.aiRuns[r.id] ?? [])
			.filter((run) => (run.status === 'completed' || run.status === 'partial') && run.finishedAt)
			.sort((a, b) => b.finishedAt!.localeCompare(a.finishedAt!))
	}

	/**
	 * What a run on this snapshot is compared with: the newest finished run on a snapshot opened before it (or `pinned`),
	 * with its findings moved here. Null when there is none, or when its commits are no longer in this clone.
	 */
	private async findingBaseline(reviewId: string, pinned: CarriedRun | null): Promise<Baseline | null> {
		const data = this.loaded(reviewId)
		const c = data.comparison
		const repo = this.store.read().repos[c.repoId]
		const opened = repo.reviews[c.id]?.createdAt
		const earlier = pinned
			? repo.aiRuns[pinned.reviewId]?.find((r) => r.id === pinned.runId)
			: this.finishedRuns(c).find((r) => r.reviewId !== c.id && !!opened && repo.reviews[r.reviewId]?.createdAt < opened)
		const review = earlier && repo.reviews[earlier.reviewId]
		if (!earlier || !review) return null
		try {
			return await findingBaseline(data.root, earlier, review, repo.aiRuns[earlier.reviewId] ?? [], c)
		} catch {
			return null
		}
	}

	/**
	 * Each of `keys`' diff between `since` and the comparison's head: what changed in those files after the earlier run.
	 * A diff too large to read, or one that can't be read, is left out.
	 */
	private async changedSince(data: ComparisonData, since: string, keys: Array<string>): Promise<Array<FileSource>> {
		const out: Array<FileSource> = []
		for (const key of keys) {
			const file = data.comparison.files.find((x) => x.key === key)
			const path = file?.newPath ?? file?.oldPath
			if (!file || !path || file.binary) continue
			const r = await readPatchBetween(data.root, since, data.comparison.headSha, path, PATCH_LIMIT).catch(() => null)
			const section = r && !r.truncated ? parsePatch(r.text)[0] : undefined
			if (section && !section.binary)
				out.push({ file, patch: { kind: 'text', hunks: section.hunks, bytes: r!.text.length }, fullText: null })
		}
		return out
	}

	async retryAiRules(reviewId: string, runId: string, rules: Array<ReviewRule>): Promise<AiRun> {
		const { ai, access } = this.aiAccess(reviewId)
		return ai.retryRules(access, reviewId, runId, rules)
	}

	async askFinding(reviewId: string, findingId: string, question: string, model: ModelSelection | null): Promise<AiRun> {
		const { ai, access } = this.aiAccess(reviewId)
		return ai.ask(access, reviewId, findingId, question, model)
	}

	/** Up to two tests that import the changed file, read at the head commit, as examples for a test the AI writes. */
	private async testExamples(data: ComparisonData, fileKey: string): Promise<Array<{ path: string; text: string }>> {
		const file = data.comparison.files.find((f) => f.key === fileKey)
		if (!file) return []
		const [traced] = await findImporters(data.root, data.comparison.headSha, [{ file, patch: { kind: 'binary' }, fullText: null }])
		const out: Array<{ path: string; text: string }> = []
		for (const path of (traced?.tests ?? []).slice(0, 2)) {
			const r = await readAt(data.root, data.comparison.headSha, path, MAX_EXAMPLE_CHARS * 4)
			if (!r) continue
			const text = r.buf.toString('utf8')
			out.push({ path, text: text.length > MAX_EXAMPLE_CHARS ? `${text.slice(0, MAX_EXAMPLE_CHARS)}\n… (cut)` : text })
		}
		return out
	}

	async writeTest(reviewId: string, findingId: string, model: ModelSelection | null): Promise<AiRun> {
		const { ai, access } = this.aiAccess(reviewId)
		return ai.writeTest(access, reviewId, findingId, model)
	}

	async verifyFinding(reviewId: string, findingId: string, model: ModelSelection | null): Promise<AiRun> {
		const { ai, access } = this.aiAccess(reviewId)
		return ai.verify(access, reviewId, findingId, model)
	}

	/** Asks whether a finding the newest run did not raise again is still in the code; see AiController.checkFixed. */
	async checkFixed(reviewId: string, runId: string, findingId: string, model: ModelSelection | null): Promise<AiRun> {
		const { ai, access } = this.aiAccess(reviewId)
		return ai.checkFixed(access, reviewId, runId, findingId, model)
	}

	async askCode(
		reviewId: string,
		anchorInput: unknown,
		question: string,
		questionId: string | null,
		selection: ModelSelection,
	): Promise<Array<CodeQuestion>> {
		const { ai, access } = this.aiAccess(reviewId)
		const stored = this.store.read().repos[access.comparison.repoId].reviews[reviewId]
		return ai.askCode(access, reviewId, anchor(anchorInput, stored), question, questionId, selection)
	}

	async deleteCodeQuestion(reviewId: string, questionId: string): Promise<Array<CodeQuestion>> {
		const { ai, access } = this.aiAccess(reviewId)
		return ai.deleteCodeQuestion(access.comparison.repoId, reviewId, questionId)
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
				testExamples: (fileKey) => this.testExamples(data, fileKey),
				pastDecisions: () => this.pastDecisions(repoId, data.comparison),
				earlierLimitations: () => this.earlierLimitations(repoId, data.comparison),
				findingBaseline: (pinned) => this.findingBaseline(reviewId, pinned),
				tools: (budget, external) =>
					createReviewTools({ root: data.root, baseSha: data.comparison.baseSha, headSha: data.comparison.headSha }, budget, external),
				openExternal: this.mcp ? (signal) => this.mcp!.open(data.root, signal) : undefined,
				loadBackground: data.comparison.pr ? (signal) => this.prBackground(repoId, reviewId, signal) : undefined,
				reviewContext: () => this.store.read().repos[repoId]?.reviews[reviewId]?.context ?? null,
				contextImages: async () => {
					const list = this.store.read().repos[repoId]?.reviews[reviewId]?.context?.images ?? []
					return Promise.all(
						list.map(async (i) => ({
							name: i.name,
							mediaType: i.mediaType,
							data: (await this.images.read(i.id, i.mediaType)).toString('base64'),
						})),
					)
				},
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
						baseChecks: gh && repo ? () => this.baseChecks(data.root, repo, c.baseSha, signal) : null,
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

	private loaded(comparisonId: string): ComparisonData {
		const data = this.comparisons.get(comparisonId)
		if (!data) throw new AppFail('not-found', 'That comparison is not loaded.')
		return data
	}

	private file(comparisonId: string, fileKey: string) {
		const data = this.loaded(comparisonId)
		const file = data.comparison.files.find((f) => f.key === fileKey)
		if (!file) throw new AppFail('not-found', 'That file is not part of this comparison.')
		return { data, file }
	}

	private session(repo: RepoInfo): RepoSession {
		const s = (this.store.read() as StoreData).repos[repo.id]
		return {
			repo,
			tabs: this.tabs(),
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
		...(r.stackedOn ? { stackedOn: r.stackedOn } : {}),
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

const MY_REVIEWS_TTL_MS = 120_000

/** Your status per PR number in one repository, from the requested and reviewed searches. */
export function myReviewsIn(prs: ReadonlyArray<WatchedPr>, repo: string): Record<number, MyReview> {
	const out: Record<number, MyReview> = {}
	for (const p of prs) {
		if (p.repo.toLowerCase() !== repo.toLowerCase()) continue
		if (p.requested !== false || p.stale) out[p.number] = 'needs-you'
		else if (p.reviewed) out[p.number] = p.verdict === 'approved' || p.verdict === 'changes-requested' ? p.verdict : 'commented'
	}
	return out
}

function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	)
}

/** Bytes in a folder and everything under it; links are counted, not followed. */
async function folderSize(dir: string): Promise<number> {
	let total = 0
	for (const e of await readdir(dir, { withFileTypes: true })) {
		const p = join(dir, e.name)
		total += e.isDirectory() ? await folderSize(p) : (await lstat(p)).size
	}
	return total
}
