import type {
	AiScope,
	McpServerInput,
	Anchor,
	BrowserState,
	CommentDraft,
	PrQuery,
	ReviewEvent,
	ReviewerChoice,
	ReviewTarget,
	ReviewTeam,
	CompareTarget,
	ConnectionPatch,
	FindingDecision,
	ModelSelection,
	NewConnectionInput,
	Review,
	ReviewComment,
	NotificationPrefs,
	ReviewLimits,
	ReviewRule,
} from '../shared/types.ts'
import { AppFail, isSha } from './git.ts'
import { REPO_RE } from './github.ts'
import { DISMISS_REASONS, FINDING_LEVELS, REVIEW_RULES, type FindingLevel, type FindingLevelSettings } from '../shared/types.ts'

const LIMITS = { id: 128, path: 4096, body: 100_000, excerpt: 4000, items: 10_000 }

function bad(what: string): never {
	throw new AppFail('invalid-input', `Invalid ${what}.`)
}

function obj(v: unknown, what: string): Record<string, unknown> {
	if (!v || typeof v !== 'object' || Array.isArray(v)) bad(what)
	return v as Record<string, unknown>
}

export function str(v: unknown, what: string, max: number = LIMITS.path): string {
	if (typeof v !== 'string' || v.length === 0 || v.length > max) bad(what)
	return v
}

function text(v: unknown, what: string, max: number): string {
	if (typeof v !== 'string' || v.length > max) bad(what)
	return v
}

function strOrNull(v: unknown, what: string): string | null {
	return v === null ? null : str(v, what)
}

function line(v: unknown, what: string): number {
	if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 100_000_000) bad(what)
	return v
}

function iso(v: unknown, what: string): string {
	const s = str(v, what, 64)
	if (Number.isNaN(Date.parse(s))) bad(what)
	return s
}

function arr(v: unknown, what: string): Array<unknown> {
	if (!Array.isArray(v) || v.length > LIMITS.items) bad(what)
	return v
}

export function notificationPrefs(v: unknown): NotificationPrefs {
	const o = obj(v, 'notification settings')
	return { enabled: bool(o.enabled, 'notifications'), sound: bool(o.sound, 'sound') }
}

export function bool(v: unknown, what: string): boolean {
	if (typeof v !== 'boolean') bad(what)
	return v
}

export function compareTarget(v: unknown): CompareTarget {
	const o = obj(v, 'comparison target')
	if (o.kind === 'target')
		return { kind: 'target', target: reviewTarget(o.target), from: o.from == null ? null : str(o.from, 'review id', 200) }
	if (o.kind === 'snapshot') return { kind: 'snapshot', reviewId: str(o.reviewId, 'review id', 200) }
	bad('comparison target')
}

export function branchRef(v: unknown, what = 'branch'): string {
	const s = str(v, what, 1024)
	if (s !== 'HEAD' && !/^refs\/(heads|remotes)\/[^\0\s~^:?*[\\]+$/.test(s)) bad(what)
	return s
}

export function reviewTarget(v: unknown): ReviewTarget {
	const o = obj(v, 'review target')
	if (o.kind === 'branch') return { kind: 'branch', headRef: branchRef(o.headRef), baseRef: branchRef(o.baseRef, 'base branch') }
	if (o.kind === 'pr') return { kind: 'pr', repo: githubRepo(o.repo), number: prNumber(o.number) }
	bad('review target')
}

export function githubRepo(v: unknown): string {
	const s = str(v, 'GitHub repository', 200)
	if (!REPO_RE.test(s)) bad('GitHub repository')
	return s
}

export function prNumber(v: unknown): number {
	if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 1e9) bad('pull request number')
	return v
}

const PR_FILTERS = ['inbox', 'open', 'review-requested', 'mine', 'drafts', 'merged', 'closed', 'all'] as const

export function prQuery(v: unknown): PrQuery {
	const o = obj(v, 'pull request query')
	return {
		filter: oneOf(o.filter, PR_FILTERS, 'filter'),
		text: text(o.text, 'search', 500),
		cursor: o.cursor === null ? null : str(o.cursor, 'page cursor', 400),
	}
}

export function reviewEvent(v: unknown): ReviewEvent {
	return oneOf(v, ['COMMENT', 'APPROVE', 'REQUEST_CHANGES'] as const, 'review action')
}

