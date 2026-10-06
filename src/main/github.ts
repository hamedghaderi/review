import { buildSearch, FILTER_NEEDS_LOGIN, parsePrQuery } from '../shared/prQuery.ts'
import { watchKey, type WatchedPr } from '../shared/inbox.ts'
import type {
	AppError,
	CiAnnotation,
	CredentialState,
	CredentialStorageInfo,
	GitHubStatus,
	NotificationPrefs,
	PrDetail,
	PrGraph,
	PrGraphNode,
	PrPage,
	PrQuery,
	PrState,
	PrReviewer,
	PrReviewState,
	PrSummary,
	ReviewEvent,
	ReviewVerdict,
} from '../shared/types.ts'
import {
	ACTIVITY_QUERY,
	fromGraphql,
	fromRest,
	THREAD_PAGES,
	type Activity,
	type GqlActivity,
	type RestIssueComment,
	type RestReview,
	type RestReviewComment,
} from './activity.ts'
import { AppFail } from './git.ts'
import type { CliTokenSource } from './ghcli.ts'
import { JsonStore } from './store.ts'
import { join } from 'node:path'

export const API_BASE = 'https://api.github.com'
const TOKEN_ID = 'github'
const PAGE_SIZE = 50
const INBOX_SIZE = 50 // per part of the Inbox (requested, reviewed)
const SEARCH_CAP = 1000 // GitHub search never returns more than 1,000 results per query
const TIMEOUT_MS = 20_000
// Fine-grained tokens (metadata:read is implied). Browsing needs read; publishing reviews needs write.
export const TOKEN_URL =
	'https://github.com/settings/personal-access-tokens/new?name=Review+app&description=Read+pull+requests+in+the+Review+desktop+app&pull_requests=read'
export const WRITE_TOKEN_URL =
	'https://github.com/settings/personal-access-tokens/new?name=Review+app+(publish)&description=Read+pull+requests+and+publish+reviews+from+the+Review+desktop+app&pull_requests=write'

/** The subset of CredentialService used here, so the token shares the app's encrypted credential store. */
export interface TokenStore {
	save(id: string, secret: string, endpoint: string, persist: boolean): Promise<unknown>
	read(id: string, endpoint: string): Promise<{ state: string; secret?: string; reason?: string }>
	peek(id: string, endpoint: string): string
	remove(id: string): Promise<unknown>
	storageInfo(): CredentialStorageInfo
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>

export const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/

/**
 * GitHub REST/GraphQL access for pull requests. The token is read from the credential store for each request and
 * never leaves the main process. The token authorises API calls only; Git fetches use Git's own credentials.
 */
export class GitHubService {
	private store: TokenStore
	private fetch: Fetch
	private base: string
	private login: string | null = null
	private state: GitHubStatus['state'] = 'anonymous'
	private message: string | null = null
	private rate: GitHubStatus['rate'] = null
	private etags = new Map<string, { etag: string; body: unknown }>()
	private pages = new Map<string, PrPage>()
	private graphs = new Map<string, { at: number; graph: Promise<PrGraph | null> }>()
	private listeners = new Set<(s: GitHubStatus) => void>()
	private verifying: Promise<void> | null = null
	private cli: CliTokenSource | null
	private cliInfo: { login: string | null } | null = null
	private cliToken: { value: string; at: number } | null = null
	private scopes: Array<string> | null = null
	private prefs: JsonStore<GitHubPrefs> | null
	private useCliMemory = false
	private notifyMemory: NotificationPrefs = { enabled: true, sound: true }
	private notifyProblem: string | null = null

	constructor(store: TokenStore, options: { fetch?: Fetch; base?: string; cli?: CliTokenSource; dir?: string } = {}) {
		this.store = store
		this.fetch = options.fetch ?? ((url, init) => fetch(url, init))
		this.base = options.base ?? API_BASE
		this.cli = options.cli ?? null
		const empty = (): GitHubPrefs => ({ version: 1, useCli: false, notifications: { enabled: true, sound: true } })
		this.prefs = options.dir
			? new JsonStore(join(options.dir, 'github-settings.json'), empty, (raw) => {
					const r = raw as { useCli?: unknown; notifications?: { enabled?: unknown; sound?: unknown } } | null
					return {
						...empty(),
						useCli: r?.useCli === true,
						notifications: { enabled: r?.notifications?.enabled !== false, sound: r?.notifications?.sound !== false },
					}
				})
			: null
	}

	async load(): Promise<void> {
		await this.prefs?.load()
		if (this.cli) this.cliInfo = await this.cli.detect().catch(() => null)
	}

	flush(): Promise<unknown> {
		return this.prefs?.flush() ?? Promise.resolve()
	}

	private get cliEnabled(): boolean {
		return this.prefs ? this.prefs.read().useCli : this.useCliMemory
	}

	/** Which credential API calls use: a token saved in this app wins over the GitHub CLI login. */
	private source(): 'app' | 'gh' | null {
		const peek = this.store.peek(TOKEN_ID, this.endpoint)
		if (peek === 'saved' || peek === 'session') return 'app'
		return this.cliEnabled && this.cli ? 'gh' : null
	}

	async useCli(enabled: boolean): Promise<void> {
		if (enabled) {
			if (!this.cli) throw new AppFail('github-auth', 'GitHub CLI support is not available.')
			this.cliInfo = await this.cli.detect().catch(() => null)
			if (!this.cliInfo)
				throw new AppFail(
					'github-auth',
					'The GitHub CLI (gh) is not installed or not logged in. Run “gh auth login” in a terminal, then try again.',
				)
		}
		if (this.prefs) await this.prefs.update((d) => void (d.useCli = enabled))
		else this.useCliMemory = enabled
		this.cliToken = null
		this.forget()
		await this.verify()
	}

	get notifications(): NotificationPrefs {
		return this.prefs ? this.prefs.read().notifications : this.notifyMemory
	}

	/** Recorded by the main process after each notification: null once one was shown, else why it was not. */
	setNotificationProblem(problem: string | null): void {
		if (problem === this.notifyProblem) return
		this.notifyProblem = problem
		this.emit()
	}

	async setNotifications(prefs: NotificationPrefs): Promise<void> {
		if (this.prefs) await this.prefs.update((d) => void (d.notifications = prefs))
		else this.notifyMemory = prefs
		this.emit()
	}

	private get endpoint(): string {
		return `github ${this.base}`
	}

	onChange(fn: (s: GitHubStatus) => void): () => void {
		this.listeners.add(fn)
		return () => this.listeners.delete(fn)
	}

	private emit(): void {
		const s = this.status()
		for (const l of this.listeners) l(s)
	}

