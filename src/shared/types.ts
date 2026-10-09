export type Side = 'old' | 'new'

export type ErrorCode =
	| 'git-missing'
	| 'not-a-repo'
	| 'bare-repo'
	| 'dubious-ownership'
	| 'no-commits'
	| 'no-base-branches'
	| 'unrelated-histories'
	| 'missing-commits'
	| 'invalid-input'
	| 'not-found'
	| 'store-failed'
	| 'git-failed'
	| 'ai-unavailable'
	| 'ai-busy'
	| 'shallow-history'
	| 'fetch-failed'
	| 'pr-changed'
	| 'pr-unavailable'
	| 'github-auth'
	| 'github-forbidden'
	| 'github-not-found'
	| 'github-rate-limited'
	| 'github-failed'
	| 'offline'
	| 'cancelled'
	| 'gif-failed'

export interface AppError {
	code: ErrorCode
	message: string
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError }

export interface BranchRef {
	ref: string // full refname, e.g. refs/heads/main or refs/remotes/origin/main
	name: string // unambiguous display name: "main", "origin/main"
	kind: 'local' | 'remote'
	remote: string | null // remote name for remote-tracking branches
	short: string // name without the remote prefix, e.g. "feat/login"
	sha: string
	date: string // committer date of the tip, ISO 8601
	subject: string
	upstream: string | null // full ref of the configured upstream (local branches only)
	ahead: number | null // relative to `upstream`
	behind: number | null
	upstreamGone: boolean
	current: boolean // checked out in this working tree
}

export interface RemoteInfo {
	name: string
	github: string | null // "owner/name" when the remote URL points at github.com
}

export interface RepoInfo {
	id: string // canonical top-level path
	root: string
	name: string
	branch: string | null // null = detached HEAD
	headSha: string | null // null = no commits yet
	branches: Array<BranchRef>
	remotes: Array<RemoteInfo>
	defaultBase: string | null
	baseCandidates: Array<string> // likely base refs, best first
	shallow: boolean
	uncommitted: number
}

/** What a review compares. Both kinds feed the same comparison pipeline. */
export type ReviewTarget = { kind: 'branch'; headRef: string; baseRef: string } | { kind: 'pr'; repo: string; number: number }

export type PrState = 'open' | 'draft' | 'merged' | 'closed'

/** The pull request a comparison was resolved from. `baseSha` is GitHub's base commit, not the merge base. */
export interface PrSnapshot {
	repo: string // canonical "owner/name" reported by GitHub
	number: number
	title: string
	url: string
	state: PrState
	baseRef: string
	headLabel: string // "owner:branch"
	baseSha: string
	headSha: string
	body?: string // the author's description, given to the AI reviewer as background (not evidence)
	author?: string | null // GitHub login of who opened it; absent on snapshots stored before it was recorded
}

export type SearchSlot = 'list' | 'palette'

export type PrFilter = 'inbox' | 'open' | 'review-requested' | 'mine' | 'drafts' | 'merged' | 'closed' | 'all'

/**
 * Where an open pull request stands for you (the "Inbox" filter):
 * new = your review is requested and you have not looked at it in the app; waiting = requested, looked at, not reviewed;
 * re-requested = requested again after you reviewed; updated = you reviewed and it has newer commits since;
 * reviewed = you reviewed the current commits and nobody asked again.
 */
export type InboxStatus = 'new' | 'waiting' | 're-requested' | 'updated' | 'reviewed'

export interface PrQuery {
	filter: PrFilter
	text: string
	cursor: string | null // opaque next-page token from the previous page
}

export interface PrSummary {
	number: number
	title: string
	author: string | null
	state: PrState
	headRef: string | null // null when the provider did not include branches (anonymous search)
	headOwner: string | null
	baseRef: string | null
	crossRepo: boolean | null
	updatedAt: string
	url: string
	reviewRequested: 'you' | 'others' | 'none' | null // null = unknown
	reviewers: Array<string>
	review: PrReviewState | null // null: not read (search without a token); the preview reads it
	inbox?: InboxStatus | null // set by the Inbox filter
}

/** One open pull request's branches, enough to connect stacks (a PR whose base is another PR's head). */
export interface PrGraphNode {
	number: number
	title: string
	url: string
	draft: boolean
	author: string | null
	headRef: string
	baseRef: string
	crossRepo: boolean // head is in a fork, so no PR in this repository can be based on it
	updatedAt: string
}

export interface PrGraph {
	nodes: Array<PrGraphNode> // every open pull request, up to `truncated`
	truncated: boolean // more open pull requests than were read
	fetchedAt: string
}

export type ReviewVerdict = 'approved' | 'changes-requested' | 'commented' | 'dismissed'

/** Each person's standing review: their latest approval or change request, else their latest comment review. */
export interface PrReviewer {
	login: string
	verdict: ReviewVerdict
	at: string | null
	stale: boolean // given on an older commit than the PR's head
}

export interface PrReviewState {
	// GitHub's decision under the repository's review rules. null: no rules apply, or not reported (read without a token).
	decision: 'approved' | 'changes-requested' | 'review-required' | null
	reviewers: Array<PrReviewer> // changes requested first, then approvals, comments, dismissed
}

export interface PrPage {
	items: Array<PrSummary>
	total: number
	next: string | null
	incomplete: boolean // provider reported a timed-out, partial search
	capped: boolean // more matches exist than the provider will return
	exact: boolean // a direct lookup (#123 or URL), not a search
	notice: string | null
	fetchedAt: string
	stale: boolean // served from cache because the request failed
	error: AppError | null // set together with `stale`
}

export interface PrDetail extends PrSummary {
	repo: string
	body: string
	commits: number | null
	changedFiles: number | null
	additions: number | null
	deletions: number | null
	baseSha: string
	headSha: string
	headRepo: string | null // null when the fork was deleted
	createdAt: string
	mergedAt: string | null
	closedAt: string | null
}

/** Pull requests whose source is a branch. `head` is the "owner:branch" that was looked up on GitHub. */
export interface BranchPr {
	repo: string
	head: string | null // null when the branch can't be mapped to a GitHub remote
	prs: Array<PrDetail> // open and draft first, then most recently updated
}