export function reviewBody(v: unknown): string {
	return text(v, 'review summary', 65_000)
}

export function githubToken(v: unknown): string {
	if (typeof v !== 'string') bad('GitHub token')
	const k = v.trim()
	if (k.length < 20 || k.length > 512 || !/^[A-Za-z0-9_]+$/.test(k)) bad('GitHub token (letters, digits and underscores)')
	return k
}

function selection(v: unknown): BrowserState['selected'] {
	if (v === null) return null
	const o = obj(v, 'selection')
	if (o.kind === 'pr') return { kind: 'pr', number: prNumber(o.number) }
	if (o.kind === 'branch') return { kind: 'branch', ref: branchRef(o.ref) }
	bad('selection')
}

/** Browser UI state. Bounded so a runaway renderer cannot bloat the store. */
export function browserState(v: unknown): BrowserState {
	const o = obj(v, 'browser state')
	const section = str(o.section, 'section', 300)
	if (!['prs', 'pinned', 'local'].includes(section) && !section.startsWith('remote:')) bad('section')
	const list = (x: unknown, what: string): Array<string> => {
		const a = arr(x, what)
		if (a.length > 2000) bad(what)
		return [...new Set(a.map((s) => str(s, what, 1100)))]
	}
	const scroll: Record<string, number> = {}
	for (const [k, n] of Object.entries(obj(o.scroll, 'scroll')).slice(0, 50)) {
		if (typeof n === 'number' && Number.isFinite(n) && n >= 0) scroll[str(k, 'scroll key', 300)] = Math.round(n)
	}
	return {
		view: o.view === 'review' ? 'review' : 'browse',
		section: section as BrowserState['section'],
		prFilter: oneOf(o.prFilter, PR_FILTERS, 'filter'),
		prQuery: text(o.prQuery, 'search', 500),
		branchQuery: text(o.branchQuery, 'search', 500),
		selected: selection(o.selected),
		baseRef: o.baseRef === null ? null : branchRef(o.baseRef, 'base branch'),
		expanded: list(o.expanded, 'expanded folders'),
		pinned: list(o.pinned, 'pinned branches').map((r) => branchRef(r)),
		scroll,
		prStacks: o.prStacks === true,
	}
}

function anchor(v: unknown, review: Review): Anchor {
	const o = obj(v, 'anchor')
	if (o.repoId !== review.repoId || o.baseSha !== review.baseSha || o.headSha !== review.headSha) bad('anchor snapshot')
	const side = o.side
	if (side !== null && side !== 'old' && side !== 'new') bad('anchor side')
	const a: Anchor = {
		repoId: review.repoId,
		baseSha: review.baseSha,
		headSha: review.headSha,
		fileKey: str(o.fileKey, 'anchor file'),
		oldPath: strOrNull(o.oldPath, 'anchor old path'),
		newPath: strOrNull(o.newPath, 'anchor new path'),
		side,
		startLine: side === null ? null : line(o.startLine, 'anchor start line'),
		endLine: side === null ? null : line(o.endLine, 'anchor end line'),
		excerpt: text(o.excerpt, 'anchor excerpt', LIMITS.excerpt),
	}
	if (side !== null && (a.endLine as number) < (a.startLine as number)) bad('anchor range')
	if (side === 'old' && a.oldPath === null) bad('anchor side')
	if (side === 'new' && a.newPath === null) bad('anchor side')
	return a
}

function comment(v: unknown, review: Review): ReviewComment {
	const o = obj(v, 'comment')
	return {
		id: str(o.id, 'comment id', LIMITS.id),
		anchor: anchor(o.anchor, review),
		body: text(o.body, 'comment body', LIMITS.body),
		createdAt: iso(o.createdAt, 'comment date'),
		updatedAt: iso(o.updatedAt, 'comment date'),
		findingId: optionalId(o.findingId, 'comment finding id'),
	}
}

function optionalId(v: unknown, what: string): string | null {
	return v === null || v === undefined ? null : str(v, what, LIMITS.id)
}

function draft(v: unknown, review: Review): CommentDraft {
	const o = obj(v, 'draft')
	return {
		id: str(o.id, 'draft id', LIMITS.id),
		anchor: anchor(o.anchor, review),
		body: text(o.body, 'draft body', LIMITS.body),
		commentId: o.commentId === null ? null : str(o.commentId, 'draft comment id', LIMITS.id),
		findingId: optionalId(o.findingId, 'draft finding id'),
		updatedAt: iso(o.updatedAt, 'draft date'),
	}
}