	status(): GitHubStatus {
		const peek = this.store.peek(TOKEN_ID, this.endpoint)
		const credential = (peek === 'endpoint-changed' ? 'none' : peek) as CredentialState
		const source = this.source()
		const hasToken = source !== null
		return {
			state: hasToken ? this.state : 'anonymous',
			login: hasToken ? this.login : null,
			message: hasToken ? this.message : null,
			credential,
			source,
			scopes: hasToken ? this.scopes : null,
			cli: this.cli ? { available: !!this.cliInfo, login: this.cliInfo?.login ?? null, enabled: this.cliEnabled } : null,
			storage: this.store.storageInfo(),
			rate: this.rate,
			tokenUrl: TOKEN_URL,
			writeTokenUrl: WRITE_TOKEN_URL,
			notifications: this.notifications,
			notificationProblem: this.notifyProblem,
		}
	}

	/** Checks a saved token once at startup (or when asked). Never blocks local browsing. */
	verify(): Promise<void> {
		this.verifying ??= (async () => {
			if (!(await this.token())) {
				this.state = 'anonymous'
				return
			}
			this.state = 'checking'
			this.emit()
			try {
				const res = await this.request(`${this.base}/user`, { method: 'GET' })
				const me = (await res.json()) as { login: string }
				this.login = me.login
				// Classic and OAuth tokens (including gh's) list their scopes; fine-grained tokens send no header.
				const sc = res.headers.get('x-oauth-scopes')
				this.scopes =
					sc === null
						? null
						: sc
								.split(',')
								.map((x) => x.trim())
								.filter(Boolean)
				this.state = 'connected'
				this.message = null
			} catch (e) {
				const err = e instanceof AppFail ? e : new AppFail('github-failed', String(e))
				this.state = err.code === 'offline' ? 'offline' : 'failed'
				this.message = err.message
			}
		})().finally(() => {
			this.verifying = null
			this.emit()
		})
		return this.verifying
	}

	async setToken(token: string, persist: boolean): Promise<void> {
		await this.store.save(TOKEN_ID, token, this.endpoint, persist).catch((e: Error) => {
			throw new AppFail('store-failed', e.message)
		})
		this.forget()
		await this.verify()
	}

	async disconnect(): Promise<void> {
		await this.store.remove(TOKEN_ID)
		this.forget()
		this.state = 'anonymous'
		this.emit()
	}

	private forget(): void {
		this.login = null
		this.scopes = null
		this.message = null
		this.etags.clear()
		this.pages.clear()
		this.graphs.clear()
	}

	private async token(): Promise<string | null> {
		const src = this.source()
		if (src === 'app') {
			const r = await this.store.read(TOKEN_ID, this.endpoint)
			return (r.state === 'saved' || r.state === 'session') && r.secret ? r.secret : null
		}
		if (src !== 'gh') return null
		// Asked for again every few minutes, so `gh auth login`/`logout` and token refreshes are picked up.
		if (this.cliToken && Date.now() - this.cliToken.at < 5 * 60_000) return this.cliToken.value
		const t = await this.cli!.token().catch(() => null)
		if (!t)
			throw new AppFail('github-auth', 'The GitHub CLI is no longer logged in. Run “gh auth login”, or turn off “Use GitHub CLI login”.')
		this.cliToken = { value: t, at: Date.now() }
		return t
	}

	// ─── Pull requests ────────────────────────────────────────────────────────

	async search(repo: string, q: PrQuery, signal?: AbortSignal): Promise<PrPage> {
		checkRepo(repo)
		const key = `${repo.toLowerCase()}|${q.filter}|${q.text.trim()}|${q.cursor ?? ''}`
		try {
			const page = await this.searchFresh(repo, q, signal)
			if (this.pages.size > 100) this.pages.delete(this.pages.keys().next().value!)
			this.pages.set(key, page)
			return page
		} catch (e) {
			const cached = this.pages.get(key)
			if (cached && e instanceof AppFail && e.code !== 'cancelled' && e.code !== 'invalid-input')
				return { ...cached, stale: true, error: e.toError() }
			throw e
		}
	}

	private async searchFresh(repo: string, q: PrQuery, signal?: AbortSignal): Promise<PrPage> {
		const parsed = parsePrQuery(q.text)
		const now = new Date().toISOString()
		const page = (items: Array<PrSummary>, notice: string | null): PrPage => ({
			items,
			total: items.length,
			next: null,
			incomplete: false,
			capped: false,
			exact: true,
			notice,
			fetchedAt: now,
			stale: false,
			error: null,
		})
		if (parsed.kind === 'url' && parsed.repo.toLowerCase() !== repo.toLowerCase())
			return page([], `That link is a pull request in ${parsed.repo}, not ${repo}. Choose that repository to browse it.`)
		if (parsed.kind === 'number' || parsed.kind === 'url') {
			try {
				return page([await this.detail(repo, parsed.number, signal)], null)
			} catch (e) {
				if (e instanceof AppFail && e.code === 'github-not-found') return page([], `${repo} has no pull request #${parsed.number}.`)
				throw e
			}
		}
		const token = await this.token()
		if (FILTER_NEEDS_LOGIN.has(q.filter) && !token)
			throw new AppFail('github-auth', 'Connect a GitHub account to see pull requests that are yours or that request your review.')
		if (q.filter === 'inbox') return { ...(await this.searchInbox(repo, parsed, q.cursor, signal)), fetchedAt: now }
		const search = `${buildSearch(repo, q.filter, parsed)} sort:updated-desc`
		const notice =
			parsed.kind === 'search' && parsed.dropped.length ? `Ignored ${parsed.dropped.join(', ')}: searches stay within ${repo}.` : null
		const result = token ? await this.searchGraphql(search, q, signal) : await this.searchRest(search, q, signal)
		return { ...result, notice: [notice, result.notice].filter(Boolean).join(' ') || null, fetchedAt: now }
	}

	private async searchGraphql(search: string, q: PrQuery, signal?: AbortSignal): Promise<Omit<PrPage, 'fetchedAt'>> {
		// Cursor format "g:<endCursor>#<results so far>"; the count lets the 1,000-result cap be applied.
		const m = q.cursor ? /^g:(.+)#(\d+)$/.exec(q.cursor) : null
		if (q.cursor && !m) throw new AppFail('invalid-input', 'Invalid page cursor.')
		const after = m?.[1] ?? null
		const data = await this.graphql<GqlSearch>(SEARCH_QUERY, { q: search, first: PAGE_SIZE, after }, signal)
		const viewer = data.viewer?.login ?? this.login
		const items = data.search.nodes.filter((n): n is GqlPr => !!n && typeof n.number === 'number').map((n) => fromGql(n, viewer))
		if (q.filter === 'review-requested') for (const i of items) i.reviewRequested = 'you' // includes team requests
		const shown = Number(m?.[2] ?? 0) + items.length
		const capped = data.search.issueCount > SEARCH_CAP
		const more = data.search.pageInfo.hasNextPage && shown < SEARCH_CAP
		return {
			items,
			total: data.search.issueCount,
			next: more && data.search.pageInfo.endCursor ? `g:${data.search.pageInfo.endCursor}#${shown}` : null,
			incomplete: false,
			capped,
			exact: false,
			notice: null,
			stale: false,
			error: null,
		}
	}