export interface GitHubStatus {
	state: 'anonymous' | 'checking' | 'connected' | 'failed' | 'offline'
	login: string | null
	message: string | null
	credential: CredentialState // the token saved in this app
	source: 'app' | 'gh' | null // which credential API calls use; a saved token wins over the GitHub CLI
	scopes: Array<string> | null // OAuth scopes when GitHub reports them (classic tokens, gh); null for fine-grained tokens
	cli: { available: boolean; login: string | null; enabled: boolean } | null
	storage: CredentialStorageInfo
	rate: { remaining: number; limit: number; resetAt: string } | null
	tokenUrl: string // read-only token (browsing)
	writeTokenUrl: string // read and write (publishing reviews)
	notifications: NotificationPrefs
	notificationProblem: string | null // the last notification could not be shown (e.g. blocked in System Settings)
}

/** Desktop notifications for review requests in repositories opened in the app. */
export interface NotificationPrefs {
	enabled: boolean
	sound: boolean
}

/** Sent to the window when a review-request notification is clicked. */
export interface InboxOpen {
	repoId: string
	repo: string // "owner/name"
	number: number
}

export interface GitHubMapping {
	candidates: Array<{ repo: string; remotes: Array<string> }>
	selected: string | null
	chosen: boolean // the user picked `selected` explicitly
}

export type BrowseSection = 'prs' | 'pinned' | 'local' | `remote:${string}`
export type BrowseSelection = { kind: 'pr'; number: number } | { kind: 'branch'; ref: string }

export interface BrowserState {
	view: 'browse' | 'review'
	section: BrowseSection
	prFilter: PrFilter
	prQuery: string
	branchQuery: string
	selected: BrowseSelection | null
	baseRef: string | null // last base chosen in the branch preview
	expanded: Array<string>
	pinned: Array<string>
	scroll: Record<string, number>
	prStacks: boolean // group pull request results into stacks
}

export interface BranchPreview {
	headSha: string
	baseTipSha: string
	mergeBase: string | null
	ahead: number | null // commits on head not on base
	behind: number | null
	error: AppError | null
}

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'type-changed'

export interface ChangedFile {
	key: string // newPath ?? oldPath; unique within a comparison
	status: FileStatus
	oldPath: string | null
	newPath: string | null
	additions: number | null // null for binary
	deletions: number | null
	binary: boolean
	similarity: number | null
}

export interface Comparison {
	id: string // `${baseSha}..${headSha}`
	repoId: string
	baseRef: string
	baseTipSha: string
	baseSha: string // merge base of base tip and HEAD
	headSha: string
	headRef: string | null // display name of the head, e.g. "feat/login" or "octocat:fix"
	target: ReviewTarget | null // null for reviews recorded before milestone 3 (HEAD against baseRef)
	pr: PrSnapshot | null
	files: Array<ChangedFile>
}

export interface DiffLine {
	kind: 'add' | 'del' | 'ctx'
	oldNo: number | null
	newNo: number | null
	text: string
	noNewline?: boolean
}

export interface Hunk {
	oldStart: number
	oldCount: number
	newStart: number
	newCount: number
	section: string
	lines: Array<DiffLine>
}

export type PatchResult =
	{ kind: 'text'; hunks: Array<Hunk>; bytes: number } | { kind: 'binary' } | { kind: 'too-large'; reason: string; canForce: boolean }

export type FileLinesResult = { kind: 'text'; lines: Array<string> } | { kind: 'binary' } | { kind: 'too-large'; reason: string }

export interface Anchor {
	repoId: string
	baseSha: string
	headSha: string
	fileKey: string
	oldPath: string | null
	newPath: string | null
	side: Side | null // null = file-level comment
	startLine: number | null // inclusive source line numbers on `side`
	endLine: number | null
	excerpt: string
}

export interface ReviewComment {
	id: string
	anchor: Anchor
	body: string
	createdAt: string
	updatedAt: string
	findingId: string | null // set when the comment was added from an AI finding
	carried?: CarriedFrom | null // copied from an earlier snapshot of the review; written by the main process only
}

/** Where a comment came from when it was carried forward to a newer snapshot. */
export interface CarriedFrom {
	reviewId: string // the snapshot it was copied from (left unchanged)
	commentId: string
	originId: string // the comment it was first written as, before any carrying
	anchor: Anchor // where it was in that snapshot
	outdated: { reason: string; code: Array<string> } | null // its lines changed; `code` is the old text of those lines
	published: { url: string } | null // already on GitHub from an earlier snapshot, so it is not posted again
}

export interface CommentDraft {
	id: string
	anchor: Anchor
	body: string
	commentId: string | null // set when editing an existing comment
	findingId: string | null
	updatedAt: string
}

export interface Review {
	id: string // comparison id
	repoId: string
	baseRef: string
	baseTipSha: string
	baseSha: string
	headSha: string
	headRef: string | null
	target?: ReviewTarget | null
	pr?: PrSnapshot | null
	createdAt: string
	updatedAt: string
	comments: Array<ReviewComment>
	drafts: Array<CommentDraft>
	viewed: Array<string> // file keys
	findingDecisions: Record<string, FindingDecision> // keyed by finding id
	publication?: Publication // GitHub reviews this snapshot's comments were published to; written by the main process only
	carriedOrigins?: Array<string> // CarriedFrom.originId of every comment carried in, even if deleted since; main process only
	context?: ReviewContext // what you tell the AI reviewer; absent until you add some
	questions?: Array<CodeQuestion> // questions you asked the AI about selected code; written by the main process only
}

/**
 * Context you give the AI reviewer for one review: notes and text files. Sent with every request of later runs, and
 * carried into newer snapshots of the same pull request or branch.
 */
export interface ReviewContext {
	notes: string
	files: Array<ContextFile>
	images?: Array<ContextImage> // absent on context saved before images were supported
}

/** An image you gave the reviewer. The bytes live in the app's image folder under `id` (their SHA-256), not in the store. */
export interface ContextImage {
	id: string
	name: string
	mediaType: ContextImageType
	bytes: number
	addedAt: string
}

export const CONTEXT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ContextImageType = (typeof CONTEXT_IMAGE_TYPES)[number]

export interface ContextFile {
	id: string
	name: string
	text: string
	addedAt: string
}

/** How much context a review can hold. What a run sends is capped separately (see the AI background budget). */
export const CONTEXT_LIMITS = {
	notes: 10_000,
	files: 5,
	fileChars: 100_000,
	fileBytes: 400_000,
	sent: 20_000,
	images: 5,
	imageBytes: 5_000_000, // the smallest per-image limit among the providers (Anthropic)
	imageEdge: 1568, // longest side the app scales images down to; larger costs tokens without helping the model
} as const

