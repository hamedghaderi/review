import type { Mermaid, MermaidConfig } from 'mermaid'

/**
 * Mermaid diagrams in a rendered Markdown file (issue #258). A ```mermaid block shows as code with a button that
 * draws it; Mermaid is loaded only then, and runs in its strictest mode: labels can't hold markup and diagrams can't
 * link or run anything.
 *
 * The drawing is then shown as an image (an SVG data URL in an <img>), never as SVG in the page. An image can't run
 * scripts, load anything, or let its CSS reach the app, so whatever a diagram's author slips past Mermaid stays inside
 * the picture. The app uses system fonts, which an image can use too, so labels fit as Mermaid measured them.
 *
 * Colours come from the app's theme; a drawn diagram is drawn again when the theme changes. A diagram that can't be
 * drawn stays as code, with Mermaid's error under it.
 */

let loading: Promise<Mermaid> | null = null
const load = (): Promise<Mermaid> => (loading ??= import('mermaid').then((m) => m.default))

// Mermaid has one configuration and draws into the page while it works, so diagrams are drawn one at a time.
let queue: Promise<unknown> = Promise.resolve()
let seq = 0

// Settings a diagram's own `%%{init: …}%%` may not change: how safe it is, and how it looks next to the app.
const LOCKED = [
	'secure',
	'securityLevel',
	'startOnLoad',
	'maxTextSize',
	'maxEdges',
	'suppressErrorRendering',
	'theme',
	'themeVariables',
	'themeCSS',
	'darkMode',
	'fontFamily',
	'altFontFamily',
]

/**
 * Offers to draw each diagram under `root`: a "Draw diagram" button above its code. Nothing of Mermaid loads or runs
 * until you click one, so a diagram in a pull request does nothing, and can't hang the window, unless you ask for it.
 * `drawn` holds the diagrams (by their text) you have asked for in this view; those are drawn again without asking,
 * as when the theme changes. Returns a function that stops, for when the view is redrawn or closed.
 */
export function offerDiagrams(root: HTMLElement, drawn: Set<string>): () => void {
	let live = true
	const isLive = (): boolean => live
	for (const code of root.querySelectorAll<HTMLElement>('pre > code.language-mermaid')) {
		const pre = code.parentElement!
		const text = code.textContent ?? ''
		if (drawn.has(text)) {
			draw(pre, text, isLive)
			continue
		}
		const button = document.createElement('button')
		button.className = 'btn small mermaid-draw'
		button.textContent = 'Draw diagram'
		button.title = 'Draw this Mermaid diagram from its code. Diagrams in a file are drawn only when you ask.'
		button.addEventListener('click', () => {
			drawn.add(text)
			button.disabled = true
			button.textContent = 'Drawing…'
			draw(pre, text, isLive, () => button.remove())
		})
		pre.before(button)
	}
	return () => {
		live = false
	}
}

/** Draws one diagram in place of its code; `done` runs once it is drawn or has failed. */
function draw(pre: HTMLElement, text: string, live: () => boolean, done?: () => void): void {
	pre.classList.add('mermaid-pending')
	queue = queue.then(async () => {
		if (!live()) return
		try {
			const mermaid = await load()
			mermaid.initialize(config())
			const { svg } = await mermaid.render(`mermaid-${++seq}`, text)
			if (!live()) return
			const fig = figure(svg)
			fig.querySelector('img')!.addEventListener(
				'error',
				() => {
					fig.replaceWith(pre)
					failed(pre, 'the drawing could not be shown.')
				},
				{ once: true },
			)
			pre.replaceWith(fig)
		} catch (e) {
			if (live()) failed(pre, e instanceof Error ? e.message : String(e))
		} finally {
			done?.()
		}
	})
}

function failed(pre: HTMLElement, message: string): void {
	pre.classList.remove('mermaid-pending')
	if (!pre.isConnected) return
	const note = document.createElement('p')
	note.className = 'small error-text mermaid-error'
	note.textContent = `This diagram couldn’t be drawn: ${message.trim().split('\n')[0]}`
	pre.after(note)
}

/** The drawing as an image the size Mermaid drew it, or smaller to fit. Its alt text is the diagram's own title. */
function figure(svg: string): HTMLElement {
	// Parsed as HTML (Mermaid writes <br>, which isn't XML), written back as XML, which an SVG image must be.
	const el = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg')
	const box = el
		?.getAttribute('viewBox')
		?.split(/[\s,]+/)
		.map(Number)
	const img = document.createElement('img')
	if (el && box?.length === 4 && box.every(Number.isFinite)) {
		el.setAttribute('width', String(Math.ceil(box[2])))
		el.setAttribute('height', String(Math.ceil(box[3])))
		el.removeAttribute('style') // Mermaid's max-width; the page sizes the image
		img.width = Math.ceil(box[2])
		img.height = Math.ceil(box[3])
	}
	img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(el ? new XMLSerializer().serializeToString(el) : svg)}`
	img.alt = el?.querySelector(':scope > title')?.textContent?.trim() || 'Diagram'
	const fig = document.createElement('figure')
	fig.className = 'mermaid-diagram'
	fig.append(img)
	return fig
}

/** Mermaid's settings, coloured like the app's current theme. */
function config(): MermaidConfig {
	const css = getComputedStyle(document.documentElement)
	const colour = (name: string, fallback: string): string => {
		const v = css.getPropertyValue(name).trim()
		return /^#[0-9a-f]{3,8}$/i.test(v) ? v : fallback
	}
	const bg = colour('--bg', '#ffffff')
	const text = colour('--text', '#262631')
	const font = css.getPropertyValue('--sans').trim() || 'system-ui, sans-serif'
	return {
		startOnLoad: false,
		securityLevel: 'strict',
		suppressErrorRendering: true,
		secure: LOCKED,
		theme: 'base',
		darkMode: dark(bg),
		fontFamily: font,
		themeVariables: {
			darkMode: dark(bg),
			fontFamily: font,
			background: bg,
			primaryColor: colour('--panel', '#fafafd'),
			primaryTextColor: text,
			primaryBorderColor: colour('--border-strong', '#d2d2de'),
			secondaryColor: colour('--accent-soft', '#efeaff'),
			tertiaryColor: colour('--hover', '#f1f1f6'),
			lineColor: colour('--text-2', '#6b6b7b'),
			textColor: text,
			edgeLabelBackground: bg,
			noteBkgColor: colour('--accent-soft', '#efeaff'),
			noteTextColor: text,
		},
	}
}

function dark(hex: string): boolean {
	const h = hex.length <= 5 ? [...hex.slice(1, 4)].map((c) => c + c).join('') : hex.slice(1, 7)
	const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
	return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5
}
