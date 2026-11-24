import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
	AiTextRecord,
	AiRun,
	AutoReviewRecord,
	BrowserState,
	DismissalRef,
	MergedPr,
	NoteSuggestion,
	Review,
	ReviewerNote,
	ReviewStyle,
	StyleBasis,
	StylePr,
} from '../shared/types.ts'
import { DISMISS_REASONS, MAX_NOTE_PATHS, MAX_REVIEWER_NOTE_CHARS, MAX_REVIEWER_NOTES, MAX_STYLE_PRS } from '../shared/types.ts'
import { CATEGORY_LABEL } from '../shared/findings.ts'
import type { SeenHeads, WatchedPr, WatchState } from '../shared/inbox.ts'
import { parseTheme, type ThemeSettings } from '../shared/theme.ts'
import { parseKeymap, type KeymapOverrides } from '../shared/keymap.ts'
import { storedSounds, type SoundPrefs } from '../shared/sounds.ts'

export const STORE_VERSION = 2

export interface StoreData {
	version: number
	lastRepoId: string | null
	repos: Record<string, RepoState>
	openRepoIds?: Array<string> // the repository tabs, in order; absent in older files
	// The review requests seen at the last check, so notifications report only what changed (also across restarts).
	// `prs` (absent in older files) is what the start page lists, so it shows at launch before the first check.
	inboxWatch?: { login: string | null; state: WatchState; at: string; prs?: Array<WatchedPr> }
	mutedRepos?: Array<string> // GitHub repositories ("owner/name", lower case) that do not notify or count
	seenHeads?: SeenHeads // new commits you marked as seen: "owner/name#number" → that head; forgotten once it moves
	appClones?: Record<string, { repo: string; at: string }> // folders the app cloned itself, by real path: deletable here
	cloneParent?: string // the folder last chosen for a clone, where the folder picker starts next time
	skippedVersion?: string // a release you chose not to be told about again
	seenVersion?: string // the newest version whose "What's new" you have seen
	theme?: ThemeSettings // light or dark and the colour theme; absent until you choose one
	keymap?: KeymapOverrides // the shortcuts you changed; the others keep their defaults
	sounds?: SoundPrefs // the sound each event plays; absent until you change one
	stepCommits?: boolean // Settings › Reviewing: step through a review's commits; absent (off) until turned on
	offerWalk?: boolean // Settings › Reviewing: offer a walkthrough of the commits when a review opens; absent (off) until turned on
	autoConclusion?: false // Settings › Reviewing: write the conclusion after each AI review; absent (on) until turned off
	reviewStyle?: ReviewStyle // how you word review comments; absent until you build it
	stylePrs?: Array<StylePr> // the pull requests you picked to learn your review style from; absent: the recent ones
	// Your notes for the AI reviewer, by repository: "owner/name" in lower case, else "local:<repo id>" (issue #278).
	reviewerNotes?: Record<string, Array<ReviewerNote>>
	noteSuggestions?: Record<string, Array<NoteSuggestion>> // notes suggested from your dismissals, by the same key
	noteChecks?: Record<string, Record<string, string>> // by the same key, then "rule|reason": the dismissals last sent to the model
	// Pull requests reviewed automatically, keyed by "owner/name#number": the head commit last reviewed, so one is never reviewed twice.
	autoReviews?: Record<string, AutoReviewRecord>
}

export interface RepoState {
	repoId: string
	root: string
	selectedBase: string | null
	activeReviewId: string | null
	reviews: Record<string, Review>
	aiRuns: Record<string, Array<AiRun>> // keyed by review id, oldest first
	// Added in milestone 3; absent in older files.
	browser?: BrowserState
	githubRepo?: string | null // "owner/name" chosen explicitly for pull requests
	githubResolved?: string | null // the GitHub repository in use when last opened (explicit or from the remotes)
	seenPrs?: Record<string, string> // PR number → when you last looked at it in the app (the Inbox's "new")
	merged?: Record<string, MergedPr | null> // PR number → how it merged and its findings since; null: closed without merging
	followedAt?: string // when merged pull requests were last followed
	aiText?: Array<AiTextRecord> // the AI's explanations, conclusions and drafted replies, oldest first (issue #289)
}