/**
 * Accepts only user-editable review content; snapshot identity always comes from the stored review.
 * `knownFindings` maps the ids of findings produced by this review's AI runs to their original finding.
 */
export function reviewUpdate(
	v: unknown,
	stored: Review,
	knownFindings: ReadonlyMap<string, string>,
): Pick<Review, 'comments' | 'drafts' | 'viewed' | 'findingDecisions'> {
	const o = obj(v, 'review')
	if (o.id !== stored.id || o.repoId !== stored.repoId) bad('review identity')
	const viewed = arr(o.viewed, 'viewed files').map((f) => str(f, 'viewed file'))
	// Where a comment was carried from is recorded by the main process; the renderer can keep it but not change it.
	const carried = new Map(stored.comments.filter((c) => c.carried).map((c) => [c.id, c.carried]))
	const comments = arr(o.comments, 'comments').map((c) => {
		const x = comment(c, stored)
		return carried.has(x.id) ? { ...x, carried: carried.get(x.id) } : x
	})
	const drafts = arr(o.drafts, 'drafts').map((d) => draft(d, stored))
	const findingDecisions = decisions(o.findingDecisions ?? {}, knownFindings)
	checkFindingLinks(comments, drafts, knownFindings)
	return { comments, drafts, viewed: [...new Set(viewed)], findingDecisions }
}

function decisions(v: unknown, known: ReadonlyMap<string, string>): Record<string, FindingDecision> {
	const o = obj(v, 'finding decisions')
	const out: Record<string, FindingDecision> = {}
	const entries = Object.entries(o)
	if (entries.length > LIMITS.items) bad('finding decisions')
	for (const [id, raw] of entries) {
		if (!known.has(id)) bad('finding decision (unknown finding)')
		const d = obj(raw, 'finding decision')
		if (d.status !== 'accepted' && d.status !== 'dismissed' && d.status !== 'open') bad('finding decision status')
		out[id] = { status: d.status, decidedAt: iso(d.decidedAt, 'decision date') }
		if (d.status === 'dismissed') {
			if (d.reason !== undefined && d.reason !== null) out[id].reason = oneOf(d.reason, DISMISS_REASONS, 'dismiss reason')
			if (d.note !== undefined && d.note !== null) out[id].note = text(d.note, 'dismiss note', 500).trim() || null
		}
	}
	return out
}

/**
 * A finding can be added to the review once: one comment, or one new draft if no comment exists yet. Repeats of a
 * finding from later runs count as the same finding (`roots` maps every known finding id to its original).
 */
export function checkFindingLinks(comments: Array<ReviewComment>, drafts: Array<CommentDraft>, roots: ReadonlyMap<string, string>): void {
	const linked = new Set<string>()
	for (const c of comments) {
		if (!c.findingId) continue
		const root = roots.get(c.findingId)
		if (!root) bad('comment finding link')
		if (linked.has(root)) bad('comment finding link (finding added twice)')
		linked.add(root)
	}
	for (const d of drafts) {
		if (!d.findingId) continue
		const root = roots.get(d.findingId)
		if (!root) bad('draft finding link')
		if (d.commentId !== null) {
			const target = comments.find((c) => c.id === d.commentId)
			if (target && target.findingId !== d.findingId) bad('draft finding link')
			continue
		}
		if (linked.has(root)) bad('draft finding link (finding added twice)')
		linked.add(root)
	}
}

export function aiScope(v: unknown, fileKeys: ReadonlySet<string>): AiScope {
	const o = obj(v, 'AI review scope')
	if (o.kind === 'all') return { kind: 'all' }
	if (o.kind === 'file') {
		const key = str(o.fileKey, 'file')
		if (!fileKeys.has(key)) bad('file (not part of this comparison)')
		return { kind: 'file', fileKey: key }
	}
	bad('AI review scope')
}

export function comparisonId(v: unknown): string {
	const s = str(v, 'comparison id', 200)
	const [a, b, extra] = s.split('..')
	if (extra !== undefined || !isSha(a) || !isSha(b)) bad('comparison id')
	return s
}