/** One GitHub review (pending or submitted) that received comments from this snapshot. */
export interface PublishedReview {
	id: string // GraphQL node id
	url: string
	commit: string // commit the review is attached to
	state: 'pending' | 'submitted'
	event: ReviewEvent | null
	submittedAt: string | null
}

export interface PublishedComment {
	githubId: string // GraphQL node id of the review comment
	reviewId: string // PublishedReview.id
	url: string
	body: string // local comment body when last sent, to detect edits
	at: string
}

export interface Publication {
	repo: string
	number: number
	reviews: Array<PublishedReview>
	comments: Record<string, PublishedComment> // keyed by local comment id
}

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'

/** Where a comment can go on GitHub. `outside-diff`: its lines are not in GitHub's diff, so only a file-level comment is possible. */
export type PublishPlacement =
	| { kind: 'line'; path: string; side: 'LEFT' | 'RIGHT'; line: number; startLine: number | null }
	| { kind: 'file'; path: string }
	| { kind: 'outside-diff'; path: string; reason: string }

export interface PublishItem {
	commentId: string
	fileKey: string
	label: string // "src/a.ts:12–14"
	body: string
	status: 'new' | 'changed' | 'published'
	placement: PublishPlacement
	url: string | null // on GitHub, when published
}

export interface PublishPlan {
	pr: { repo: string; number: number; url: string; headSha: string | null; state: PrState }
	snapshotHead: string
	headMoved: boolean // the PR has newer commits than this snapshot
	pending: { kind: 'none' } | { kind: 'ours' | 'other'; url: string; commit: string; usable: boolean } // `other`: started outside this app
	blocked: AppError | null // publishing new comments is impossible right now (no token, pending review on another commit…)
	items: Array<PublishItem>
	drafts: number // unsubmitted local drafts, never published
	removed: number // deleted here after publishing; left untouched on GitHub
	submitted: Array<PublishedReview>
}

/**
 * The pull request's existing review activity, read from GitHub and never written back. Comment bodies are
 * third-party text: shown as plain text, never used to change a finding.
 */
export interface Discussion {
	status: 'complete' | 'partial' | 'unavailable' // `unavailable`: the read failed, so earlier comments may exist that are not shown
	reason: string | null
	fetchedAt: string
	prHead: string | null // the PR head when this was read
	threads: Array<DiscussionThread>
	reviews: Array<DiscussionReview>
	conversation: Array<DiscussionComment> // PR comments outside the diff
	omitted: { threads: number; comments: number; reviews: number; conversation: number }
}

export interface DiscussionThread {
	id: string
	path: string // GitHub's path (the new path, also for the old side)
	subject: 'line' | 'file'
	side: Side | null
	resolved: boolean | null // null: unknown (read without a token, which GitHub requires for this)
	resolvedBy: string | null
	outdated: boolean // GitHub's flag: the code it pointed at changed since
	// Where it sits in this snapshot. `null`: not shown inline (reason in `unplaced`), listed with the file instead.
	placed: { fileKey: string; startLine: number | null; endLine: number | null } | null
	unplaced: string | null
	fileKey: string | null // the file in this snapshot, when there is one
	originalLine: number | null // where it pointed when written; display only, never used to place it
	diffHunk: string | null // the diff GitHub showed when it was written
	comments: Array<DiscussionComment>
	commentsOmitted: number
	url: string | null
}

export interface DiscussionComment {
	id: string
	author: string | null // null: deleted account
	association: string | null // OWNER, MEMBER, CONTRIBUTOR, NONE…
	body: string
	bodyTruncated: boolean
	createdAt: string | null
	url: string | null // only github.com links
	pending: boolean // in the viewer's own unsubmitted review
}

export interface DiscussionReview {
	id: string
	author: string | null
	state: string // passed through as GitHub reports it
	body: string
	bodyTruncated: boolean
	submittedAt: string | null
	url: string | null
}

export interface PublishOutcome {
	commentId: string
	status: 'published' | 'updated' | 'skipped' | 'failed'
	message: string | null
	url: string | null
}

// blocking / should_fix / pre_existing since prompt reviewer-2026-10-01, the other levels since reviewer-2026-10-02;
// high / medium / low on older runs.
export type Severity = FindingLevel | 'high' | 'medium' | 'low'

/** The levels a reviewer can give a finding, most severe first. Which ones a run uses is a setting. */
export const FINDING_LEVELS = ['blocking', 'should_fix', 'question', 'suggestion', 'nit', 'fyi', 'pre_existing'] as const
export type FindingLevel = (typeof FINDING_LEVELS)[number]

export interface FindingLevelSettings {
	enabled: Array<FindingLevel> // levels the reviewer may use; at least one
	autoAdd: Array<FindingLevel> // levels whose findings become draft comments when a run finishes
}

/** One message in a conversation about a finding. */
export interface FindingMessage {
	id: string
	role: 'you' | 'ai'
	text: string
	at: string
	// AI answers only: whether the finding still holds after the question, and the level it would now give.
	verdict?: 'holds' | 'wrong' | 'unsure' | null
	level?: FindingLevel | null
	model?: string | null
	error?: boolean // the question could not be answered; `text` says why
}

/** One message in a conversation about lines of code you selected. */
export interface CodeMessage {
	id: string
	role: 'you' | 'ai'
	text: string
	at: string
	model?: string | null // AI answers only
	error?: boolean // the question could not be answered; `text` says why
}

/** Questions you asked the AI about lines of code. Private to you; never posted. */
export interface CodeQuestion {
	id: string
	anchor: Anchor // the selected lines, or the whole file
	messages: Array<CodeMessage>
}

/** The only reasons the reviewer may comment (pr-narrative reviewer policy): four defects, two structural, one residue. */
export type FindingCategory =
	'bug' | 'security' | 'error-handling' | 'breaking-change' | 'file-split' | 'over-engineered' | 'convention' | 'test-value' | 'residue'

/** How a changed test fails to protect what it claims to (rule "test-value"). */
export const TEST_PATTERNS = [
	'no-assertion',
	'self-computed-expectation',
	'mock-does-the-work',
	'test-only-seam',
	'duplicate',
	'misses-the-change',
	'wrong-reason-negative',
	'misleading-name',
	'implementation-coupled',
] as const
export type TestPattern = (typeof TEST_PATTERNS)[number]