	/**
	 * The Inbox: open PRs requesting your review (directly or through a team), plus open PRs you reviewed, newest first.
	 * GitHub search cannot OR two qualifiers, so these are two searches. Statuses are added by the service, which knows
	 * which PRs you have looked at.
	 */
	private async searchInbox(
		repo: string,
		parsed: Extract<ReturnType<typeof parsePrQuery>, { kind: 'search' | 'empty' }>,
		cursor: string | null,
		signal?: AbortSignal,
	): Promise<Omit<PrPage, 'fetchedAt'>> {
		if (cursor) throw new AppFail('invalid-input', 'The Inbox has one page.')
		const run = (qualifiers: string) =>
			this.graphql<GqlSearch>(
				SEARCH_QUERY,
				{ q: `${buildSearch(repo, 'inbox', parsed, qualifiers)} sort:updated-desc`, first: INBOX_SIZE, after: null },
				signal,
			)
		const [requested, reviewed] = await Promise.all([run('is:open review-requested:@me'), run('is:open reviewed-by:@me -author:@me')])
		const viewer = requested.viewer?.login ?? this.login
		const items = new Map<number, PrSummary>()
		for (const n of requested.search.nodes) if (n) items.set(n.number, { ...fromGql(n, viewer), reviewRequested: 'you' })
		for (const n of reviewed.search.nodes) if (n && !items.has(n.number)) items.set(n.number, fromGql(n, viewer))
		const cut = [requested, reviewed].filter((d) => d.search.issueCount > INBOX_SIZE).length > 0
		return {
			items: [...items.values()],
			total: items.size,
			next: null,
			incomplete: false,
			capped: false,
			exact: false,
			notice: cut ? `Only the ${INBOX_SIZE} most recently updated requested and reviewed pull requests are listed.` : null,
			stale: false,
			error: null,
		}
	}

	/**
	 * Every open pull request on GitHub that requests your review, plus the ones you reviewed (across repositories),
	 * for notifications. A pull request in both lists counts as requested. Null without a token.
	 */
	async watchRequests(signal?: AbortSignal): Promise<{ viewer: string | null; prs: Array<WatchedPr> } | null> {
		if (!(await this.token())) return null
		const run = (q: string) =>
			this.graphql<GqlSearch>(SEARCH_QUERY, { q: `${q} archived:false sort:updated-desc`, first: 100, after: null }, signal)
		const [requested, reviewed] = await Promise.all([
			run('is:pr is:open review-requested:@me'),
			run('is:pr is:open reviewed-by:@me -author:@me'),
		])
		const viewer = requested.viewer?.login ?? this.login
		const watched = (n: GqlPr | null, isRequested: boolean): WatchedPr | null => {
			if (!n?.repository) return null
			const s = fromGql(n, viewer)
			const mine = viewer ? s.review?.reviewers.find((r) => r.login.toLowerCase() === viewer.toLowerCase()) : undefined
			return {
				repo: n.repository.nameWithOwner,
				number: n.number,
				title: n.title,
				url: n.url,
				author: s.author,
				draft: n.isDraft,
				reviewed: !!mine,
				requested: isRequested,
				head: n.headRefOid ?? null,
				stale: !!mine?.stale,
			}
		}
		const prs = new Map<string, WatchedPr>()
		for (const n of requested.search.nodes) {
			const w = watched(n, true)
			if (w) prs.set(watchKey(w), w)
		}
		for (const n of reviewed.search.nodes) {
			const w = watched(n, false)
			if (w && !prs.has(watchKey(w))) prs.set(watchKey(w), w)
		}
		return { viewer, prs: [...prs.values()] }
	}

	private async searchRest(search: string, q: PrQuery, signal?: AbortSignal): Promise<Omit<PrPage, 'fetchedAt'>> {
		const pageNo = q.cursor?.startsWith('p:') ? Number(q.cursor.slice(2)) : 1
		if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > SEARCH_CAP / PAGE_SIZE) throw new AppFail('invalid-input', 'Invalid page.')
		const qs = new URLSearchParams({ q: search, per_page: String(PAGE_SIZE), page: String(pageNo) })
		const data = await this.get<RestSearch>(`/search/issues?${qs}`, signal)
		const items = data.items.filter((i) => i.pull_request).map(fromRestIssue)
		const shown = (pageNo - 1) * PAGE_SIZE + items.length
		return {
			items,
			total: data.total_count,
			next: shown < Math.min(data.total_count, SEARCH_CAP) && items.length === PAGE_SIZE ? `p:${pageNo + 1}` : null,
			incomplete: data.incomplete_results,
			capped: data.total_count > SEARCH_CAP,
			exact: false,
			notice: 'Without a GitHub token, search results do not include branch names or review requests. Select a pull request to see them.',
			stale: false,
			error: null,
		}
	}

	/**
	 * Every open pull request's head and base branch, newest first, so stacks can be connected even when a parent is not
	 * in the current search results. Cached for two minutes (concurrent callers share one read). Null without a token:
	 * anonymous reads would cost one REST request per 100 PRs from a 60-per-hour budget.
	 */
	openPrGraph(repo: string, signal?: AbortSignal): Promise<PrGraph | null> {
		checkRepo(repo)
		const key = repo.toLowerCase()
		const hit = this.graphs.get(key)
		if (hit && Date.now() - hit.at < GRAPH_TTL_MS) return hit.graph
		const graph = this.readPrGraph(repo, signal)
		this.graphs.set(key, { at: Date.now(), graph })
		// Failures and "no token" are not cached, so a retry or a newly connected token reads again.
		const drop = (): void => void (this.graphs.get(key)?.graph === graph && this.graphs.delete(key))
		graph.then((g) => g ?? drop(), drop)
		return graph
	}

	private async readPrGraph(repo: string, signal?: AbortSignal): Promise<PrGraph | null> {
		if (!(await this.token())) return null
		const [owner, name] = repo.split('/')
		const nodes: Array<PrGraphNode> = []
		let after: string | null = null
		for (let page = 0; page < GRAPH_MAX_PAGES; page++) {
			const data: GqlGraph = await this.graphql<GqlGraph>(GRAPH_QUERY, { owner, name, after }, signal)
			const prs = data.repository?.pullRequests
			if (!prs) throw new AppFail('github-not-found', `${repo} was not found, or the token cannot read it.`)
			for (const n of prs.nodes) {
				if (!n) continue
				nodes.push({
					number: n.number,
					title: n.title,
					url: n.url,
					draft: n.isDraft,
					author: n.author?.login ?? null,
					headRef: n.headRefName,
					baseRef: n.baseRefName,
					crossRepo: n.isCrossRepository,
					updatedAt: n.updatedAt,
				})
			}
			if (!prs.pageInfo.hasNextPage) return { nodes, truncated: false, fetchedAt: new Date().toISOString() }
			after = prs.pageInfo.endCursor
		}
		return { nodes, truncated: true, fetchedAt: new Date().toISOString() }
	}

