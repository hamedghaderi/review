import DOMPurify from 'dompurify'
import { sanitizeConfig, standIns } from './commentHtml.ts'
import type { MdBlock } from './markdownBlocks.ts'

/**
 * The blocks as sanitised elements, each in a `.md-block` that knows its lines. A changed block, or a changed item of
 * a list, carries `data-changed` and its lines in `data-start` and `data-end`. Apart from the component, so a test
 * can run it in Chromium.
 */
export function renderBlocks(blocks: ReadonlyArray<MdBlock>, doc: Document): DocumentFragment {
	const out = doc.createDocumentFragment()
	for (const b of blocks) {
		const frag = DOMPurify.sanitize(b.html, { ...sanitizeConfig(false), RETURN_DOM_FRAGMENT: true })
		standIns(frag, doc, false)
		const wrap = doc.createElement('div')
		wrap.className = 'md-block'
		wrap.append(frag)
		const lis = b.items ? [...wrap.querySelectorAll(':scope > ul > li, :scope > ol > li')] : []
		// A list marks the items the change touched; one changed only between its items is marked whole.
		if (b.items?.some((it) => it.changed) && lis.length === b.items.length)
			b.items.forEach((it, i) => it.changed && mark(lis[i] as HTMLElement, it.start, it.end))
		else if (b.changed) mark(wrap, b.start, b.end)
		out.append(wrap)
	}
	return out
}

function mark(el: HTMLElement, start: number, end: number): void {
	el.dataset.changed = ''
	el.dataset.start = String(start)
	el.dataset.end = String(end)
}
