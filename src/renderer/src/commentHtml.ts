import DOMPurify, { type Config } from 'dompurify'
import { notesNotShown } from './commentHidden.ts'
import { webUrl } from './commentLinks.ts'

/**
 * GitHub's HTML for a comment, made safe and readable: the sanitising and stand-ins GitHubHtml shows it with, and the
 * plain-text preview and hidden-note check that read it the same way.
 */

const MEDIA = /^review-media:\/\/media\/[0-9a-f]{32}$/
// DOMPurify's own list of safe link schemes, plus the one release-note media is served from.
const URI_WITH_MEDIA = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|review-media):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i

export const sanitizeConfig = (media: boolean): Config => ({
	USE_PROFILES: { html: true },
	// Videos are kept here only so standIns can turn them into links; none from outside the app plays.
	FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'audio'],
	// No inline styles: GitHub strips them from what people write, but if one got through it could lay a fake banner
	// or button over the app (`position: fixed`). Our CSS does what GitHub's own inline styles did.
	FORBID_ATTR: ['style'],
	...(media ? { ALLOWED_URI_REGEXP: URI_WITH_MEDIA } : {}),
})

// Elements that show something with no text in them, so a comment holding one isn't empty.
export const SHOWS_WITHOUT_TEXT = 'img, video, hr, input, details' // a <details> with no <summary> still reads "Details"
/** What a comment that shows nothing says, in the comment and its preview alike. */
export const NOTHING_VISIBLE = 'No visible text.'

/**
 * Prepares sanitised HTML for showing, in place: links only to addresses a browser can open, and words or links in
 * place of the images and videos the app doesn't load. The comment and its preview (commentText) both go through
 * here, so a preview reads exactly like the comment. `doc` makes the new elements.
 */
