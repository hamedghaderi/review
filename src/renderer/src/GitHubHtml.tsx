import DOMPurify, { type Config } from 'dompurify'
import { useEffect, useRef } from 'react'
import { webUrl, withoutNotes } from './commentLinks.ts'

const MEDIA = /^review-media:\/\/media\/[0-9a-f]{32}$/
// DOMPurify's own list of safe link schemes, plus the one release-note media is served from.
const URI_WITH_MEDIA = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|review-media):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i

const sanitizeConfig = (media: boolean): Config => ({
	USE_PROFILES: { html: true },
	// Videos are kept here only so standIns can turn them into links; none from outside the app plays.
	FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'audio'],
	...(media ? { ALLOWED_URI_REGEXP: URI_WITH_MEDIA } : {}),
})

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
		const frag = DOMPurify.sanitize(html, { ...sanitizeConfig(media), RETURN_DOM_FRAGMENT: true })
		standIns(frag, document, media)
		el.replaceChildren(frag)
	}, [html, media])
	if (!html.trim()) return <p className="small muted desc-note">{empty}</p>
	return <div ref={box} className={`md-body selectable${media ? ' with-media' : ''}${className ? ` ${className}` : ''}`} />
}

/**
 * Prepares sanitised HTML for showing, in place: links only to addresses a browser can open, and words or links in
 * place of the images and videos the app doesn't load. The comment and its preview (commentText) both go through
 * here, so a preview reads exactly like the comment. `doc` makes the new elements.
 */
function standIns(root: ParentNode, doc: Document, media: boolean): void {
	for (const a of root.querySelectorAll('a')) {
		const href = webUrl(a.getAttribute('href'))
		if (href) {
			a.setAttribute('href', href) // the parsed form, which is what the title shows and what opens
			a.setAttribute('target', '_blank')
			a.setAttribute('rel', 'noreferrer noopener')
			a.setAttribute('title', href)
		} else a.replaceWith(...a.childNodes) // in-page anchors, other schemes, malformed addresses: just their content
	}
	// A <picture>'s other files: its <img> stands for it below.
	for (const s of root.querySelectorAll('picture > source')) s.remove()
	for (const img of root.querySelectorAll('img')) {
		const src = img.getAttribute('src') ?? ''
		if (media && MEDIA.test(src)) {
			img.setAttribute('loading', 'lazy')
			img.addEventListener('error', () =>
				img.replaceWith(Object.assign(doc.createElement('span'), { textContent: label(img.getAttribute('alt'), 'image') })),
			)
			continue
		}
		const box = img.parentElement?.tagName === 'PICTURE' ? img.parentElement : img
		const a = img.closest('a')
		// The link holds nothing but this image. A link shared with text or other badges stays as it is.
		const only = !!a && !a.textContent?.trim() && a.querySelectorAll('img, video').length === 1
		const href = a?.getAttribute('href') ?? null // checked above: links left standing go somewhere real
		// GitHub links an image to its own full-size file; anywhere else (a CI run, a report) is the author's link.
		const toSelf = !href || [src, img.getAttribute('data-canonical-src')].map(webUrl).includes(href)
		if (decorative(img)) {
			if (only && !toSelf)
				box.replaceWith(`🔗 ${new URL(href!).hostname}`) // the link is all there is: keep it findable
			else (only ? a : box).remove()
			continue
		}
		const text = label(img.getAttribute('alt'), 'image')
		// Inside a link: words in its place, never a link inside a link.
		if (a && !(only && toSelf)) box.replaceWith(text)
		else (a ?? box).replaceWith(mediaLink(doc, src, text, 'Images aren’t loaded in the app. Opens in your browser.'))
	}
	for (const video of root.querySelectorAll('video')) {
		const sources = [video.getAttribute('src'), ...[...video.querySelectorAll('source')].map((s) => s.getAttribute('src'))]
		const own = media ? sources.filter((s): s is string => !!s && MEDIA.test(s)) : []
		// Only the release's own files play; a video from anywhere else isn't loaded, only linked (an attachment
		// GitHub shows inline would otherwise vanish from the comment).
		if (!own.length) {
			const web = sources.map(webUrl).find((s) => s !== null) ?? null
			const text = label(null, 'video')
			video.replaceWith(video.closest('a') ? text : mediaLink(doc, web, text, 'Videos aren’t played in the app. Opens in your browser.'))
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
			() => video.replaceWith(Object.assign(doc.createElement('span'), { textContent: label(null, 'video') })),
			true,
		)
	}
	for (const input of root.querySelectorAll('input')) input.setAttribute('disabled', '')
}

const label = (alt: string | null | undefined, kind: 'image' | 'video') => `${kind === 'video' ? '▶' : '🖼'} ${alt?.trim() || kind}`

/** A link to an image or video that isn't loaded in the app, or plain text when `src` isn't a web address (see webUrl). */
function mediaLink(doc: Document, src: string | null, text: string, title: string): HTMLElement {
	const url = webUrl(src)
	const link = doc.createElement(url ? 'a' : 'span')
	link.textContent = text
	link.className = 'desc-image'
	if (url) {
		link.setAttribute('href', url)
		link.setAttribute('target', '_blank')
		link.setAttribute('rel', 'noreferrer noopener')
		link.setAttribute('title', `${title}\n${url}`)
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
 * A comment as plain text, for one-line and clamped previews: the words of the comment exactly as GitHubHtml shows it
 * (same sanitising, same words for images and videos; no Markdown marks, tags or hidden `<!-- -->` notes), else the
 * body as written without its hidden notes (see withoutNotes). Block elements end a line and table cells are kept
 * apart, even when GitHub put no whitespace between them. Nothing here is attached to the page, so nothing loads.
 */
export function commentText(c: { body: string; html?: string }): string {
	if (!c.html) return withoutNotes(c.body).trim()
	let t = texts.get(c.html)
	if (t === undefined) {
		const body = DOMPurify.sanitize(c.html, { ...sanitizeConfig(false), RETURN_DOM: true }) as HTMLElement
		// A closed <details> shows only its summary, so that's all the preview reads of it.
		for (const d of body.querySelectorAll('details:not([open])'))
			for (const child of [...d.childNodes]) if (child.nodeName !== 'SUMMARY') child.remove()
		standIns(body, body.ownerDocument, false)
		// Line breaks in the HTML source are spaces on screen (outside code blocks); only the ones added below end a line.
		const walk = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT)
		for (let n = walk.nextNode(); n; n = walk.nextNode())
			if (!n.parentElement?.closest('pre')) n.nodeValue = n.nodeValue!.replace(/\s+/g, ' ')
		for (const br of body.querySelectorAll('br')) br.replaceWith('\n')
		for (const cell of body.querySelectorAll(':is(td, th) + :is(td, th)')) cell.before(' · ')
		for (const block of body.querySelectorAll(BLOCKS)) {
			block.before('\n') // text right before a nested block (`Intro<div>Details</div>`) ends its line too
			block.after('\n')
		}
		t = (body.textContent ?? '')
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean)
			.join('\n')
		if (texts.size > 500) texts.delete(texts.keys().next().value!)
		texts.set(c.html, t)
	}
	return t
}