/**
 * Where a repository's reviewer notes are kept (issue #278): its GitHub repository, so every clone of it shares them,
 * else the clone itself.
 */
export function notesKeyOf(repo: Pick<RepoState, 'repoId' | 'githubRepo' | 'githubResolved'>): string {
	const gh = repo.githubRepo ?? repo.githubResolved
	return gh ? gh.toLowerCase() : `local:${repo.repoId}`
}

/**
 * A versioned JSON file. All mutations go through `update`, which serialises writes and replaces the file
 * atomically. An unreadable file is set aside rather than overwritten.
 */
export class JsonStore<T> {
	private data: T
	private queue: Promise<unknown> = Promise.resolve()
	private file: string
	private mode: number
	private empty: () => T
	private migrate: (raw: unknown) => T

	constructor(file: string, empty: () => T, migrate: (raw: unknown) => T, mode = 0o644) {
		this.file = file
		this.empty = empty
		this.migrate = migrate
		this.mode = mode
		this.data = empty()
	}

	async load(): Promise<void> {
		let text: string
		try {
			text = await readFile(this.file, 'utf8')
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
			throw e
		}
		try {
			this.data = this.migrate(JSON.parse(text))
		} catch {
			await rename(this.file, `${this.file}.unreadable-${Date.now()}`).catch(() => {})
			this.data = this.empty()
		}
	}

	read(): T {
		return this.data
	}

	update(mutate: (d: T) => void): Promise<void> {
		const run = async (): Promise<void> => {
			const next = structuredClone(this.data)
			mutate(next)
			await this.write(next)
			this.data = next
		}
		const p = this.queue.then(run, run)
		this.queue = p.catch(() => {})
		return p
	}

	flush(): Promise<unknown> {
		return this.queue
	}

	private async write(d: T): Promise<void> {
		await mkdir(dirname(this.file), { recursive: true })
		const tmp = `${this.file}.${process.pid}.tmp`
		await writeFile(tmp, JSON.stringify(d, null, 2), { encoding: 'utf8', mode: this.mode })
		const fh = await open(tmp, 'r+')
		try {
			await fh.sync()
		} finally {
			await fh.close()
		}
		await rename(tmp, this.file)
	}
}

/** Reviews, comments, drafts, viewed state and AI runs. */
export class ReviewStore extends JsonStore<StoreData> {
	readonly dir: string // the folder the store lives in; context images are kept next to it

	constructor(file: string) {
		super(file, empty, migrate)
		this.dir = dirname(file)
	}

	static in(dir: string): ReviewStore {
		return new ReviewStore(join(dir, 'review-store.json'))
	}
}

function empty(): StoreData {
	return { version: STORE_VERSION, lastRepoId: null, repos: {} }
}