	/** Pull requests in `repo` whose head is `owner:branch`, in any state. */
	async pullsForHead(repo: string, head: string): Promise<Array<PrDetail>> {
		checkRepo(repo)
		const qs = new URLSearchParams({ head, state: 'all', sort: 'updated', direction: 'desc', per_page: '10' })
		const list = await this.get<Array<RestPull>>(`/repos/${repo}/pulls?${qs}`)
		return list.map((p) => fromRestPull(p, this.login))
	}

	async detail(repo: string, number: number, signal?: AbortSignal): Promise<PrDetail> {
		checkRepo(repo)
		if (!Number.isInteger(number) || number < 1) throw new AppFail('invalid-input', 'Invalid pull request number.')
		const p = await this.get<RestPull>(`/repos/${repo}/pulls/${number}`, signal)
		return fromRestPull(p, this.login)
	}

	/**
	 * Who approved, requested changes or commented. With a token this includes GitHub's review decision; without one
	 * it comes from the REST review list, which has no decision. One request; read-only.
	 */
	async prReviews(repo: string, number: number, head: string, author: string | null, signal?: AbortSignal): Promise<PrReviewState> {
		checkRepo(repo)
		if (await this.token()) {
			const [owner, name] = repo.split('/')
			const d = await this.graphql<{
				repository: { pullRequest: (Parameters<typeof gqlReviewState>[0] & { author: { login: string } | null }) | null } | null
			}>(PR_REVIEWS_QUERY, { owner, name, number }, signal)
			const pr = d.repository?.pullRequest
			if (!pr) throw new AppFail('github-not-found', `${repo} has no pull request #${number}.`)
			return gqlReviewState(pr, pr.author?.login ?? author)
		}
		const raw: Array<{ user: { login: string } | null; state: string; submitted_at: string | null; commit_id: string | null }> = []
		for (let page = 1; page <= 3; page++) {
			const batch = await this.get<typeof raw>(`/repos/${repo}/pulls/${number}/reviews?per_page=100&page=${page}`, signal)
			raw.push(...batch)
			if (batch.length < 100) break
		}
		return summarizeReviews(
			raw.map((r) => ({ login: r.user?.login ?? null, state: r.state, at: r.submitted_at, commit: r.commit_id })),
			head,
			author,
			null,
		)
	}