/** Every rule the reviewer must report on, found or not. Residue has seven signatures. */
export const REVIEW_RULES = [
	'bug',
	'security',
	'error-handling',
	'breaking-change',
	'file-split',
	'over-engineered',
	'convention',
	'test-value',
	'residue-1',
	'residue-2',
	'residue-3',
	'residue-4',
	'residue-5',
	'residue-6',
] as const
export type ReviewRule = (typeof REVIEW_RULES)[number]
/** Rules as stored in runs: runs before reviewer-2026-10-02.2 also checked residue signature 7 (now part of test-value). */
export type StoredRule = ReviewRule | 'residue-7'

/** One reviewer on a team: a model that checks only the rules it owns. */
export interface TeamMember {
	id: string
	role: string // e.g. "Security"
	connectionId: string
	modelId: string
	rules: Array<ReviewRule>
}

export interface ReviewTeam {
	id: string
	name: string
	members: Array<TeamMember>
}

/** A team as shown in settings, with why a member can't run right now. */
export interface ReviewTeamView extends ReviewTeam {
	issues: Array<{ memberId: string | null; message: string }>
}

/** What a run uses: one model for all rules, or a team. */
/**
 * What a run uses: one model for all rules, or a team. `passes` runs one model as the four default roles, each a
 * separate pass over only the files its rules apply to.
 */
export type ReviewerChoice = { kind: 'model'; selection: ModelSelection; passes?: boolean } | { kind: 'team'; teamId: string }

/** The roles a new team starts with, and the passes of a focused-pass run. Each rule belongs to exactly one role. */
export const DEFAULT_TEAM_ROLES: ReadonlyArray<{ id: string; role: string; rules: ReadonlyArray<ReviewRule> }> = [
	{ id: 'defects', role: 'Defects', rules: ['bug', 'error-handling'] },
	{ id: 'security', role: 'Security', rules: ['security'] },
	{ id: 'callers', role: 'Callers & structure', rules: ['breaking-change', 'file-split', 'over-engineered', 'convention'] },
	{
		id: 'tests',
		role: 'Tests & leftover code',
		rules: ['test-value', 'residue-1', 'residue-2', 'residue-3', 'residue-4', 'residue-5', 'residue-6'],
	},
]

/** Provenance of one team member in a run. Never contains secrets. */
export interface RunMember {
	id: string
	role: string
	connectionId: string
	connectionLabel: string
	provider: string
	model: string
	rules: Array<ReviewRule>
	status: 'running' | 'completed' | 'failed' | 'cancelled'
	requestsDone: number
	requestsFailed: number
	requestsTotal: number
	maxBatchChars?: number // characters per request, sized for this member's model; absent on older runs (all used the run's)
	usage: AiUsage | null
	error: string | null
}

export interface NearMiss {
	fileKey: string | null
	line: number | null
	note: string
}

/** What the reviewer reported for one rule across the run, including cases it looked at and did not flag. */
export interface RuleEvaluation {
	rule: StoredRule
	requests: number // requests whose answer covered this rule
	checkedBy?: string | null // team member id, for team runs
	answered?: Array<number> // indexes of the requests whose answer covered this rule; absent on older runs
	nearMisses: Array<NearMiss>
	why: Array<string>
}

export type AiScope = { kind: 'file'; fileKey: string } | { kind: 'all' }

export type AiRunStatus = 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'

export interface LineRange {
	start: number
	end: number
}

export interface Finding {
	id: string
	runId: string
	excerptId: string
	anchor: Anchor
	severity: Severity
	title: string
	evidence: string
	repeatOf: string | null // an equivalent finding from an earlier run of the same review
	// Since prompt reviewer-2026-10-01:
	category?: FindingCategory
	signature?: number | null // residue signature 1–6 (7 on runs before reviewer-2026-10-02.2)
	testPattern?: TestPattern | null // rule "test-value": how the test fails to protect what it claims
	body?: string // result first, then explanation, evidence and one action
	reasoning?: string // one sentence: why it was flagged
	disproof?: string | null // blocking only: the smallest check that would prove it false
	background?: string | null // context needed to follow it, when the hunk alone is not enough
	adjusted?: string | null // what the app changed, e.g. blocking lowered for lack of a disproof
	support?: Array<FindingSupport> // evidence the app found after the review (CI messages on these lines, tests); absent on older runs
	verification?: FindingVerification // blocking findings: a second request that tried to prove it wrong
	mergedInto?: string | null // the same problem as this finding of the run, which stays open; this one is folded under it
	mergedReason?: string | null // the shared cause, in one sentence
	alsoAt?: Array<{ findingId: string; path: string; line: number | null; title: string }> // findings folded under this one
	heldBack?: string | null // over a review limit: kept so decisions and comment links stay valid, but not listed as open
	memberId?: string | null // the team member that raised it (team runs)
	thread?: Array<FindingMessage> // questions you asked about it, and the answers
	alsoBy?: Array<string> // other team members that reported the same problem
	// Before prompt reviewer-2026-10-01:
	problem?: string
	consequence?: string
	suggestion?: string
}

/** A message a CI tool attached to lines of the head commit (lint, type check, test failure), as GitHub reports it. */
export interface CiAnnotation {
	check: string // the check run that reported it
	path: string
	startLine: number
	endLine: number
	level: 'failure' | 'warning' | 'notice'
	title: string | null
	message: string
}

/** The double-check of a blocking finding: a separate request asked to prove it wrong, with lookups. */
export interface FindingVerification {
	verdict: 'holds' | 'wrong' | 'unsure'
	reason: string
	level: FindingLevel | null // the level the check would give it now
	checked: Array<string> // what it read, e.g. "src/cart.ts:12-30"
	model: string
	memberId?: string | null // team runs: the member that checked it, another one than raised it when the team has one
	error?: boolean // the check itself failed; the verdict is 'unsure'
}

/** Evidence the app attached to a finding; never written by the model. 'flags': a tool flagged the same lines. */
export interface FindingSupport {
	source: 'ci' | 'tests'
	strength: 'flags' | 'context'
	text: string
}

export interface RejectedFinding {
	title: string
	excerptId: string
	reason: string
}

