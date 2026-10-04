import type { GifPage, GifResult, GifStatus } from '../shared/types.ts'
import type { CredentialService } from './ai/credentials.ts'
import { AppFail } from './git.ts'

const API = 'https://api.giphy.com/v1/gifs'
const KEY_ID = 'giphy'
const KEY_SCOPE = `giphy ${API}`
const RESULTS = 18
export const MAX_PAGES = 6 // per search: each page is one request against the key's hourly limit
const MAX_PREVIEW_BYTES = 1_500_000
const TIMEOUT_MS = 15_000

// GIPHY ids are short alphanumeric strings. Every URL the app uses or inserts is built from a checked id, never taken
// from the response, so a response cannot point the app or the review at another host.
const ID_RE = /^[A-Za-z0-9]{4,64}$/
const KEY_RE = /^[A-Za-z0-9]{16,64}$/

export const gifUrl = (id: string): string => `https://media.giphy.com/media/${id}/giphy-downsized.gif`
const previewUrl = (id: string): string => `https://media.giphy.com/media/${id}/100w.gif`

type Fetch = (url: string, init: { signal: AbortSignal; headers?: Record<string, string> }) => Promise<Response>

/**
 * GIF search for review text. Runs in the main process only: the renderer gets previews as data URLs (its CSP blocks
 * remote images) and inserts a Markdown image link to media.giphy.com, which GitHub proxies through its own image
 * cache. The API key never leaves this process and never appears in an error.
 */
export class GiphyService {
	private store: CredentialService
	private fetch: Fetch
	private search: AbortController | null = null

	constructor(store: CredentialService, fetchImpl: Fetch = (u, i) => fetch(u, i)) {
		this.store = store
		this.fetch = fetchImpl
	}

	status(): GifStatus {
		const state = this.store.peek(KEY_ID, KEY_SCOPE)
		return {
			key: state === 'saved' || state === 'session' ? state : 'none',
			storage: this.store.storageInfo(),
			keyUrl: 'https://developers.giphy.com/dashboard/',
		}
	}

	async setKey(key: string, persist: boolean): Promise<GifStatus> {
		const k = key.trim()
		if (!KEY_RE.test(k)) throw new AppFail('invalid-input', 'A GIPHY API key is 16 to 64 letters and digits.')
		await this.request('/trending?limit=1&rating=g', k, AbortSignal.timeout(TIMEOUT_MS))
		await this.store.save(KEY_ID, k, KEY_SCOPE, persist).catch((e: Error) => {
			throw new AppFail('store-failed', e.message)
		})
		return this.status()
	}

	async removeKey(): Promise<GifStatus> {
		await this.store.remove(KEY_ID)
		return this.status()
	}

	/**
	 * One page of workplace-safe (rating G) results with previews; an empty query shows trending GIFs. A newer request
	 * cancels this one. `offset` continues a search, up to MAX_PAGES pages.
	 */
	async find(query: string, offset = 0): Promise<GifPage> {
		if (!Number.isInteger(offset) || offset < 0 || offset % RESULTS !== 0 || offset >= RESULTS * MAX_PAGES)
			throw new AppFail('invalid-input', 'Invalid GIF page.')
		this.search?.abort()
		const controller = new AbortController()
		this.search = controller
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS)])
		const read = await this.store.read(KEY_ID, KEY_SCOPE)
		if (read.state !== 'saved' && read.state !== 'session')
			throw new AppFail('invalid-input', 'Add a GIPHY API key in Settings → GitHub to search GIFs.')
		const q = query.trim().slice(0, 50)
		const page = `limit=${RESULTS}&offset=${offset}&rating=g`
		const path = q ? `/search?q=${encodeURIComponent(q)}&${page}&lang=en` : `/trending?${page}`
		const body = (await this.request(path, read.secret, signal)) as {
			data?: Array<{ id?: unknown; title?: unknown }>
			pagination?: { total_count?: unknown }
		}
		const items = (Array.isArray(body?.data) ? body.data : [])
			.filter((d): d is { id: string; title?: unknown } => typeof d?.id === 'string' && ID_RE.test(d.id))
			.slice(0, RESULTS)
		const results = await Promise.all(
			items.map(async (d): Promise<GifResult | null> => {
				const preview = await this.preview(d.id, signal).catch(() => null)
				if (!preview) return null
				const title =
					typeof d.title === 'string'
						? d.title
								.replace(/\s+GIF.*$/i, '')
								.trim()
								.slice(0, 80)
						: ''
				return { id: d.id, title: title || 'GIF', preview, url: gifUrl(d.id) }
			}),
		)
		if (controller.signal.aborted) throw new AppFail('cancelled', 'A newer search replaced this one.')
		const total = typeof body?.pagination?.total_count === 'number' ? body.pagination.total_count : 0
		const next = offset + RESULTS
		return {
			results: results.filter((r): r is GifResult => r !== null),
			next: items.length === RESULTS && next < total && next < RESULTS * MAX_PAGES ? next : null,
		}
	}

	private async request(path: string, key: string, signal: AbortSignal): Promise<unknown> {
		const sep = path.includes('?') ? '&' : '?'
		let res: Response
		try {
			res = await this.fetch(`${API}${path}${sep}api_key=${encodeURIComponent(key)}`, { signal })
		} catch {
			// The message would include the URL, and with it the key: report the cause without it.
			if (signal.aborted) throw new AppFail('cancelled', 'The GIF search was cancelled or timed out.')
			throw new AppFail('gif-failed', 'Could not reach GIPHY.')
		}
		if (res.status === 401 || res.status === 403) throw new AppFail('invalid-input', 'GIPHY rejected the API key.')
		if (res.status === 429) throw new AppFail('gif-failed', 'GIPHY’s request limit was reached. Try again later.')
		if (!res.ok) throw new AppFail('gif-failed', `GIPHY answered with an error (${res.status}).`)
		try {
			return await res.json()
		} catch {
			throw new AppFail('gif-failed', 'GIPHY sent an answer the app could not read.')
		}
	}

	/** Downloads a small preview and checks it really is a GIF before handing it to the renderer as a data URL. */
	private async preview(id: string, signal: AbortSignal): Promise<string | null> {
		const res = await this.fetch(previewUrl(id), { signal })
		if (!res.ok) return null
		const declared = Number(res.headers.get('content-length') ?? 0)
		if (declared > MAX_PREVIEW_BYTES) return null
		const bytes = Buffer.from(await res.arrayBuffer())
		if (
			bytes.length > MAX_PREVIEW_BYTES ||
			bytes
				.subarray(0, 6)
				.toString('latin1')
				.match(/^GIF8[79]a$/) === null
		)
			return null
		return `data:image/gif;base64,${bytes.toString('base64')}`
	}
}
