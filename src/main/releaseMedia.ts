import { createHash } from 'node:crypto'

/**
 * Images and videos in Review's own release notes, served to the window as `review-media://media/<id>`. The window
 * loads nothing from the internet itself: only files the release notes point at, uploaded to GitHub, are fetched here
 * and passed on. Any other id is refused, so a PR description can never use this to load something.
 */
export const MEDIA_SCHEME = 'review-media'

const MAX_MEDIA = 200 // ids remembered per run

/** Files uploaded to GitHub for Review's releases: dragged into the release editor, or attached to the repository. */
export function isReleaseMedia(url: string): boolean {
	let u: URL
	try {
		u = new URL(url)
	} catch {
		return false
	}
	if (u.protocol !== 'https:' || u.username || u.password || u.port) return false
	if (u.hostname === 'github.com')
		return u.pathname.startsWith('/user-attachments/assets/') || u.pathname.startsWith('/hamedghaderi/review/assets/')
	return u.hostname === 'user-images.githubusercontent.com'
}

export class ReleaseMedia {
	private urls = new Map<string, string>() // id → GitHub URL

	/**
	 * Points the release notes' own images and videos at `review-media:` and remembers them. Other sources are left as
	 * they are; the window shows those as links.
	 */
	rewrite(html: string): string {
		return html.replace(/<(img|video|source)\b[^>]*>/gi, (tag) =>
			tag.replace(/\s(src|poster)="([^"]*)"/gi, (attr, name: string, raw: string) => {
				const url = raw.replace(/&amp;/g, '&')
				if (!isReleaseMedia(url)) return attr
				return ` ${name}="${MEDIA_SCHEME}://media/${this.remember(url)}"`
			}),
		)
	}

	private remember(url: string): string {
		const id = createHash('sha256').update(url).digest('hex').slice(0, 32)
		if (!this.urls.has(id)) {
			if (this.urls.size >= MAX_MEDIA) this.urls.delete(this.urls.keys().next().value!)
			this.urls.set(id, url)
		}
		return id
	}

	/**
	 * Answers a `review-media:` request from GitHub, passing a byte range through so a video can seek without
	 * downloading all of it. Only images and videos are passed on.
	 */
	async respond(request: Request, fetcher: typeof fetch): Promise<Response> {
		const { host, pathname } = new URL(request.url)
		const url = host === 'media' ? this.urls.get(pathname.slice(1)) : undefined
		if (!url) return new Response('Not found', { status: 404 })
		const range = request.headers.get('range')
		let res: Response
		try {
			res = await fetcher(url, { headers: range ? { Range: range } : {}, redirect: 'follow', signal: AbortSignal.timeout(60_000) })
		} catch {
			return new Response('Unavailable', { status: 502 })
		}
		const type = res.headers.get('content-type') ?? ''
		if (!res.ok || !/^(image|video)\/[\w.+-]+|^application\/octet-stream/i.test(type)) {
			await res.body?.cancel().catch(() => {})
			return new Response('Unavailable', { status: 502 })
		}
		const headers = new Headers({ 'Content-Type': type })
		for (const h of ['content-length', 'content-range', 'accept-ranges', 'cache-control']) {
			const v = res.headers.get(h)
			if (v) headers.set(h, v)
		}
		return new Response(res.body, { status: res.status, headers })
	}
}