// The accepted comment is linked through `findingId` on the draft/comment itself. 'open' overrides a decision
// inherited from an equivalent finding of an earlier run (see Finding.repeatOf).
export interface FindingDecision {
	status: 'accepted' | 'dismissed' | 'open'
	decidedAt: string
	reason?: DismissReason | null // dismissed: why; told to later runs of the same pull request or branch
	note?: string | null // dismissed: the reviewer's own words, e.g. where it is handled
}

export const DISMISS_REASONS = ['wrong', 'not-worth-it', 'handled-elsewhere', 'intended'] as const
export type DismissReason = (typeof DISMISS_REASONS)[number]

/** A finding the reviewer dismissed, as later runs are told about it. */
export interface PastDecision {
	path: string
	line: number | null
	title: string
	category: FindingCategory | null
	reason: DismissReason | null
	note: string | null
	decidedAt: string
}

export type FileCoverageState = 'pending' | 'reviewed' | 'partial' | 'skipped' | 'failed' | 'cancelled' | 'not-reviewable'

export interface FileCoverage {
	fileKey: string
	state: FileCoverageState
	reason: string | null
	risk?: FileRisk | null // the app's estimate before the review; absent on older runs
}

export type RiskLevel = 'high' | 'medium' | 'low'

export const RISK_ORDER: Record<RiskLevel, number> = { high: 0, medium: 1, low: 2 }

/** A change is as risky as its riskiest file; null when no file was rated. */
export function changeRisk(files: Array<{ risk?: FileRisk | null }>): RiskLevel | null {
	let level: RiskLevel | null = null
	for (const f of files) if (f.risk && (!level || RISK_ORDER[f.risk.level] < RISK_ORDER[level])) level = f.risk.level
	return level
}

/** How risky a changed file is, estimated from its path and the kind of change before any model runs. */
export interface FileRisk {
	fileKey: string
	level: RiskLevel
	reasons: Array<string>
}

export interface SkippedRange {
	fileKey: string
	old: LineRange | null
	new: LineRange | null
	reason: string
}

export interface SuppliedExcerpt {
	excerptId: string
	batch: number // index among the requests of its reviewer (team runs: of the member in memberId)
	memberId?: string | null // team runs: the member whose request carried it; absent on older runs, which shared requests
	fileKey: string
	oldPath: string | null
	newPath: string | null
	old: LineRange | null
	new: LineRange | null
}

export interface AiRunCoverage {
	files: Array<FileCoverage>
	skippedRanges: Array<SkippedRange>
	supplied: Array<SuppliedExcerpt>
	batchesTotal: number
	batchesDone: number
	batchesFailed: number
	inputChars: number
	// Code outside the change sent as read-only reference (definitions and uses); absent on older runs.
	related?: { symbols: number; sent: number; chars: number; omitted: number; notes: Array<string> } | null
	facts?: Array<{ kind: 'background' | 'project' | 'dependencies' | 'ci' | 'structure' | 'decisions'; text: string }> // what the app computed or read for the reviewer; absent on older runs
	lookups?: AiLookups | null // files the reviewer opened and searches it made; absent on older runs and when lookups are off
}

export interface OutdatedDoc {
	path: string
	line: number | null
	why: string
}

/** What the reviewer looked up in the repository during a run, summed over its requests. */
export interface AiLookups {
	requests: number // requests that were offered lookups
	calls: number
	chars: number // characters of lookup results sent back to the model
	refused: number // calls over a request's limit or with invalid arguments
	paths: Array<string> // files read and folders listed (first 40)
	searches: Array<string> // texts searched for (first 40)
	unavailable: string | null // why lookups were not offered, e.g. the endpoint does not support tools
	external?: Array<string> // MCP tools called, as "server: tool" (first 40)
	externalUnavailable?: Array<string> // MCP servers that could not be reached for this run, with the reason
}

export interface AiUsage {
	inputTokens: number
	cachedInputTokens: number
	outputTokens: number
	reasoningTokens: number
	totalTokens: number
}

export interface AiRun {
	id: string
	reviewId: string
	repoId: string
	baseSha: string
	headSha: string
	provider: string // provider kind at the time of the run, e.g. 'openai'
	providerLabel: string
	model: string
	fixture: boolean
	// Provenance of the connection used; absent on runs recorded before milestone 2.1. Never contains secrets.
	connectionId?: string | null
	connectionLabel?: string | null
	protocol?: ProviderProtocol | null
	endpoint?: string | null
	limitsUsed?: {
		contextLines: number
		maxBatchChars: number
		maxRunChars: number
		relatedCode?: boolean
		lookups?: boolean
		verify?: boolean
		groupDuplicates?: boolean
		contextWindow: number
		outputTokens: number
	} | null
	notices?: Array<string> // informational, e.g. limits reduced to fit the model, JSON-mode fallback
	promptVersion: string
	scope: AiScope
	status: AiRunStatus
	startedAt: string
	finishedAt: string | null
	coverage: AiRunCoverage
	findings: Array<Finding>
	rejected: Array<RejectedFinding>
	limitations: Array<string>
	errors: Array<string>
	usage: AiUsage | null
	evaluation?: Array<RuleEvaluation> // since reviewer-2026-10-01
	team?: { id: string; name: string; members: Array<RunMember> } | null // set when the run used a review team
	levels?: Array<FindingLevel> // levels the reviewer was allowed to use; absent on older runs (the first three)
	unexplained?: Array<{ fileKey: string; why: string }> // changed files the reviewer could not connect to the change's purpose
	outdatedDocs?: Array<OutdatedDoc> // project docs (.review/*.md) the change makes wrong without updating them
	ciUncovered?: Array<CiAnnotation> // CI failures and warnings on added lines that no finding is near
	verification?: { total: number; done: number; failed: number } | null // double-checks of blocking findings
	merged?: { groups: number; findings: number } | null // findings folded under another as the same problem
	retrying?: Array<ReviewRule> | null // the rules a running retry asks about; the run's other rules are not being checked
}

export type ProviderKind = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'custom' | 'fixture'
export type ProviderProtocol = 'openai-responses' | 'openai-chat' | 'anthropic-messages' | 'gemini-generate' | 'fixture'
export type AuthMethod = 'api-key' | 'none'

export interface EndpointPreset {
	id: string
	label: string
	baseUrl: string
	protocol: ProviderProtocol
	auth: AuthMethod
	contextWindow: number | null // null = use the context window the endpoint reports per model
	note: string | null // shown when adding or viewing a connection made from this preset
}

