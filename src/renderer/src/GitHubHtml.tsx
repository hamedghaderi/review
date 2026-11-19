import DOMPurify from 'dompurify'
import { useEffect, useRef } from 'react'
import { SHOWS_WITHOUT_TEXT, sanitizeConfig, standIns } from './commentHtml.ts'

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
		// Nothing left to see (a comment holding only a bot's icon): say so rather than show an empty box.
		if (!frag.textContent?.trim() && !frag.querySelector(SHOWS_WITHOUT_TEXT))
			el.replaceChildren(Object.assign(document.createElement('p'), { className: 'small muted desc-note', textContent: empty }))
		else el.replaceChildren(frag)
	}, [html, media, empty])
	if (!html.trim()) return <p className="small muted desc-note">{empty}</p>
	return <div ref={box} className={`md-body selectable${media ? ' with-media' : ''}${className ? ` ${className}` : ''}`} />
}