	/**
	 * CI results GitHub reports for one commit: check runs (GitHub Actions and other apps) and commit statuses. Read-only;
	 * works without a token for public repositories.
	 */
	async checks(repo: string, sha: string, signal?: AbortSignal): Promise<CommitChecks> {
		checkRepo(repo)
		if (!/^[0-9a-f]{40}$/.test(sha)) throw new AppFail('invalid-input', 'Invalid commit.')
		const [runs, status] = await Promise.all([
			this.get<{
				total_count: number
				check_runs: Array<{
					id: number
					name: string
					status: string
					conclusion: string | null
					app: { name: string } | null
					output?: { annotations_count?: number } | null
				}>
			}>(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`, signal),
			this.get<{ statuses: Array<{ context: string; state: string; description: string | null }> }>(
				`/repos/${repo}/commits/${sha}/status?per_page=100`,
				signal,
			),
		])
		return {
			sha,
			runs: runs.check_runs.map((r) => ({
				id: r.id,
				annotations: r.output?.annotations_count ?? 0,
				name: r.name,
				app: r.app?.name ?? null,
				result: r.status === 'completed' ? (r.conclusion ?? 'neutral') : r.status,
			})),
			runsOmitted: Math.max(0, runs.total_count - runs.check_runs.length),
			statuses: status.statuses.map((x) => ({ name: x.context, result: x.state, description: x.description })),
		}
	}

	/** Line messages one check run attached to files (first 100). */
	async annotations(repo: string, runId: number, signal?: AbortSignal): Promise<Array<Omit<CiAnnotation, 'check'>>> {
		checkRepo(repo)
		if (!Number.isSafeInteger(runId) || runId <= 0) throw new AppFail('invalid-input', 'Invalid check run.')
		const list = await this.get<
			Array<{ path: string; start_line: number; end_line: number; annotation_level: string; title: string | null; message: string }>
		>(`/repos/${repo}/check-runs/${runId}/annotations?per_page=100`, signal)
		return list.map((a) => ({
			path: a.path,
			startLine: a.start_line,
			endLine: Math.max(a.start_line, a.end_line ?? a.start_line),
			level: a.annotation_level === 'failure' || a.annotation_level === 'warning' ? a.annotation_level : 'notice',
			title: a.title || null,
			message: a.message ?? '',
		}))
	}

	// ─── HTTP ─────────────────────────────────────────────────────────────────

	private async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
		const token = await this.token()
		const headers: Record<string, string> = {
			accept: 'application/vnd.github+json',
			'x-github-api-version': '2022-11-28',
			'user-agent': 'Review-desktop',
			...(init.headers as Record<string, string>),
		}
		if (token) headers.authorization = `Bearer ${token}`
		const timeout = AbortSignal.timeout(TIMEOUT_MS)
		let res: Response
		try {
			res = await this.fetch(url, { ...init, headers, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'follow' })
		} catch (e) {
			if (signal?.aborted) throw new AppFail('cancelled', 'Cancelled.')
			if (timeout.aborted) throw new AppFail('offline', 'GitHub did not respond within 20 seconds.')
			throw new AppFail('offline', `Could not reach GitHub (${e instanceof Error ? (e.cause as Error)?.message || e.message : e}).`)
		}
		const remaining = res.headers.get('x-ratelimit-remaining')
		const limit = res.headers.get('x-ratelimit-limit')
		const reset = res.headers.get('x-ratelimit-reset')
		if (remaining && limit && reset)
			this.rate = { remaining: Number(remaining), limit: Number(limit), resetAt: new Date(Number(reset) * 1000).toISOString() }
		if (res.status === 401) this.cliToken = null // re-read from gh next time
		if (!res.ok && res.status !== 304) throw await httpError(res, !!token, this.source())
		return res
	}

	private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
		const url = `${this.base}${path}`
		const cached = this.etags.get(url)
		const res = await this.request(url, { method: 'GET', headers: cached ? { 'if-none-match': cached.etag } : {} }, signal)
		if (res.status === 304 && cached) return cached.body as T
		const body = (await res.json()) as T
		const etag = res.headers.get('etag')
		if (etag) {
			if (this.etags.size > 500) this.etags.delete(this.etags.keys().next().value!)
			this.etags.set(url, { etag, body })
		}
		return body
	}

	private async graphql<T>(
		query: string,
		variables: Record<string, unknown>,
		signal?: AbortSignal,
		options: { write?: boolean; ignore?: (path: Array<string | number>) => boolean } = {},
	): Promise<T> {
		if (options.write) await this.paceWrites()
		const res = await this.request(
			`${this.base}/graphql`,
			{ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }) },
			signal,
		)
		const body = (await res.json()) as {
			data?: T & { rateLimit?: { remaining: number; limit: number; resetAt: string } }
			errors?: Array<{ type?: string; message: string; path?: Array<string | number> }>
		}
		if (body.data?.rateLimit) this.rate = body.data.rateLimit
		const err = body.errors?.find((e) => !(body.data && e.path && options.ignore?.(e.path)))
		if (err) {
			if (err.type === 'RATE_LIMITED') throw new AppFail('github-rate-limited', `GitHub rate limit reached: ${err.message}`)
			if (err.type === 'FORBIDDEN' || err.type === 'INSUFFICIENT_SCOPES')
				throw new AppFail(
					'github-forbidden',
					options.write
						? `The GitHub token cannot write to this pull request (${err.message}). Publishing needs a token with “Pull requests: Read and write” for this repository.`
						: `The GitHub token cannot read this: ${err.message}`,
				)
			if (err.type === 'NOT_FOUND') throw new AppFail('github-not-found', err.message)
			if (options.write || !body.data) throw new AppFail('github-failed', `GitHub: ${err.message}`)
		}
		if (!body.data) throw new AppFail('github-failed', 'GitHub returned an empty response.')
		return body.data
	}

	// GitHub asks integrations to space out requests that create content, or it applies secondary rate limits.
	private lastWrite = 0
	private async paceWrites(): Promise<void> {
		const wait = this.lastWrite + WRITE_SPACING_MS - Date.now()
		if (wait > 0) await new Promise((r) => setTimeout(r, wait))
		this.lastWrite = Date.now()
	}

	// ─── Publishing reviews ──────────────────────────────────────────────────

	/**
	 * The pull request's node id and head, the viewer's pending review (at most one per user and PR, visible only to
	 * them) with its comments, and the current state of previously published reviews. Read-only.
	 */
	async reviewState(repo: string, number: number, knownReviewIds: Array<string>): Promise<ReviewState> {
		checkRepo(repo)
		if (!(await this.token())) throw new AppFail('github-auth', 'Connect GitHub (a token, or your GitHub CLI login) to publish reviews.')
		const [owner, name] = repo.split('/')
		const d = await this.graphql<GqlReviewState>(
			REVIEW_STATE_QUERY,
			{ owner, name, number, ids: knownReviewIds },
			undefined,
			{ ignore: (path) => path[0] === 'nodes' }, // deleted reviews come back as null with a NOT_FOUND error
		)
		const pr = d.repository?.pullRequest
		if (!pr) throw new AppFail('github-not-found', `${repo} has no pull request #${number}, or the token has no access to it.`)
		const pending = pr.reviews.nodes.find((r) => r.viewerDidAuthor) ?? null
		return {
			viewer: d.viewer.login,
			prId: pr.id,
			url: pr.url,
			headSha: pr.headRefOid,
			pending: pending && {
				id: pending.id,
				url: pending.url,
				commit: pending.commit?.oid ?? '',
				comments: pending.comments.nodes.map((c) => ({
					id: c.id,
					url: c.url,
					body: c.body,
					path: c.path,
					line: c.line ?? c.originalLine ?? null,
				})),
			},
			known: d.nodes
				.filter((n): n is NonNullable<typeof n> => !!n && typeof n.id === 'string')
				.map((n) => ({ id: n.id, state: n.state, url: n.url, submittedAt: n.submittedAt })),
		}
	}

	/**
	 * Issues behind a pull request: the ones it closes (GitHub's closing references, which need a token) and the ones
	 * `mentioned` in its description, with their latest comments. Read-only. A mentioned number that is a pull request,
	 * or that the token can't see, is left out; the closing references are skipped without a token.
	 */
	async linkedIssues(
		repo: string,
		number: number,
		mentioned: Array<{ repo: string; number: number }>,
		signal?: AbortSignal,
	): Promise<Array<LinkedIssue>> {
		checkRepo(repo)
		const refs = mentioned.filter((r) => REPO_RE.test(r.repo) && Number.isInteger(r.number) && r.number > 0).slice(0, MAX_MENTIONED)
		if (!(await this.token())) {
			const out: Array<LinkedIssue> = []
			for (const r of refs) {
				try {
					const i = await this.get<RestIssueDetail>(`/repos/${r.repo}/issues/${r.number}`, signal)
					if (i.pull_request) continue
					const comments = i.comments
						? await this.get<Array<RestIssueComment>>(`/repos/${r.repo}/issues/${r.number}/comments?per_page=100`, signal)
						: []
					out.push({
						repo: r.repo,
						number: r.number,
						title: i.title,
						url: i.html_url,
						state: i.state.toUpperCase(),
						body: i.body ?? '',
						closes: false,
						commentsTotal: i.comments,
						comments: comments
							.slice(-ISSUE_COMMENTS)
							.map((c) => ({ author: c.user?.login ?? null, body: c.body ?? '', createdAt: c.created_at })),
					})
				} catch (e) {
					if (signal?.aborted) throw e
				}
			}
			return out
		}
		const [owner, name] = repo.split('/')
		// Mentioned references are aliased into the same query; one that is missing or a pull request comes back null.
		const aliases = refs
			.map((r, i) => {
				const [o, n] = r.repo.split('/')
				return `m${i}: repository(owner: ${JSON.stringify(o)}, name: ${JSON.stringify(n)}) { issueOrPullRequest(number: ${r.number}) { ... on Issue { ...LinkedIssue } } }`
			})
			.join('\n')
		type Node = GqlLinkedIssue | Record<string, never> | null
		const d = await this.graphql<
			{ repository: { pullRequest: { closingIssuesReferences: { nodes: Array<GqlLinkedIssue | null> } } | null } | null } & Record<
				string,
				{ issueOrPullRequest: Node } | null | unknown
			>
		>(
			`query($owner: String!, $name: String!, $number: Int!) {
	repository(owner: $owner, name: $name) { pullRequest(number: $number) { closingIssuesReferences(first: ${MAX_CLOSING}) { nodes { ...LinkedIssue } } } }
	${aliases}
}
fragment LinkedIssue on Issue {
	number title url state body
	repository { nameWithOwner }
	comments(last: ${ISSUE_COMMENTS}) { totalCount nodes { author { login } body createdAt } }
}`,
			{ owner, name, number },
			signal,
			{ ignore: (path) => typeof path[0] === 'string' && /^m\d+$/.test(path[0]) },
		)
		const toIssue = (n: GqlLinkedIssue, closes: boolean): LinkedIssue => ({
			repo: n.repository.nameWithOwner,
			number: n.number,
			title: n.title,
			url: n.url,
			state: n.state,
			body: n.body ?? '',
			closes,
			commentsTotal: n.comments.totalCount,
			comments: n.comments.nodes.map((c) => ({ author: c.author?.login ?? null, body: c.body ?? '', createdAt: c.createdAt })),
		})
		const out = (d.repository?.pullRequest?.closingIssuesReferences.nodes ?? [])
			.filter((n): n is GqlLinkedIssue => !!n)
			.map((n) => toIssue(n, true))
		refs.forEach((_, i) => {
			const n = (d[`m${i}`] as { issueOrPullRequest: Node } | null | undefined)?.issueOrPullRequest
			if (isIssue(n) && !out.some((x) => x.repo.toLowerCase() === n.repository.nameWithOwner.toLowerCase() && x.number === n.number))
				out.push(toIssue(n, false))
		})
		return out
	}

	/**
	 * The PR's existing review threads, reviews and conversation. Read-only. With a token this is GraphQL, the only
	 * API that reports resolved and outdated threads; without one it falls back to REST and says resolved state is
	 * unknown.
	 */
	async activity(repo: string, number: number, signal?: AbortSignal): Promise<Activity> {
		checkRepo(repo)
		if (!(await this.token())) {
			const pr = await this.detail(repo, number, signal)
			const comments: Array<RestReviewComment> = []
			let page = 1
			for (; page <= 5; page++) {
				const batch = await this.get<Array<RestReviewComment>>(`/repos/${repo}/pulls/${number}/comments?per_page=100&page=${page}`, signal)
				comments.push(...batch)
				if (batch.length < 100) break
			}
			const [reviews, issue] = await Promise.all([
				this.get<Array<RestReview>>(`/repos/${repo}/pulls/${number}/reviews?per_page=100`, signal),
				this.get<Array<RestIssueComment>>(`/repos/${repo}/issues/${number}/comments?per_page=100`, signal),
			])
			return fromRest(pr, comments, page > 5, reviews, issue)
		}
		const [owner, name] = repo.split('/')
		type Pr = NonNullable<NonNullable<GqlActivity['repository']>['pullRequest']>
		const pages: Array<Pr> = []
		let after: string | null = null
		for (let i = 0; i < THREAD_PAGES; i++) {
			const d: GqlActivity = await this.graphql<GqlActivity>(ACTIVITY_QUERY, { owner, name, number, after, first: i === 0 }, signal)
			const pr: Pr | null | undefined = d.repository?.pullRequest
			if (!pr) throw new AppFail('github-not-found', `${repo} has no pull request #${number}, or the token has no access to it.`)
			pages.push(pr)
			if (!pr.reviewThreads.pageInfo.hasNextPage) break
			after = pr.reviewThreads.pageInfo.endCursor
		}
		return fromGraphql(pages)
	}

	/**
	 * Creates the viewer's empty pending review on `commit`, or a submitted review when `event` is set. Comments are
	 * added afterwards with `addThread`: `DraftPullRequestReviewThread` (the inline form) has no `subjectType`, so it
	 * cannot carry file-level comments.
	 */
	async addReview(
		prId: string,
		commit: string,
		submit: { event: ReviewEvent; body: string } | null = null,
	): Promise<{ review: { id: string; url: string } }> {
		const d = await this.graphql<{ addPullRequestReview: { pullRequestReview: { id: string; url: string } } }>(
			ADD_REVIEW_MUTATION,
			{ input: { pullRequestId: prId, commitOID: commit, ...(submit ?? {}) } },
			undefined,
			{ write: true },
		)
		return { review: d.addPullRequestReview.pullRequestReview }
	}

	async addThread(reviewId: string, thread: ThreadInput): Promise<{ id: string; url: string }> {
		const d = await this.graphql<{
			addPullRequestReviewThread: { thread: { comments: { nodes: Array<{ id: string; url: string }> } } | null }
		}>(ADD_THREAD_MUTATION, { input: { pullRequestReviewId: reviewId, ...thread } }, undefined, { write: true })
		const c = d.addPullRequestReviewThread.thread?.comments.nodes[0]
		if (!c) throw new AppFail('github-failed', 'GitHub did not create the comment.')
		return c
	}

	async updateComment(commentId: string, body: string): Promise<{ id: string; url: string }> {
		const d = await this.graphql<{ updatePullRequestReviewComment: { pullRequestReviewComment: { id: string; url: string } } }>(
			UPDATE_COMMENT_MUTATION,
			{ input: { pullRequestReviewCommentId: commentId, body } },
			undefined,
			{ write: true },
		)
		return d.updatePullRequestReviewComment.pullRequestReviewComment
	}

	async submitReview(reviewId: string, event: ReviewEvent, body: string): Promise<{ id: string; url: string; submittedAt: string | null }> {
		const d = await this.graphql<{
			submitPullRequestReview: { pullRequestReview: { id: string; url: string; submittedAt: string | null } }
		}>(SUBMIT_MUTATION, { input: { pullRequestReviewId: reviewId, event, body: body || null } }, undefined, { write: true })
		return d.submitPullRequestReview.pullRequestReview
	}
}

const WRITE_SPACING_MS = 800

/** An issue behind a pull request, as the reviewer is told about it. */
export interface LinkedIssue {
	repo: string // "owner/name"
	number: number
	title: string
	url: string
	state: string // OPEN, CLOSED
	body: string
	closes: boolean // a closing reference ("Fixes #12"); false: only mentioned in the description
	commentsTotal: number
	comments: Array<{ author: string | null; body: string; createdAt: string | null }> // the latest ones, oldest first
}

const MAX_CLOSING = 5
const MAX_MENTIONED = 5
const ISSUE_COMMENTS = 20

function isIssue(n: unknown): n is GqlLinkedIssue {
	return !!n && typeof (n as GqlLinkedIssue).number === 'number'
}

interface GqlLinkedIssue {
	number: number
	title: string
	url: string
	state: string
	body: string | null
	repository: { nameWithOwner: string }
	comments: { totalCount: number; nodes: Array<{ author: { login: string } | null; body: string | null; createdAt: string | null }> }
}

interface RestIssueDetail {
	title: string
	html_url: string
	state: string
	body: string | null
	comments: number
	pull_request?: unknown
}

export interface CommitChecks {
	sha: string
	runs: Array<{ id: number; annotations: number; name: string; app: string | null; result: string }> // result: a conclusion (success, failure…) or queued / in_progress
	runsOmitted: number
	statuses: Array<{ name: string; result: string; description: string | null }> // success, failure, error, pending
}

export interface ThreadInput {
	body: string
	path: string
	subjectType: 'LINE' | 'FILE'
	side?: 'LEFT' | 'RIGHT'
	line?: number
	startLine?: number
	startSide?: 'LEFT' | 'RIGHT'
}

export interface ReviewState {
	viewer: string
	prId: string
	url: string
	headSha: string
	pending: {
		id: string
		url: string
		commit: string
		comments: Array<{ id: string; url: string; body: string; path: string; line: number | null }>
	} | null
	known: Array<{ id: string; state: string; url: string; submittedAt: string | null }>
}

interface GqlReviewState {
	viewer: { login: string }
	repository: {
		pullRequest: {
			id: string
			url: string
			headRefOid: string
			reviews: {
				nodes: Array<{
					id: string
					url: string
					viewerDidAuthor: boolean
					commit: { oid: string } | null
					comments: {
						nodes: Array<{ id: string; url: string; body: string; path: string; line: number | null; originalLine: number | null }>
					}
				}>
			}
		} | null
	} | null
	nodes: Array<{ id: string; state: string; url: string; submittedAt: string | null } | null>
}

// ponytail: reads the first 100 comments of the pending review; paginate if reviews ever get larger than that.
const REVIEW_STATE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $ids: [ID!]!) {
  viewer { login }
  rateLimit { remaining limit resetAt }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id url headRefOid
      reviews(states: [PENDING], first: 10) {
        nodes { id url viewerDidAuthor commit { oid } comments(first: 100) { nodes { id url body path line originalLine } } }
      }
    }
  }
  nodes(ids: $ids) { ... on PullRequestReview { id state url submittedAt } }
}`

const ADD_REVIEW_MUTATION = `mutation($input: AddPullRequestReviewInput!) {
  addPullRequestReview(input: $input) { pullRequestReview { id url } }
}`

const ADD_THREAD_MUTATION = `mutation($input: AddPullRequestReviewThreadInput!) {
  addPullRequestReviewThread(input: $input) { thread { comments(first: 1) { nodes { id url } } } }
}`

const UPDATE_COMMENT_MUTATION = `mutation($input: UpdatePullRequestReviewCommentInput!) {
  updatePullRequestReviewComment(input: $input) { pullRequestReviewComment { id url } }
}`

const SUBMIT_MUTATION = `mutation($input: SubmitPullRequestReviewInput!) {
  submitPullRequestReview(input: $input) { pullRequestReview { id url submittedAt } }
}`

function checkRepo(repo: string): void {
	if (!REPO_RE.test(repo)) throw new AppFail('invalid-input', 'Invalid GitHub repository.')
}

async function httpError(res: Response, authed: boolean, source: 'app' | 'gh' | null = null): Promise<AppFail> {
	let message = ''
	let details = ''
	try {
		const b = (await res.json()) as { message?: string; errors?: Array<{ message?: string }> }
		message = b.message ?? ''
		details = (b.errors ?? []).map((e) => e.message ?? '').join(' ')
	} catch {
		/* not JSON */
	}
	const reset = res.headers.get('x-ratelimit-reset')
	const at = reset ? new Date(Number(reset) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
	if (res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(message)))) {
		const when = res.headers.get('retry-after') ? `in ${res.headers.get('retry-after')} s` : at ? `at ${at}` : 'soon'
		return new AppFail(
			'github-rate-limited',
			`GitHub rate limit reached; it resets ${when}.${authed ? '' : ' Connect a GitHub token for a much higher limit.'}`,
		)
	}
	if (res.status === 401)
		return new AppFail(
			'github-auth',
			source === 'gh'
				? 'GitHub rejected the GitHub CLI’s token. Run “gh auth login” (or “gh auth refresh”) in a terminal.'
				: 'GitHub rejected the token (expired or revoked). Enter a new one under GitHub.',
		)
	if (res.status === 403) {
		if (res.headers.get('x-github-sso'))
			return new AppFail(
				'github-forbidden',
				'This organization requires single sign-on. Authorize the token for the organization on GitHub.',
			)
		return new AppFail(
			'github-forbidden',
			`GitHub denied access${message ? `: ${message}` : ''}. The token needs "Pull requests: Read" for this repository.`,
		)
	}
	if (res.status === 404)
		return new AppFail(
			'github-not-found',
			authed ? 'Not found on GitHub, or the token has no access to it.' : 'Not found on GitHub. Private repositories need a GitHub token.',
		)
	// Search reports an inaccessible (e.g. private) repository as a validation error rather than 404.
	if (res.status === 422 && /cannot be searched|do not have permission/i.test(details))
		return new AppFail(
			'github-not-found',
			authed ? 'Not found on GitHub, or the token has no access to it.' : 'Not found on GitHub. Private repositories need a GitHub token.',
		)
	if (res.status === 422) return new AppFail('github-failed', `GitHub could not run this search: ${details || message || 'invalid query'}.`)
	return new AppFail('github-failed', `GitHub returned ${res.status}${message ? `: ${message}` : ''}.`)
}

// ─── Wire formats ───────────────────────────────────────────────────────────

// Approvals and change requests stand until replaced, so they come from latestOpinionatedReviews; latestReviews adds
// people who only commented.
const REVIEW_FIELDS = `headRefOid reviewDecision
        latestOpinionatedReviews(first: 20) { nodes { author { login } state submittedAt commit { oid } } }
        latestReviews(first: 20) { nodes { author { login } state submittedAt commit { oid } } }`

const SEARCH_QUERY = `query($q: String!, $first: Int!, $after: String) {
  viewer { login }
  rateLimit { remaining limit resetAt }
  search(type: ISSUE, query: $q, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title url state isDraft updatedAt
        author { login }
        repository { nameWithOwner }
        headRefName baseRefName isCrossRepository
        headRepositoryOwner { login }
        reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } ... on Bot { login } ... on Mannequin { login } } } }
        ${REVIEW_FIELDS}
      }
    }
  }
}`

interface GitHubPrefs {
	version: 1
	useCli: boolean
	notifications: NotificationPrefs
}

const GRAPH_TTL_MS = 2 * 60_000
const GRAPH_MAX_PAGES = 10 // 1,000 open pull requests

const GRAPH_QUERY = `query($owner: String!, $name: String!, $after: String) {
  rateLimit { remaining limit resetAt }
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { number title url isDraft updatedAt author { login } headRefName baseRefName isCrossRepository }
    }
  }
}`

interface GqlGraph {
	repository: {
		pullRequests: {
			pageInfo: { hasNextPage: boolean; endCursor: string | null }
			nodes: Array<Pick<
				GqlPr,
				'number' | 'title' | 'url' | 'isDraft' | 'updatedAt' | 'author' | 'headRefName' | 'baseRefName' | 'isCrossRepository'
			> | null>
		}
	} | null
}

// The pull request's review decision and each person's latest reviews, for one PR (the preview and an open review).
const PR_REVIEWS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  rateLimit { remaining limit resetAt }
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { author { login } ${REVIEW_FIELDS} } }
}`

