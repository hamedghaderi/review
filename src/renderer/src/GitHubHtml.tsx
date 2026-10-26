import DOMPurify from 'dompurify'
import { useEffect, useRef } from 'react'

const MEDIA = /^review-media:\/\/media\/[0-9a-f]{32}$/
// DOMPurify's own list of safe link schemes, plus the one release-note media is served from.
const URI_WITH_MEDIA = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|review-media):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i

/**
 * HTML that GitHub rendered from Markdown, sanitised again here: no scripts, styles, forms or event handlers. Links
 * open in your browser and show where they go; images become links, since the window loads no remote images.
 * `media`: Review's own release notes, whose images and videos the main process serves as `review-media:` (see
 * ReleaseMedia); those are shown, and anything else is still a link. Never set for text written by other people.
 */
export function GitHubHtml({ html, empty, media = false }: { html: string; empty: string; media?: boolean }) {
	const box = useRef<HTMLDivElement>(null)
	useEffect(() => {
		const el = box.current
		if (!el) return
		const frag = DOMPurify.sanitize(html, {
			USE_PROFILES: { html: true },
			FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'audio', ...(media ? [] : ['video', 'source'])],
			...(media ? { ALLOWED_URI_REGEXP: URI_WITH_MEDIA } : {}),
			RETURN_DOM_FRAGMENT: true,
		})
		for (const a of frag.querySelectorAll('a')) {
			const href = a.getAttribute('href') ?? ''
			if (/^https?:\/\//i.test(href)) {
				a.setAttribute('target', '_blank')
				a.setAttribute('rel', 'noreferrer noopener')
				a.setAttribute('title', href)
			} else a.removeAttribute('href') // in-page anchors and other schemes: text only
		}
		const label = (alt: string | null | undefined, kind: string) => `${kind === 'video' ? '▶' : '🖼'} ${alt?.trim() || kind}`
		for (const img of frag.querySelectorAll('img')) {
			const src = img.getAttribute('src') ?? ''
			if (media && MEDIA.test(src)) {
				img.setAttribute('loading', 'lazy')
				img.addEventListener('error', () =>
					img.replaceWith(Object.assign(document.createElement('span'), { textContent: label(img.alt, 'image') })),
				)
				continue
			}
			const link = document.createElement(/^https?:\/\//i.test(src) ? 'a' : 'span')
			link.textContent = label(img.getAttribute('alt'), 'image')
			link.className = 'desc-image'
			if (link instanceof HTMLAnchorElement) {
				link.href = src
				link.target = '_blank'
				link.rel = 'noreferrer noopener'
				link.title = 'Images aren’t loaded in the app. Opens in your browser.'
			}
			// GitHub wraps images in a link to the full-size file; keep a single link.
			const parent = img.parentElement
			if (parent instanceof HTMLAnchorElement && parent.childNodes.length === 1) parent.replaceWith(link)
			else img.replaceWith(link)
		}
		for (const video of frag.querySelectorAll('video')) {
			const sources = [video.getAttribute('src'), ...[...video.querySelectorAll('source')].map((s) => s.getAttribute('src'))]
			const own = sources.filter((s): s is string => !!s && MEDIA.test(s))
			// Only the release's own files play; a video from anywhere else isn't loaded.
			for (const s of video.querySelectorAll('source')) if (!MEDIA.test(s.getAttribute('src') ?? '')) s.remove()
			if (!own.length) {
				video.replaceWith(Object.assign(document.createElement('span'), { className: 'desc-image', textContent: label(null, 'video') }))
				continue
			}
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
	return <div ref={box} className={`md-body selectable${media ? ' with-media' : ''}`} />
}
