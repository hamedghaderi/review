import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AiRun, AutoReviewRecord, BrowserState, MergedPr, Review, ReviewStyle, StyleBasis, StylePr } from '../shared/types.ts'
import { MAX_STYLE_PRS } from '../shared/types.ts'
import type { WatchedPr, WatchState } from '../shared/inbox.ts'
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
	appClones?: Record<string, { repo: string; at: string }> // folders the app cloned itself, by real path: deletable here
	cloneParent?: string // the folder last chosen for a clone, where the folder picker starts next time
	skippedVersion?: string // a release you chose not to be told about again
	seenVersion?: string // the newest version whose "What's new" you have seen
	theme?: ThemeSettings // light or dark and the colour theme; absent until you choose one
	keymap?: KeymapOverrides // the shortcuts you changed; the others keep their defaults
	sounds?: SoundPrefs // the sound each event plays; absent until you change one
	stepCommits?: boolean // Settings › Reviewing: step through a review's commits; absent (off) until turned on
	reviewStyle?: ReviewStyle // how you word review comments; absent until you build it
	stylePrs?: Array<StylePr> // the pull requests you picked to learn your review style from; absent: the recent ones
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
		...(d.appClones && typeof d.appClones === 'object' ? { appClones: d.appClones } : {}),
		...(typeof d.cloneParent === 'string' ? { cloneParent: d.cloneParent } : {}),
		...(d.theme ? { theme: parseTheme(d.theme) } : {}),
		...(d.keymap ? { keymap: parseKeymap(d.keymap, process.platform === 'darwin') } : {}),
		...(d.sounds ? { sounds: storedSounds(d.sounds) } : {}),
		...(d.stepCommits === true ? { stepCommits: true } : {}),
		...(storedStyle(d.reviewStyle) ? { reviewStyle: storedStyle(d.reviewStyle)! } : {}),
		...(Array.isArray(d.stylePrs) ? { stylePrs: storedStylePrs(d.stylePrs) } : {}),
	}
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