interface GqlPr {
	number: number
	title: string
	url: string
	state: 'OPEN' | 'CLOSED' | 'MERGED'
	isDraft: boolean
	updatedAt: string
	author: { login: string } | null
	headRefName: string
	baseRefName: string
	isCrossRepository: boolean
	headRepositoryOwner: { login: string } | null
	repository?: { nameWithOwner: string } | null
	reviewRequests: { nodes: Array<{ requestedReviewer: { __typename: string; login?: string; slug?: string } | null }> } | null
	headRefOid?: string
	reviewDecision?: string | null
	latestOpinionatedReviews?: { nodes: Array<GqlReview | null> } | null
	latestReviews?: { nodes: Array<GqlReview | null> } | null
}

interface GqlReview {
	author: { login: string } | null
	state: string
	submittedAt: string | null
	commit: { oid: string } | null
}

function gqlReviewState(
	n: Pick<GqlPr, 'headRefOid' | 'reviewDecision' | 'latestOpinionatedReviews' | 'latestReviews'>,
	author: string | null,
): PrReviewState {
	const raw = [...(n.latestOpinionatedReviews?.nodes ?? []), ...(n.latestReviews?.nodes ?? [])]
		.filter((r): r is GqlReview => !!r)
		.map((r) => ({ login: r.author?.login ?? null, state: r.state, at: r.submittedAt, commit: r.commit?.oid ?? null }))
	return summarizeReviews(raw, n.headRefOid ?? null, author, n.reviewDecision ?? null)
}