const PROVIDER_KINDS = ['openai', 'anthropic', 'gemini', 'openrouter', 'custom', 'fixture'] as const
const PROTOCOLS = ['openai-responses', 'openai-chat', 'anthropic-messages', 'gemini-generate', 'fixture'] as const
const AUTH_METHODS = ['api-key', 'none'] as const

function oneOf<T extends string>(v: unknown, allowed: ReadonlyArray<T>, what: string): T {
	if (typeof v !== 'string' || !(allowed as ReadonlyArray<string>).includes(v)) bad(what)
	return v as T
}

function optional<T>(o: Record<string, unknown>, key: string, parse: (v: unknown) => T): T | undefined {
	return o[key] === undefined ? undefined : parse(o[key])
}

function contextWindow(v: unknown): number | null {
	if (v === null) return null
	if (typeof v !== 'number' || !Number.isInteger(v) || v < 1024 || v > 10_000_000) bad('context window (1,024 – 10,000,000 tokens)')
	return v
}

export function connectionId(v: unknown): string {
	const s = str(v, 'connection id', 64)
	if (!/^[0-9a-f-]{36}$/.test(s)) bad('connection id')
	return s
}

export function modelId(v: unknown): string {
	return str(v, 'model id', 200).trim()
}

export function newConnection(v: unknown): NewConnectionInput {
	const o = obj(v, 'connection')
	return {
		kind: oneOf(o.kind, PROVIDER_KINDS, 'provider'),
		label: optional(o, 'label', (x) => text(x, 'label', 80)),
		preset: optional(o, 'preset', (x) => (x === null ? null : str(x, 'preset', 40))),
		baseUrl: optional(o, 'baseUrl', (x) => str(x, 'endpoint URL', 2000)),
		protocol: optional(o, 'protocol', (x) => oneOf(x, PROTOCOLS, 'protocol')),
		auth: optional(o, 'auth', (x) => oneOf(x, AUTH_METHODS, 'authentication')),
		contextWindow: optional(o, 'contextWindow', contextWindow),
	}
}

export function connectionPatch(v: unknown): ConnectionPatch {
	const o = obj(v, 'connection settings')
	return {
		label: optional(o, 'label', (x) => text(x, 'label', 80)),
		baseUrl: optional(o, 'baseUrl', (x) => str(x, 'endpoint URL', 2000)),
		protocol: optional(o, 'protocol', (x) => oneOf(x, PROTOCOLS, 'protocol')),
		auth: optional(o, 'auth', (x) => oneOf(x, AUTH_METHODS, 'authentication')),
		contextWindow: optional(o, 'contextWindow', contextWindow),
		defaultModel: optional(o, 'defaultModel', (x) => (x === null ? null : modelId(x))),
	}
}

/** API keys: printable ASCII only, so control characters or pasted newlines never reach an HTTP header. */
export function apiKey(v: unknown): string {
	if (typeof v !== 'string') bad('API key')
	const k = v.trim()
	if (k.length < 8 || k.length > 4096 || !/^[\x21-\x7e]+$/.test(k)) bad('API key (8–4096 printable characters, no spaces)')
	return k
}

export function reviewerChoice(v: unknown): ReviewerChoice {
	const o = obj(v, 'reviewer')
	if (o.kind === 'model')
		return {
			kind: 'model',
			selection: modelSelection(o.selection),
			...(o.passes === undefined ? {} : { passes: bool(o.passes, 'focused passes setting') }),
		}
	if (o.kind === 'team') return { kind: 'team', teamId: connectionId(o.teamId) }
	bad('reviewer')
}

export function reviewTeam(v: unknown): ReviewTeam {
	const o = obj(v, 'review team')
	const members = arr(o.members, 'team members')
	if (members.length < 1 || members.length > 8) bad('team members (1–8)')
	const team: ReviewTeam = {
		id: connectionId(o.id),
		name: str(text(o.name, 'team name', 80).trim(), 'team name', 80),
		members: members.map((m) => {
			const x = obj(m, 'team member')
			const rules = arr(x.rules, 'member rules').map((r) => oneOf(r, REVIEW_RULES, 'rule'))
			if (!rules.length) bad('member rules (at least one)')
			return {
				id: connectionId(x.id),
				role: str(text(x.role, 'role', 60).trim(), 'role name', 60),
				connectionId: connectionId(x.connectionId),
				modelId: modelId(x.modelId),
				rules: [...new Set(rules)],
			}
		}),
	}
	if (new Set(team.members.map((m) => m.id)).size !== team.members.length) bad('team members (duplicate id)')
	return team
}