/** Static, renderer-safe description of a provider. The settings UI is generated from these. */
export interface ProviderDescriptor {
	kind: ProviderKind
	label: string
	description: string
	authMethods: Array<AuthMethod> // only methods that are implemented
	multiple: boolean // several connections of this kind are allowed
	endpointEditable: boolean
	defaultBaseUrl: string | null
	protocols: Array<{ protocol: ProviderProtocol; label: string }> // more than one = user chooses
	presets: Array<EndpointPreset>
	keyPlaceholder: string
	keyHelpUrl: string | null
	testExplains: string // what "Test connection" verifies
	contextWindowEditable: boolean
	development: boolean
}

export type ConnectionStatus = 'not-connected' | 'connected' | 'testing' | 'failed'
export type CredentialState = 'saved' | 'session' | 'none' | 'not-required' | 'unreadable'
export type ModelSource = 'discovered' | 'catalog' | 'manual'

export interface ModelProbe {
	ok: boolean
	at: string
	message: string
}

export interface ModelView {
	id: string
	label: string
	source: ModelSource
	contextWindow: number | null
	maxOutputTokens: number | null
	structuredOutput: 'yes' | 'no' | 'unknown'
	probe: ModelProbe | null
}

export interface ConnectionView {
	id: string
	kind: ProviderKind
	label: string
	providerLabel: string
	protocol: ProviderProtocol
	baseUrl: string
	auth: AuthMethod
	preset: string | null
	contextWindow: number | null // user override (custom endpoints)
	defaultModel: string | null
	status: ConnectionStatus
	statusDetail: string | null
	credential: CredentialState
	lastTest: { ok: boolean; at: string; message: string } | null
	models: Array<ModelView>
	modelsFetchedAt: string | null
}

export interface CredentialStorageInfo {
	secure: boolean
	backend: string
	message: string | null
}

/** A GIF found on GIPHY: a preview to show (data URL, checked to be a GIF) and the link to insert. */
export interface GifResult {
	id: string
	title: string
	preview: string // data:image/gif;base64,…
	url: string // https://media.giphy.com/media/<id>/giphy-downsized.gif
}

export interface GifPage {
	results: Array<GifResult>
	next: number | null // offset of the next page, null at the end (or the per-search page limit)
}

export interface GifStatus {
	key: 'none' | 'saved' | 'session'
	storage: CredentialStorageInfo
	keyUrl: string
}

export interface ReviewLimits {
	contextLines: number
	maxBatchChars: number
	maxRunChars: number
	relatedCode: boolean // also send definitions and uses of the changed names, found with git grep
	lookups: boolean // let the reviewer read files and search the repository at the reviewed commits while it reviews
	verify: boolean // double-check each blocking finding with a request that tries to prove it wrong
	groupDuplicates: boolean // after the review, ask the model which findings are the same problem and fold them (default off)
}

export interface ModelSelection {
	connectionId: string
	modelId: string
}

export interface AiSettingsView {
	providers: Array<ProviderDescriptor>
	connections: Array<ConnectionView>
	selection: ModelSelection | null
	selectionIssue: string | null // why a remembered selection is no longer usable
	teams: Array<ReviewTeamView>
	reviewer: ReviewerChoice | null // what the next run uses (a model or a team)
	storage: CredentialStorageInfo
	limits: ReviewLimits
	levels: FindingLevelSettings
	promptVersion: string
	catalogUpdated: string
}

export interface NewConnectionInput {
	kind: ProviderKind
	label?: string
	preset?: string | null
	baseUrl?: string
	protocol?: ProviderProtocol
	auth?: AuthMethod
	contextWindow?: number | null
}

export interface ConnectionPatch {
	label?: string
	baseUrl?: string
	protocol?: ProviderProtocol
	auth?: AuthMethod
	contextWindow?: number | null
	defaultModel?: string | null
}

export interface ReviewSummary {
	id: string
	baseRef: string
	baseSha: string
	headSha: string
	headRef: string | null
	target: ReviewTarget | null
	pr: PrSnapshot | null
	updatedAt: string
	comments: number
	drafts: number
}

/** A repository tab: one per repository open in the app, in the order they were opened. */
export interface RepoTab {
	id: string
	name: string
	root: string
	requests: number | null // open review requests from the background check; null when it isn't running or the repository isn't on GitHub
}

export interface RepoSession {
	repo: RepoInfo
	tabs: Array<RepoTab>
	activeReviewId: string | null
	reviews: Array<ReviewSummary>
	browser: BrowserState
	github: GitHubMapping
}

/** `from`: the snapshot whose comments carry over (defaults to the latest snapshot of the same target, for a new snapshot). */
export type CompareTarget = { kind: 'target'; target: ReviewTarget; from?: string | null } | { kind: 'snapshot'; reviewId: string }

export interface LoadedComparison {
	comparison: Comparison
	review: Review
	aiRuns: Array<AiRun>
	notice: string | null // e.g. the pull request changed while it was loading
}

/** Whether the target of an open review has moved since its snapshot. Never fetches or changes anything. */
export interface TargetProbe {
	repo: RepoInfo | null
	changed: boolean
	summary: string | null // what moved, e.g. "New head 1a2b3c4"
	error: AppError | null
}