export function migrate(raw: unknown): StoreData {
	if (!raw || typeof raw !== 'object') throw new Error('Store is not an object')
	const d = raw as Partial<StoreData>
	if (d.version === 1) return migrateV1(d)
	if (d.version !== STORE_VERSION) throw new Error(`Unsupported store version ${String(d.version)}`)
	return {
		version: STORE_VERSION,
		lastRepoId: d.lastRepoId ?? null,
		repos: d.repos ?? {},
		...(d.openRepoIds ? { openRepoIds: d.openRepoIds } : {}),
		...(d.inboxWatch ? { inboxWatch: d.inboxWatch } : {}),
		...(typeof d.skippedVersion === 'string' ? { skippedVersion: d.skippedVersion } : {}),
		...(typeof d.seenVersion === 'string' ? { seenVersion: d.seenVersion } : {}),
		...(d.autoReviews ? { autoReviews: d.autoReviews } : {}),
		...(Array.isArray(d.mutedRepos) ? { mutedRepos: d.mutedRepos } : {}),
		...(d.seenHeads && typeof d.seenHeads === 'object' ? { seenHeads: d.seenHeads } : {}),
		...(d.appClones && typeof d.appClones === 'object' ? { appClones: d.appClones } : {}),
		...(typeof d.cloneParent === 'string' ? { cloneParent: d.cloneParent } : {}),
		...(d.theme ? { theme: parseTheme(d.theme) } : {}),
		...(d.keymap ? { keymap: parseKeymap(d.keymap, process.platform === 'darwin') } : {}),
		...(d.sounds ? { sounds: storedSounds(d.sounds) } : {}),
		...(d.stepCommits === true ? { stepCommits: true } : {}),
		...(d.offerWalk === true ? { offerWalk: true } : {}),
		...(d.autoConclusion === false ? { autoConclusion: false as const } : {}),
		...(storedStyle(d.reviewStyle) ? { reviewStyle: storedStyle(d.reviewStyle)! } : {}),
		...(Array.isArray(d.stylePrs) ? { stylePrs: storedStylePrs(d.stylePrs) } : {}),
		...(d.reviewerNotes && typeof d.reviewerNotes === 'object' ? { reviewerNotes: storedNotes(d.reviewerNotes) } : {}),
		...(d.noteSuggestions && typeof d.noteSuggestions === 'object' ? { noteSuggestions: storedSuggestions(d.noteSuggestions) } : {}),
		...(d.noteChecks && typeof d.noteChecks === 'object' ? { noteChecks: d.noteChecks } : {}),
	}
}

/** The saved reviewer notes that are still readable; a repository left without any is dropped. */
export function storedNotes(raw: object): Record<string, Array<ReviewerNote>> {
	const out: Record<string, Array<ReviewerNote>> = {}
	for (const [key, list] of Object.entries(raw)) {
		if (!Array.isArray(list)) continue
		const notes = list
			.filter((n): n is ReviewerNote => {
				const o = n as Partial<ReviewerNote> | null
				return !!o && typeof o.id === 'string' && typeof o.text === 'string' && !!o.text.trim() && typeof o.addedAt === 'string'
			})
			.map((n) => ({
				id: n.id,
				text: n.text.slice(0, MAX_REVIEWER_NOTE_CHARS),
				rule: typeof n.rule === 'string' && n.rule in CATEGORY_LABEL ? n.rule : null,
				paths: Array.isArray(n.paths)
					? n.paths.filter((p): p is string => typeof p === 'string' && !!p.trim()).slice(0, MAX_NOTE_PATHS)
					: [],
				on: n.on !== false,
				addedAt: n.addedAt,
				editedAt: typeof n.editedAt === 'string' ? n.editedAt : null,
				...(Array.isArray(n.from) ? { from: storedRefs(n.from) } : {}),
				...(Array.isArray(n.after) ? { after: storedRefs(n.after) } : {}),
			}))
			.slice(0, MAX_REVIEWER_NOTES)
		if (notes.length) out[key] = notes
	}
	return out
}

/** The dismissals a note or suggestion keeps, without any that can no longer be read. */
function storedRefs(raw: Array<unknown>): Array<DismissalRef> {
	const str = (v: unknown): v is string => typeof v === 'string'
	return raw.filter((x): x is DismissalRef => {
		const o = x as Partial<DismissalRef> | null
		return (
			!!o &&
			[o.key, o.repoId, o.reviewId, o.findingId, o.target, o.prKey, o.path, o.title, o.decidedAt].every(str) &&
			typeof o.rule === 'string' &&
			o.rule in CATEGORY_LABEL &&
			(DISMISS_REASONS as ReadonlyArray<string>).includes(o.reason as string) &&
			(o.line === null || Number.isInteger(o.line)) &&
			(o.note === null || str(o.note))
		)
	})
}

