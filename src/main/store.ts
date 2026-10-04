import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AiRun, BrowserState, Review } from '../shared/types.ts'
import type { WatchState } from '../shared/inbox.ts'

export const STORE_VERSION = 2

export interface StoreData {
	version: number
	lastRepoId: string | null
	repos: Record<string, RepoState>
	// The review requests seen at the last check, so notifications report only what changed (also across restarts).
	inboxWatch?: { login: string | null; state: WatchState; at: string }
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
	constructor(file: string) {
		super(file, empty, migrate)
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
		...(d.inboxWatch ? { inboxWatch: d.inboxWatch } : {}),
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
