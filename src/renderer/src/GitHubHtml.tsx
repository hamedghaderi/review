import DOMPurify from 'dompurify'
import { useEffect, useRef } from 'react'
import { webUrl, withoutNotes } from './commentLinks.ts'

const MEDIA = /^review-media:\/\/media\/[0-9a-f]{32}$/
// DOMPurify's own list of safe link schemes, plus the one release-note media is served from.
const URI_WITH_MEDIA = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|review-media):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i

/**
 * HTML that GitHub rendered from Markdown, sanitised again here: no scripts, styles, forms or event handlers. Links
 * open in your browser and show where they go; images and videos become links, since the window loads no remote
 * media. Small images with an empty alt (decorative, like a bot's 16px severity icon) are left out.
 * `media`: Review's own release notes, whose images and videos the main process serves as `review-media:` (see
 * ReleaseMedia); those are shown, and anything else is still a link. Never set for text written by other people.
 * `className`: added to `md-body`, e.g. to fit it inside a comment card.
 */
export function GitHubHtml({
	html,
	empty,
	media = false,
	className,
}: {
	html: string
	empty: string
	media?: boolean
	className?: string
}) {
	const box = useRef<HTMLDivElement>(null)
	useEffect(() => {
		const el = box.current
		if (!el) return
		const frag = DOMPurify.sanitize(html, {
			USE_PROFILES: { html: true },
			// Videos are kept here only so the loop below can turn them into links; none from outside the app plays.
			FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'audio'],
			...(media ? { ALLOWED_URI_REGEXP: URI_WITH_MEDIA } : {}),
			RETURN_DOM_FRAGMENT: true,
		})
		for (const a of frag.querySelectorAll('a')) {
			const href = webUrl(a.getAttribute('href'))
			if (href) {
				a.setAttribute('href', href) // the parsed form, which is what the title shows and what opens
				a.setAttribute('target', '_blank')
				a.setAttribute('rel', 'noreferrer noopener')
				a.setAttribute('title', href)
			} else a.removeAttribute('href') // in-page anchors, other schemes, malformed addresses: text only
		}
		// A <picture>'s other files: its <img> stands for it below.
		for (const s of frag.querySelectorAll('picture > source')) s.remove()
		for (const img of frag.querySelectorAll('img')) {
			const src = img.getAttribute('src') ?? ''
			if (media && MEDIA.test(src)) {
				img.setAttribute('loading', 'lazy')
				img.addEventListener('error', () =>
					img.replaceWith(Object.assign(document.createElement('span'), { textContent: label(img.alt, 'image') })),
				)
				continue
			}
			const text = imageText(img)
			const box = img.parentElement?.tagName === 'PICTURE' ? img.parentElement : img
			// A link from the image to somewhere else (a badge to its CI run, an icon to a report): keep that link, with
			// words for the image.
			if (linkElsewhere(img)) {
				box.replaceWith(text!)
				continue
			}
			// GitHub wraps images in a link to the full-size file; keep a single link, or none for an icon.
			const wrapper = linkAround(img)
			if (text === null) {
				;(wrapper ?? box).remove()
				continue
			}
			;(wrapper ?? box).replaceWith(mediaLink(src, text, 'Images aren’t loaded in the app. Opens in your browser.'))
		}
		for (const video of frag.querySelectorAll('video')) {
			const sources = [video.getAttribute('src'), ...[...video.querySelectorAll('source')].map((s) => s.getAttribute('src'))]
			const own = media ? sources.filter((s): s is string => !!s && MEDIA.test(s)) : []
			// Only the release's own files play; a video from anywhere else isn't loaded, only linked (an attachment
			// GitHub shows inline would otherwise vanish from the comment).
			if (!own.length) {
				const web = sources.map(webUrl).find((s) => s !== null) ?? null
				video.replaceWith(mediaLink(web, label(null, 'video'), 'Videos aren’t played in the app. Opens in your browser.'))
				continue
			}
			for (const s of video.querySelectorAll('source')) if (!MEDIA.test(s.getAttribute('src') ?? '')) s.remove()
			if (video.getAttribute('src') && !MEDIA.test(video.getAttribute('src')!)) video.removeAttribute('src')
			video.removeAttribute('autoplay')
			video.removeAttribute('loop')
			video.removeAttribute('muted') // GitHub mutes uploads; nothing plays until you press play
			video.setAttribute('controls', '')
			video.setAttribute('preload', 'metadata')
			video.setAttribute('playsinline', '')
			video.addEventListener(
				'error',
				() => video.replaceWith(Object.assign(document.createElement('span'), { textContent: label(null, 'video') })),
				true,
			)
		}
		for (const input of frag.querySelectorAll('input')) input.setAttribute('disabled', '')
		el.replaceChildren(frag)
	}, [html, media])
	if (!html.trim()) return <p className="small muted desc-note">{empty}</p>
	return <div ref={box} className={`md-body selectable${media ? ' with-media' : ''}${className ? ` ${className}` : ''}`} />
}