/** The saved note suggestions that are still readable; a repository left without any is dropped. */
export function storedSuggestions(raw: object): Record<string, Array<NoteSuggestion>> {
	const out: Record<string, Array<NoteSuggestion>> = {}
	for (const [key, list] of Object.entries(raw)) {
		if (!Array.isArray(list)) continue
		const kept = list
			.filter((s): s is NoteSuggestion => {
				const o = s as Partial<NoteSuggestion> | null
				return (
					!!o &&
					typeof o.id === 'string' &&
					typeof o.text === 'string' &&
					typeof o.rule === 'string' &&
					o.rule in CATEGORY_LABEL &&
					(DISMISS_REASONS as ReadonlyArray<string>).includes(o.reason as string) &&
					(o.state === 'pending' || o.state === 'later' || o.state === 'never') &&
					Array.isArray(o.from) &&
					typeof o.at === 'string'
				)
			})
			.map((s) => ({
				id: s.id,
				rule: s.rule,
				reason: s.reason,
				problem: typeof s.problem === 'string' ? s.problem : '',
				text: s.text.slice(0, MAX_REVIEWER_NOTE_CHARS),
				paths: Array.isArray(s.paths)
					? s.paths.filter((p): p is string => typeof p === 'string' && !!p.trim()).slice(0, MAX_NOTE_PATHS)
					: [],
				from: storedRefs(s.from),
				state: s.state,
				at: s.at,
				laterAt: typeof s.laterAt === 'number' ? s.laterAt : null,
				model: typeof s.model === 'string' ? s.model : '',
			}))
		if (kept.length) out[key] = kept
	}
	return out
}

/** The picked pull requests that are still readable, at most MAX_STYLE_PRS. */
function storedStylePrs(raw: Array<unknown>): Array<StylePr> {
	return raw
		.filter((p): p is StylePr => {
			const o = p as Partial<StylePr> | null
			return !!o && typeof o.repo === 'string' && Number.isSafeInteger(o.number) && typeof o.title === 'string'
		})
		.map(({ repo, number, title }) => ({ repo, number, title }))
		.slice(0, MAX_STYLE_PRS)
}

/** The saved review style note, or null when it is missing or unreadable. */
export function storedStyle(raw: unknown): ReviewStyle | null {
	const r = raw as Partial<ReviewStyle> | null | undefined
	if (!r || typeof r.text !== 'string' || typeof r.builtAt !== 'string') return null
	const basis = (b: unknown): StyleBasis => {
		const o = (b ?? {}) as Partial<StyleBasis>
		const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
		return { edits: n(o.edits), comments: n(o.comments), github: n(o.github), prs: n(o.prs) }
	}
	const p = r.proposed
	const auto = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null)
	const f = r.autoFailed
	return {
		text: r.text,
		on: r.on !== false,
		builtAt: r.builtAt,
		edited: r.edited === true,
		basis: basis(r.basis),
		auto: auto(r.auto),
		proposed:
			p && typeof p.text === 'string' && typeof p.builtAt === 'string'
				? { text: p.text, builtAt: p.builtAt, basis: basis(p.basis), auto: auto(p.auto) }
				: null,
		autoFailed: f && typeof f.at === 'string' && typeof f.message === 'string' ? { at: f.at, message: f.message } : null,
	}
}

/** v1 → v2: adds AI runs, finding decisions and the finding link on comments/drafts. */
function migrateV1(d: Partial<StoreData>): StoreData {
	const repos: Record<string, RepoState> = {}
	for (const [id, repo] of Object.entries(d.repos ?? {})) {
		const reviews: Record<string, Review> = {}
		for (const [rid, r] of Object.entries(repo.reviews ?? {})) {
			reviews[rid] = {
				...r,
				findingDecisions: {},
				comments: r.comments.map((c) => ({ ...c, findingId: null })),
				drafts: r.drafts.map((x) => ({ ...x, findingId: null })),
			}
		}
		repos[id] = { ...repo, reviews, aiRuns: {} }
	}
	return { version: STORE_VERSION, lastRepoId: d.lastRepoId ?? null, repos }
}