export function standIns(root: ParentNode, doc: Document, media: boolean): void {
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
	// How many images each link held to begin with: one emptied by removing several icons still had something to say.
	const held = new Map([...root.querySelectorAll('a')].map((a) => [a, a.querySelectorAll('img, video').length]))
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
		// GitHub links an image to its own full-size file; anywhere else (a CI run, a report) is the author's link. Only
		// an exact match counts: a signed address can depend on its spelling (`%2f` and `%2F`), so a near match keeps
		// the author's link rather than dropping it with an icon.
		const toSelf = !href || [src, img.getAttribute('data-canonical-src')].some((s) => webUrl(s) === href)
		if (decorative(img)) {
			// The link is all there is (it goes elsewhere, or held several icons): keep it findable.
			if (only && (!toSelf || held.get(a!)! > 1)) box.replaceWith(`🔗 ${new URL(href!).hostname}`)
			else (only ? a : box).remove()
			continue
		}
		const text = label(img.getAttribute('alt'), 'image')
		// Inside a link: words in its place, never a link inside a link.
		if (a && !(only && toSelf)) box.replaceWith(text)
		// The author's link to the image opens as they wrote it (a signed address can depend on its exact spelling);
		// without one, the image's own address.
		else (a ?? box).replaceWith(mediaLink(doc, href ?? src, text, 'Images aren’t loaded in the app. Opens in your browser.'))
	}
	for (const video of root.querySelectorAll('video')) {
		const sources = [video.getAttribute('src'), ...[...video.querySelectorAll('source')].map((s) => s.getAttribute('src'))]
		const own = media ? sources.filter((s): s is string => !!s && MEDIA.test(s)) : []
		// Only the release's own files play; a video from anywhere else isn't loaded, only linked (an attachment
		// GitHub shows inline would otherwise vanish from the comment).
		if (!own.length) {
			const web = sources.map((s) => webUrl(s)).find((s) => s !== null) ?? null
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
	// A suggested change's removed and added lines: the - and + as text, so the preview has them too.
	for (const [cls, mark] of [
		['blob-code-deletion', '-'],
		['blob-code-addition', '+'],
	] as const)
		for (const cell of root.querySelectorAll(`.${cls}`))
			cell.prepend(Object.assign(doc.createElement('span'), { className: 'blob-marker', textContent: `${mark} ` }))
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
 * An icon, not content: an empty alt and a declared size no bigger than an icon's (CodeRabbit's are 16 or 20px). One
 * declared side is enough when the other is left out, as for a square icon given only `width="16"`; an empty alt
 * already says the image adds nothing to the text. A plain `![](screenshot.png)` has an empty alt but no size, so it
 * stays as a link; so does an image with a size that isn't a whole number of pixels (`-1`, `auto`), which says nothing
 * about it being small.
 */
function decorative(img: Element): boolean {
	if (img.getAttribute('alt')?.trim() !== '') return false
	const sides = ['width', 'height'].map((a) => img.getAttribute(a)?.trim() ?? null)
	const sizes = sides.filter((v): v is string => v !== null && v !== '')
	return (
		sizes.length > 0 &&
		sides.every((v) => v === null || v === '' || /^\d+(?:px)?$/i.test(v)) &&
		sizes.every((v) => parseInt(v, 10) <= ICON_PX)
	)
}

const ICON_PX = 32
const BLOCKS =
	'address,article,aside,blockquote,dd,details,div,dl,dt,figcaption,figure,h1,h2,h3,h4,h5,h6,hr,li,ol,p,pre,section,summary,table,tr,ul'
// Per comment object, so they last as long as the discussion they came with and go with it, however many it holds.
// The HTML is kept with each answer in case an object is reused for another comment.
const texts = new WeakMap<object, { html: string; text: string }>()
const notes = new WeakMap<object, { html: string; body: string; found: Array<string> }>()

/**
 * The `<!-- … -->` notes in a comment that GitHub doesn't show but the AI reviewer reads (see notesNotShown), so a
 * note can't carry instructions to the AI unseen. Compared with all the text GitHub renders, folded sections and code
 * included. None when there's no HTML: then the comment is shown as written, notes and all.
 */
export function hiddenNotes(c: { body: string; html?: string }): Array<string> {
	if (c.html === undefined || !c.body.includes('<!--')) return []
	const cached = notes.get(c)
	if (cached && cached.html === c.html && cached.body === c.body) return cached.found
	const body = DOMPurify.sanitize(c.html, { ...sanitizeConfig(false), RETURN_DOM: true }) as HTMLElement
	// The only place a note as written can show: in code. (Not in an image's alt text, its 🖼 label: DOMPurify drops
	// any attribute holding `-->`, so the label reads "image".)
	// Each piece once: a <pre> holds its <code>, so not both. A suggested change's lines count as code too.
	const canShow = [...body.querySelectorAll('pre, code:not(pre code), .blob-code-inner')].map((code) => code.textContent ?? '').join('\n')
	const found = notesNotShown(c.body, canShow)
	notes.set(c, { html: c.html, body: c.body, found })
	return found
}
// Private-use characters, which trimming and whitespace collapsing don't touch: a space in code, a blank line in code.
const CODE_SPACE = '\uE000'
const CODE_BLANK = '\uE001'
const CODE_ESCAPE = '\uE002' // + 0, 1 or 2: one of these three as the comment itself wrote it

/**
 * A comment as plain text, for one-line and clamped previews: the words of the comment exactly as GitHubHtml shows it
 * (same sanitising, same words for images and videos; no Markdown marks, tags or hidden `<!-- -->` notes), else the
 * body as written: rare (GitHub sent no HTML, or too much), so its Markdown isn't interpreted. Block elements end a
 * line and table cells are kept apart, even when GitHub put no whitespace between them; code keeps its indentation and
 * blank lines; a checklist item reads `[x]` or `[ ]`. A comment with nothing to read says NOTHING_VISIBLE, as the
 * comment itself does. Nothing here is attached to the page, so nothing loads.
 */
export function commentText(c: { body: string; html?: string }): string {
	if (c.html === undefined) return c.body.trim() || NOTHING_VISIBLE
	const cached = texts.get(c)
	if (cached?.html === c.html) return cached.text || NOTHING_VISIBLE
	{
		const body = DOMPurify.sanitize(c.html, { ...sanitizeConfig(false), RETURN_DOM: true }) as HTMLElement
		// A closed <details> shows only its summary, so that's all the preview reads of it.
		// Without a <summary>, the browser labels it "Details".
		for (const d of body.querySelectorAll('details')) {
			const summary = [...d.children].find((child) => child.nodeName === 'SUMMARY')
			if (!d.hasAttribute('open')) d.replaceChildren(summary ?? 'Details')
			else if (!summary) d.prepend('Details') // open, it still shows the browser's label
		}
		standIns(body, body.ownerDocument, false)
		for (const box of body.querySelectorAll('input[type="checkbox"]')) box.replaceWith(box.hasAttribute('checked') ? '[x] ' : '[ ] ')
		// The comment's own private-use characters, escaped so they're never taken for the stand-ins below.
		const own = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT)
		for (let n = own.nextNode(); n; n = own.nextNode())
			n.nodeValue = n.nodeValue!.replace(/[\uE000-\uE002]/g, (ch) => `${CODE_ESCAPE}${ch.charCodeAt(0) - 0xe000}`)
		for (const br of body.querySelectorAll('pre br, .blob-code-inner br')) br.replaceWith('\n') // a line break in code
		// Code keeps its spacing and blank lines: written with stand-ins the steps below leave alone, put back at the end.
		for (const code of body.querySelectorAll('pre, .blob-code-inner'))
			code.textContent = code
				.textContent!.replace(/\n$/, '')
				.split('\n')
				.map((l) => l.replace(/[ \t]/g, (c) => (c === '\t' ? CODE_SPACE.repeat(4) : CODE_SPACE)) || CODE_BLANK)
				.join('\n')
		// Line breaks in the HTML source are spaces on screen (outside code blocks); only the ones added below end a line.
		const walk = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT)
		for (let n = walk.nextNode(); n; n = walk.nextNode())
			if (!n.parentElement!.closest('pre, .blob-code-inner')) n.nodeValue = n.nodeValue!.replace(/\s+/g, ' ')
		for (const br of body.querySelectorAll('br')) br.replaceWith('\n')
		for (const cell of body.querySelectorAll(':is(td, th) + :is(td, th)'))
			if (cell.previousElementSibling!.textContent!.trim()) cell.before(' · ') // not after an empty cell, like a line number
		for (const block of body.querySelectorAll(BLOCKS)) {
			block.before('\n') // text right before a nested block (`Intro<div>Details</div>`) ends its line too
			block.after('\n')
		}
		const divider = !!body.querySelector('hr') // the one thing that shows with no words, so it needs a word here
		const t = (body.textContent ?? '')
			.split('\n')
			.map((l) => l.trim().replace(/ {2,}/g, ' ')) // spaces met from two text nodes; code's are still stand-ins here
			.filter(Boolean)
			.map((l) =>
				l
					.replaceAll(CODE_SPACE, ' ')
					.replaceAll(CODE_BLANK, '')
					.replace(/\uE002([0-2])/g, (_, d: string) => String.fromCharCode(0xe000 + Number(d))),
			)
			.join('\n')
		const text = t || (divider ? 'Divider' : '')
		texts.set(c, { html: c.html, text })
		return text || NOTHING_VISIBLE
	}
}