const VERDICT: Record<string, ReviewVerdict> = {
	APPROVED: 'approved',
	CHANGES_REQUESTED: 'changes-requested',
	COMMENTED: 'commented',
	DISMISSED: 'dismissed',
}
const VERDICT_ORDER: Record<ReviewVerdict, number> = { 'changes-requested': 0, approved: 1, commented: 2, dismissed: 3 }

/**
 * Each person's standing review. An approval or change request stands until that person approves, requests changes or
 * is dismissed again; a later comment review doesn't undo it (as on GitHub). The PR author's own replies and pending
 * reviews don't count. `stale`: given on an older commit than `head`.
 */
export function summarizeReviews(
	raw: Array<{ login: string | null; state: string; at: string | null; commit: string | null }>,
	head: string | null,
	author: string | null,
	decision: string | null,
): PrReviewState {
	const by = new Map<string, PrReviewer>()
	const sorted = raw.filter((r) => r.login && r.login !== author && VERDICT[r.state]).sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''))
	for (const r of sorted) {
		const verdict = VERDICT[r.state]
		const cur = by.get(r.login!)
		if (cur && verdict === 'commented' && cur.verdict !== 'commented') continue
		by.set(r.login!, { login: r.login!, verdict, at: r.at, stale: !!head && !!r.commit && r.commit !== head })
	}
	return {
		decision:
			decision === 'APPROVED'
				? 'approved'
				: decision === 'CHANGES_REQUESTED'
					? 'changes-requested'
					: decision === 'REVIEW_REQUIRED'
						? 'review-required'
						: null,
		reviewers: [...by.values()].sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] || a.login.localeCompare(b.login)),
	}
}