const label = (alt: string | null | undefined, kind: 'image' | 'video') => `${kind === 'video' ? '▶' : '🖼'} ${alt?.trim() || kind}`

/**
 * The words that stand for an image that isn't loaded, the same in the comment and its preview: "🖼 alt"; for an icon,
 * "🔗 host" when it links somewhere else, else null (left out).
 */
function imageText(img: Element): string | null {
	if (!decorative(img)) return label(img.getAttribute('alt'), 'image')
	const href = linkElsewhere(img)
	return href ? `🔗 ${hostOf(href)}` : null
}

/** The link whose only content is this image (also inside a <picture>), if there is one. */
function linkAround(img: Element): Element | null {
	const a = img.closest('a')
	return a && !a.textContent?.trim() && a.querySelectorAll('img').length === 1 ? a : null
}

/** Where the link around the image goes (see webUrl), when that's a web page other than the image itself. */
function linkElsewhere(img: Element): string | null {
	const href = webUrl(linkAround(img)?.getAttribute('href'))
	const self = [img.getAttribute('src'), img.getAttribute('data-canonical-src')].map(webUrl)
	return href && !self.includes(href) ? href : null
}

const hostOf = (href: string) => new URL(href).hostname // href passed webUrl, so it parses

/** A link to an image or video that isn't loaded in the app, or plain text when `src` isn't a web address (see webUrl). */
function mediaLink(src: string | null, text: string, title: string): HTMLElement {
	const url = webUrl(src)
	const link = document.createElement(url ? 'a' : 'span')
	link.textContent = text
	link.className = 'desc-image'
	if (url && link instanceof HTMLAnchorElement) {
		link.href = url
		link.target = '_blank'
		link.rel = 'noreferrer noopener'
		link.title = `${title}\n${url}`
	}
	return link
}

/**
 * An icon, not content: an empty alt and a declared size no bigger than an icon's (CodeRabbit's are 16 or 20px). A
 * plain `![](screenshot.png)` also has an empty alt but no size, so it stays as a link.
 */
function decorative(img: Element): boolean {
	const size = (a: string) => Number(img.getAttribute(a) || NaN)
	return img.getAttribute('alt')?.trim() === '' && size('width') <= ICON_PX && size('height') <= ICON_PX
}

const ICON_PX = 32
const BLOCKS =
	'address,article,aside,blockquote,dd,details,div,dl,dt,figcaption,figure,h1,h2,h3,h4,h5,h6,hr,li,ol,p,pre,section,summary,table,tr,ul'
const texts = new Map<string, string>()

/**
 * A comment as plain text, for one-line and clamped previews: the words of GitHub's HTML when there is some (no
 * Markdown marks, tags or hidden `<!-- -->` notes; images and videos as the same words the comment shows), else the
 * body as written without its hidden notes (see withoutNotes). Block elements end a line even when GitHub put no
 * newline between them. The HTML is parsed in an inert document, so nothing in it loads or runs.
 */
export function commentText(c: { body: string; html?: string }): string {
	if (!c.html) return withoutNotes(c.body).trim()
	let t = texts.get(c.html)
	if (t === undefined) {
		const doc = new DOMParser().parseFromString(c.html, 'text/html')
		for (const img of doc.body.querySelectorAll('img')) img.replaceWith(imageText(img) ?? '')
		for (const video of doc.body.querySelectorAll('video')) video.replaceWith(label(null, 'video'))
		for (const br of doc.body.querySelectorAll('br')) br.replaceWith('\n')
		for (const block of doc.body.querySelectorAll(BLOCKS)) block.after('\n')
		t = (doc.body.textContent ?? '')
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean)
			.join('\n')
		if (texts.size > 500) texts.delete(texts.keys().next().value!)
		texts.set(c.html, t)
	}
	return t
}