export function reviewRule(v: unknown): ReviewRule {
	return oneOf(v, REVIEW_RULES, 'rule')
}

export function modelSelection(v: unknown): ModelSelection {
	const o = obj(v, 'model selection')
	return { connectionId: connectionId(o.connectionId), modelId: modelId(o.modelId) }
}

export function findingLevels(v: unknown): FindingLevelSettings {
	const o = obj(v, 'finding levels')
	const list = (x: unknown, what: string): Array<FindingLevel> => [
		...new Set(arr(x, what).map((l) => oneOf(l, FINDING_LEVELS, 'finding level'))),
	]
	const enabled = list(o.enabled, 'enabled levels')
	if (!enabled.length) bad('enabled levels (turn on at least one)')
	return { enabled, autoAdd: list(o.autoAdd, 'auto-added levels').filter((l) => enabled.includes(l)) }
}

export function reviewLimits(v: unknown): ReviewLimits {
	const o = obj(v, 'review limits')
	const n = (x: unknown, what: string, min: number, max: number): number => {
		if (typeof x !== 'number' || !Number.isInteger(x) || x < min || x > max)
			bad(`${what} (${min.toLocaleString()}–${max.toLocaleString()})`)
		return x
	}
	return {
		contextLines: n(o.contextLines, 'context lines', 0, 500),
		maxBatchChars: n(o.maxBatchChars, 'characters per request', 8_000, 3_000_000),
		maxRunChars: n(o.maxRunChars, 'characters per run', 8_000, 50_000_000),
		relatedCode: o.relatedCode === undefined ? true : bool(o.relatedCode, 'related code setting'),
		lookups: o.lookups === undefined ? true : bool(o.lookups, 'lookups setting'),
		verify: o.verify === undefined ? true : bool(o.verify, 'double-check setting'),
		groupDuplicates: o.groupDuplicates === undefined ? false : bool(o.groupDuplicates, 'group duplicates setting'),
	}
}

const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/

function stringMap(v: unknown, what: string, key: RegExp): Record<string, string> | null {
	if (v === null) return null
	const o = obj(v, what)
	const entries = Object.entries(o)
	if (entries.length > 50) bad(what)
	for (const [k, x] of entries) if (!key.test(k) || typeof x !== 'string' || x.length > 8000 || /[\r\n\0]/.test(x)) bad(`${what} "${k}"`)
	return o as Record<string, string>
}

export function mcpServerInput(v: unknown): McpServerInput {
	const o = obj(v, 'MCP server')
	const name = str(o.name, 'MCP server name', 40).trim()
	if (!MCP_NAME.test(name)) bad('MCP server name (letters, digits, spaces, "-", "_" or ".")')
	const transport = o.transport === 'stdio' || o.transport === 'http' || o.transport === 'sse' ? o.transport : bad('MCP transport')
	const command = text(o.command, 'command', 1000).trim()
	if (transport === 'stdio' && (!command || /[\0\r\n]/.test(command))) bad('command')
	if (!Array.isArray(o.args) || o.args.length > 100 || o.args.some((a) => typeof a !== 'string' || a.length > 4000 || a.includes('\0')))
		bad('arguments')
	const url = text(o.url, 'URL', 2000).trim()
	if (transport !== 'stdio' && !/^https?:\/\/\S+$/.test(url) && !/\$\{/.test(url)) bad('URL (it must start with https:// or http://)')
	return {
		name,
		transport,
		command,
		args: o.args as Array<string>,
		url,
		env: stringMap(o.env, 'environment variable', VAR_NAME),
		headers: stringMap(o.headers, 'header', HEADER_NAME),
		enabled: bool(o.enabled, 'enabled'),
	}
}

export function mcpToolNames(v: unknown): Array<string> | null {
	if (v === null) return null
	if (!Array.isArray(v) || v.length > 500 || v.some((n) => typeof n !== 'string' || n.length === 0 || n.length > 200)) bad('tool names')
	return v as Array<string>
}

export function mcpKeys(v: unknown): Array<string> {
	if (!Array.isArray(v) || v.length > 100 || v.some((n) => typeof n !== 'string' || n.length === 0 || n.length > 300))
		bad('servers to import')
	return v as Array<string>
}