export const IPC = {
	openRepository: 'repo:open',
	restoreLast: 'repo:restore-last',
	refreshRepo: 'repo:refresh',
	loadComparison: 'compare:load',
	probeTarget: 'compare:probe-target',
	branchPreview: 'branch:preview',
	saveBrowserState: 'browse:save',
	githubStatus: 'gh:status',
	githubStatusChanged: 'gh:status-changed',
	githubSetToken: 'gh:token-set',
	githubDisconnect: 'gh:disconnect',
	githubVerify: 'gh:verify',
	githubUseCli: 'gh:use-cli',
	githubSetNotifications: 'gh:notifications',
	githubTestNotification: 'gh:notification-test',
	markPrSeen: 'gh:seen',
	openKnownRepo: 'repo:open-known',
	closeRepoTab: 'repo:close-tab',
	addContextImage: 'context:image-add',
	contextImage: 'context:image',
	repoTabs: 'repo:tabs',
	inboxOpen: 'inbox:open',
	inboxChanged: 'inbox:changed',
	githubSetRepo: 'gh:repo-set',
	searchPrs: 'gh:search',
	prDetail: 'gh:detail',
	prGraph: 'gh:graph',
	myReviews: 'gh:my-reviews',
	cancelOpen: 'compare:cancel',
	branchPr: 'gh:branch-pr',
	publishPlan: 'publish:plan',
	publishComment: 'publish:comment',
	submitReview: 'publish:submit',
	prDiscussion: 'gh:discussion',
	loadPatch: 'diff:patch',
	loadFileLines: 'diff:file-lines',
	saveReview: 'review:save',
	aiSettings: 'ai:settings',
	aiSettingsChanged: 'ai:settings-changed',
	aiCreateConnection: 'ai:connection-create',
	aiUpdateConnection: 'ai:connection-update',
	aiRemoveConnection: 'ai:connection-remove',
	aiSetCredential: 'ai:credential-set',
	aiTestConnection: 'ai:connection-test',
	aiRefreshModels: 'ai:models-refresh',
	aiAddModel: 'ai:model-add',
	aiRemoveModel: 'ai:model-remove',
	aiProbeModel: 'ai:model-probe',
	aiSelectModel: 'ai:model-select',
	aiSetLimits: 'ai:limits-set',
	aiSetLevels: 'ai:levels-set',
	aiAsk: 'ai:ask',
	aiAskCode: 'ai:ask-code',
	aiDeleteCodeQuestion: 'ai:delete-code-question',
	gifStatus: 'gif:status',
	gifSetKey: 'gif:key-set',
	gifRemoveKey: 'gif:key-remove',
	gifSearch: 'gif:search',
	aiSaveTeam: 'ai:team-save',
	aiRemoveTeam: 'ai:team-remove',
	aiSelectTeam: 'ai:team-select',
	aiStart: 'ai:start',
	aiCancel: 'ai:cancel',
	aiRetryRules: 'ai:retry-rules',
	aiRunUpdate: 'ai:run-update',
	mcpSettings: 'mcp:settings',
	mcpSettingsChanged: 'mcp:settings-changed',
	mcpSave: 'mcp:save',
	mcpRemove: 'mcp:remove',
	mcpTest: 'mcp:test',
	mcpSetTools: 'mcp:set-tools',
	mcpClaudeCandidates: 'mcp:claude-candidates',
	mcpImportClaude: 'mcp:import-claude',
	flushRequest: 'app:flush',
	flushDone: 'app:flushed',
} as const