interface GqlSearch {
	viewer: { login: string } | null
	search: { issueCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<GqlPr | null> }
}

function fromGql(n: GqlPr, viewer: string | null): PrSummary {
	const reviewers = (n.reviewRequests?.nodes ?? []).flatMap((r) => {
		const x = r.requestedReviewer
		return x ? [x.login ?? (x.slug ? `team:${x.slug}` : '')].filter(Boolean) : []
	})
	return {
		number: n.number,
		title: n.title,
		author: n.author?.login ?? null,
		state: n.state === 'MERGED' ? 'merged' : n.state === 'CLOSED' ? 'closed' : n.isDraft ? 'draft' : 'open',
		headRef: n.headRefName,
		headOwner: n.headRepositoryOwner?.login ?? null,
		baseRef: n.baseRefName,
		crossRepo: n.isCrossRepository,
		updatedAt: n.updatedAt,
		url: n.url,
		reviewRequested: reviewStatus(reviewers, viewer),
		reviewers,
		review: gqlReviewState(n, n.author?.login ?? null),
	}
}

function reviewStatus(reviewers: Array<string>, viewer: string | null): PrSummary['reviewRequested'] {
	if (viewer && reviewers.some((r) => r.toLowerCase() === viewer.toLowerCase())) return 'you'
	return reviewers.length ? 'others' : 'none'
}

interface RestSearch {
	total_count: number
	incomplete_results: boolean
	items: Array<RestIssue>
}

interface RestIssue {
	number: number
	title: string
	html_url: string
	state: 'open' | 'closed'
	draft?: boolean
	updated_at: string
	user: { login: string } | null
	pull_request?: { merged_at: string | null }
}

function fromRestIssue(i: RestIssue): PrSummary {
	return {
		number: i.number,
		title: i.title,
		author: i.user?.login ?? null,
		state: prState(i.state, !!i.draft, i.pull_request?.merged_at ?? null),
		headRef: null,
		headOwner: null,
		baseRef: null,
		crossRepo: null,
		updatedAt: i.updated_at,
		url: i.html_url,
		reviewRequested: null,
		reviewers: [],
		review: null,
	}
}

function prState(state: string, draft: boolean, mergedAt: string | null): PrState {
	if (mergedAt) return 'merged'
	if (state === 'closed') return 'closed'
	return draft ? 'draft' : 'open'
}

interface RestRef {
	ref: string
	sha: string
	user: { login: string } | null
	repo: { full_name: string } | null
}

interface RestPull {
	number: number
	title: string
	body: string | null
	html_url: string
	state: 'open' | 'closed'
	draft?: boolean
	merged_at: string | null
	closed_at: string | null
	created_at: string
	updated_at: string
	user: { login: string } | null
	head: RestRef
	base: RestRef
	commits?: number
	changed_files?: number
	additions?: number
	deletions?: number
	requested_reviewers?: Array<{ login: string }>
	requested_teams?: Array<{ slug: string }>
}

export function fromRestPull(p: RestPull, viewer: string | null): PrDetail {
	const baseRepo = p.base.repo?.full_name ?? ''
	const headRepo = p.head.repo?.full_name ?? null
	const reviewers = [...(p.requested_reviewers ?? []).map((r) => r.login), ...(p.requested_teams ?? []).map((t) => `team:${t.slug}`)]
	return {
		number: p.number,
		title: p.title,
		author: p.user?.login ?? null,
		state: prState(p.state, !!p.draft, p.merged_at),
		headRef: p.head.ref,
		headOwner: p.head.user?.login ?? headRepo?.split('/')[0] ?? null,
		baseRef: p.base.ref,
		crossRepo: headRepo === null ? true : headRepo.toLowerCase() !== baseRepo.toLowerCase(),
		updatedAt: p.updated_at,
		url: p.html_url,
		reviewRequested: reviewStatus(reviewers, viewer),
		reviewers,
		review: null,
		repo: baseRepo,
		body: p.body ?? '',
		commits: p.commits ?? null,
		changedFiles: p.changed_files ?? null,
		additions: p.additions ?? null,
		deletions: p.deletions ?? null,
		baseSha: p.base.sha,
		headSha: p.head.sha,
		headRepo,
		createdAt: p.created_at,
		mergedAt: p.merged_at,
		closedAt: p.closed_at,
	}
}

export function errorOf(e: unknown): AppError {
	return e instanceof AppFail ? e.toError() : { code: 'github-failed', message: e instanceof Error ? e.message : String(e) }
}