export interface ReviewApi {
	openRepository(): Promise<Result<RepoSession | null>>
	restoreLast(): Promise<Result<RepoSession | null>>
	refreshRepo(repoId: string): Promise<Result<RepoSession>>
	loadComparison(repoId: string, target: CompareTarget): Promise<Result<LoadedComparison>>
	/** Checks whether the review's target moved (new commits); `reviewId` identifies the open snapshot. */
	probeTarget(repoId: string, reviewId: string): Promise<Result<TargetProbe>>
	branchPreview(repoId: string, headRef: string, baseRef: string): Promise<Result<BranchPreview>>
	saveBrowserState(repoId: string, state: BrowserState): Promise<Result<boolean>>
	cancelOpen(): Promise<Result<boolean>>
	githubStatus(): Promise<Result<GitHubStatus>>
	onGitHubStatus(handler: (s: GitHubStatus) => void): () => void
	/** Sends a token to the main process; it is never readable back. */
	githubSetToken(token: string, persist: boolean): Promise<Result<GitHubStatus>>
	githubDisconnect(): Promise<Result<GitHubStatus>>
	githubVerify(): Promise<Result<GitHubStatus>>
	/** Uses (or stops using) the token the GitHub CLI is logged in with. The app never stores it. */
	githubUseCli(enabled: boolean): Promise<Result<GitHubStatus>>
	githubSetNotifications(prefs: NotificationPrefs): Promise<Result<GitHubStatus>>
	/** Shows a sample review-request notification; the status reports whether the system allowed it. */
	githubTestNotification(): Promise<Result<GitHubStatus>>
	/** Records that you looked at a pull request, so the Inbox stops calling it new. */
	markPrSeen(repoId: string, number: number): Promise<Result<boolean>>
	/** Opens a repository opened before (as listed in the store), without a folder dialog. */
	openKnownRepo(repoId: string): Promise<Result<RepoSession>>
	/** Closes a repository's tab. Its reviews stay stored and its review requests keep notifying. Returns the tabs left. */
	closeRepoTab(repoId: string): Promise<Result<Array<RepoTab>>>
	/** Stores an image for a review's context (already scaled down by the renderer); the review references it on save. */
	addContextImage(name: string, bytes: Uint8Array): Promise<Result<ContextImage>>
	/** A stored context image as a data URL, for its thumbnail. */
	contextImage(id: string, mediaType: string): Promise<Result<string>>
	/** The repository tabs, re-read when review requests change. */
	repoTabs(): Promise<Result<Array<RepoTab>>>
	onInboxOpen(handler: (target: InboxOpen) => void): () => void
	/** Your review requests or reviewed pull requests changed on GitHub (seen by the background check). */
	onInboxChanged(handler: () => void): () => void
	githubSetRepo(repoId: string, repo: string): Promise<Result<GitHubMapping>>
	/** Newer searches cancel older ones; stale responses resolve with a `cancelled` error. */
	searchPrs(repoId: string, query: PrQuery, slot: SearchSlot): Promise<Result<PrPage>>
	prDetail(repoId: string, number: number): Promise<Result<PrDetail>>
	/** Every open pull request's head and base branch, to connect stacks. Cached briefly; null without a GitHub token. */
	prGraph(repoId: string): Promise<Result<PrGraph | null>>
	/** Your status on this repository's open PRs that involve you, by number; null without a token. */
	myReviews(repoId: string): Promise<Result<Record<number, 'needs-you' | 'approved' | 'changes-requested' | 'commented'> | null>>
	/** Looks up the pull request for a branch (via its upstream remote's owner). Cached briefly; read-only. */
	branchPr(repoId: string, headRef: string): Promise<Result<BranchPr>>
	/** What publishing the open PR review would do. Reconciles with GitHub; never writes to it. */
	publishPlan(repoId: string, reviewId: string): Promise<Result<PublishPlan>>
	/** Adds (or updates) one comment in the viewer's pending GitHub review, creating the pending review if needed. */
	publishComment(repoId: string, reviewId: string, commentId: string, outsideDiff: 'file' | 'skip'): Promise<Result<PublishOutcome>>
	submitReview(repoId: string, reviewId: string, event: ReviewEvent, body: string): Promise<Result<PublishedReview>>
	/** The open PR review's existing threads, reviews and conversation on GitHub, placed on this snapshot. Read-only. */
	prDiscussion(repoId: string, reviewId: string): Promise<Result<Discussion>>
	loadPatch(comparisonId: string, fileKey: string, force: boolean): Promise<Result<PatchResult>>
	loadFileLines(comparisonId: string, fileKey: string): Promise<Result<FileLinesResult>>
	saveReview(review: Review): Promise<Result<{ savedAt: string }>>
	getAiSettings(): Promise<Result<AiSettingsView>>
	onAiSettingsChanged(handler: (view: AiSettingsView) => void): () => void
	createConnection(input: NewConnectionInput): Promise<Result<AiSettingsView>>
	updateConnection(connectionId: string, patch: ConnectionPatch): Promise<Result<AiSettingsView>>
	removeConnection(connectionId: string): Promise<Result<AiSettingsView>>
	/** Sends a new credential to the main process; it is never readable back. */
	setCredential(connectionId: string, apiKey: string, persist: boolean): Promise<Result<AiSettingsView>>
	testConnection(connectionId: string): Promise<Result<AiSettingsView>>
	/** Re-lists models for connected providers whose list is more than a few seconds old; never runs inference. */
	refreshModels(): Promise<Result<AiSettingsView>>
	addModel(connectionId: string, modelId: string): Promise<Result<AiSettingsView>>
	removeModel(connectionId: string, modelId: string): Promise<Result<AiSettingsView>>
	probeModel(connectionId: string, modelId: string): Promise<Result<AiSettingsView>>
	selectModel(selection: ModelSelection): Promise<Result<AiSettingsView>>
	setReviewLimits(limits: ReviewLimits): Promise<Result<AiSettingsView>>
	setFindingLevels(levels: FindingLevelSettings): Promise<Result<AiSettingsView>>
	/** Creates or replaces a review team. */
	saveTeam(team: ReviewTeam): Promise<Result<AiSettingsView>>
	removeTeam(teamId: string): Promise<Result<AiSettingsView>>
	/** Makes a team the reviewer for the next runs (choosing a single model switches back). */
	selectTeam(teamId: string): Promise<Result<AiSettingsView>>
	mcpSettings(): Promise<Result<McpSettingsView>>
	onMcpSettingsChanged(handler: (view: McpSettingsView) => void): () => void
	/** Adds (id null) or updates a server. Environment and header values go to secure storage and are never read back. */
	mcpSave(id: string | null, input: McpServerInput): Promise<Result<McpSettingsView>>
	mcpRemove(id: string): Promise<Result<McpSettingsView>>
	/** `repoId` sets the folder a command-line server starts in. */
	mcpTest(id: string, repoId: string | null): Promise<Result<McpSettingsView>>
	mcpSetTools(id: string, allowed: Array<string> | null): Promise<Result<McpSettingsView>>
	mcpClaudeCandidates(repoId: string | null): Promise<Result<Array<McpImportCandidate>>>
	mcpImportClaude(repoId: string | null, keys: Array<string>): Promise<Result<McpSettingsView>>
	startAiReview(reviewId: string, scope: AiScope, reviewer: ReviewerChoice): Promise<Result<AiRun>>
	cancelAiReview(runId: string): Promise<Result<boolean>>
	/** Asks each rule's reviewer again, for those rules only, on the requests of a finished run that did not cover them. */
	retryAiRules(reviewId: string, runId: string, rules: Array<ReviewRule>): Promise<Result<AiRun>>
	onAiRunUpdate(handler: (run: AiRun) => void): () => void
	/** Asks the model that raised a finding a question about it. The answer is added to the finding's thread. */
	askFinding(reviewId: string, findingId: string, question: string): Promise<Result<AiRun>>
	/**
	 * Asks the selected model a question about lines of code. `questionId` continues an earlier conversation about the
	 * same lines. Returns the review's updated list of questions.
	 */
	askCode(reviewId: string, anchor: Anchor, question: string, questionId: string | null): Promise<Result<Array<CodeQuestion>>>
	/** Forgets one conversation about selected code. */
	deleteCodeQuestion(reviewId: string, questionId: string): Promise<Result<Array<CodeQuestion>>>
	gifStatus(): Promise<Result<GifStatus>>
	/** Checks the GIPHY key with one request, then stores it; it is never readable back. */
	gifSetKey(key: string, persist: boolean): Promise<Result<GifStatus>>
	gifRemoveKey(): Promise<Result<GifStatus>>
	/** Rating-G GIFs for a search (trending when empty); a newer search cancels an older one. */
	gifSearch(query: string, offset?: number): Promise<Result<GifPage>>
	onFlushRequest(handler: () => Promise<void>): () => void
}

/** How the app reaches an MCP server: a local command it starts, or a URL (Streamable HTTP, or the older SSE). */
export type McpTransport = 'stdio' | 'http' | 'sse'

export interface McpToolView {
	name: string
	description: string
	readOnly: boolean | null // the server's readOnlyHint; null when it does not say
	allowed: boolean // offered to reviewers
}

/** An MCP server as settings show it. Environment and header values can hold secrets, so only their names are shown. */
export interface McpServerView {
	id: string
	name: string
	transport: McpTransport
	command: string
	args: Array<string>
	url: string
	envKeys: Array<string>
	headerKeys: Array<string>
	enabled: boolean
	tools: Array<McpToolView> | null // from the last successful test; null before one
	customTools: boolean // false: tools that look read-only are offered; true: the user picked them
	lastTest: { ok: boolean; at: string; message: string } | null
	secretsState: 'saved' | 'session' | 'none' | 'unreadable'
	origin: string | null // where it was imported from, e.g. "Claude Code (user)"
}

export interface McpSettingsView {
	servers: Array<McpServerView>
	secureStorage: boolean
}

export interface McpServerInput {
	name: string
	transport: McpTransport
	command: string
	args: Array<string>
	url: string
	env: Record<string, string> | null // null keeps the saved values
	headers: Record<string, string> | null
	enabled: boolean
}

/** A server found in Claude Code's configuration, offered for import. */
export interface McpImportCandidate {
	key: string
	name: string
	scope: 'user' | 'project' | 'local'
	transport: McpTransport
	command: string
	args: Array<string>
	url: string
	envKeys: Array<string>
	headerKeys: Array<string>
	imported: boolean // a server with this name already exists
}
