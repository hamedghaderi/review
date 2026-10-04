import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { gifCommandAt, gifMarkdown, gifSlashAt, insertGif } from '../../shared/gif.ts'
import type { GifResult } from '../../shared/types.ts'

interface Search {
	results: Array<GifResult>
	next: number | null
	loading: boolean
	loadingMore: boolean
	error: string | null
	needsKey: boolean
	loadMore(): void
}

const IDLE = { results: [], next: null, loading: false, loadingMore: false, error: null, needsKey: false }

/**
 * Searches through the main process while `active`; typing is debounced, and a newer search replaces an older one.
 * `loadMore` appends the next page (the main process caps how many pages one search may load).
 */
function useGifSearch(active: boolean, query: string): Search {
	const [s, setS] = useState<Omit<Search, 'loadMore'>>(IDLE)
	const generation = useRef(0)
	useEffect(() => {
		if (!active) return
		const gen = ++generation.current
		const t = window.setTimeout(
			async () => {
				const status = await window.review.gifStatus()
				if (gen !== generation.current) return
				if (status.ok && status.value.key === 'none') return setS({ ...IDLE, needsKey: true })
				setS({ ...IDLE, loading: true })
				const r = await window.review.gifSearch(query)
				if (gen !== generation.current) return
				if (r.ok) setS({ ...IDLE, results: r.value.results, next: r.value.next })
				else if (r.error.code !== 'cancelled') setS({ ...IDLE, error: r.error.message })
			},
			query ? 400 : 0,
		)
		return () => {
			generation.current++
			window.clearTimeout(t)
		}
	}, [active, query])

	const loadMore = (): void => {
		if (s.next === null || s.loading || s.loadingMore) return
		const gen = generation.current
		const offset = s.next
		setS((x) => ({ ...x, loadingMore: true }))
		void window.review.gifSearch(query, offset).then((r) => {
			if (gen !== generation.current) return
			setS((x) => {
				if (!r.ok) return { ...x, loadingMore: false, error: r.error.code === 'cancelled' ? x.error : r.error.message }
				const seen = new Set(x.results.map((g) => g.id))
				return { ...x, loadingMore: false, results: [...x.results, ...r.value.results.filter((g) => !seen.has(g.id))], next: r.value.next }
			})
		})
	}
	return { ...s, loadMore }
}

interface ResultsProps {
	search: Search
	query: string
	selected: number
	onPick(g: GifResult): void
	onOpenSettings?(): void
	hint?: string
}

/**
 * Previews arrive as data URLs already checked to be GIFs (see main/giphy.ts), so this window never loads a remote
 * image; picking one inserts a Markdown image link to media.giphy.com.
 */
function GifResults({ search, query, selected, onPick, onOpenSettings, hint }: ResultsProps) {
	if (search.needsKey)
		return (
			<div className="small">
				<p>GIF search uses GIPHY and needs a free API key.</p>
				{onOpenSettings ? (
					<button type="button" className="btn small primary" onMouseDown={(e) => e.preventDefault()} onClick={onOpenSettings}>
						Add a key in Settings → GitHub
					</button>
				) : (
					<p className="muted">Add one in Settings → GitHub.</p>
				)}
			</div>
		)
	return (
		<>
			{search.error && <p className="small error-text">{search.error}</p>}
			<div
				className="gif-grid"
				aria-busy={search.loading || search.loadingMore}
				role="listbox"
				aria-label="GIFs"
				// Loads the next page a little before the end is reached.
				onScroll={(e) => {
					const el = e.currentTarget
					if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) search.loadMore()
				}}
			>
				{search.results.map((g, i) => (
					<button
						key={g.id}
						type="button"
						role="option"
						aria-selected={i === selected}
						className={i === selected ? 'on' : ''}
						title={g.title}
						// Keeps the focus (and cursor) in the comment box.
						onMouseDown={(e) => e.preventDefault()}
						onClick={() => onPick(g)}
					>
						<img src={g.preview} alt={g.title} />
					</button>
				))}
				{!search.loading && !search.error && !search.results.length && <span className="muted small">No GIFs found</span>}
				{search.next !== null && search.results.length > 0 && (
					<button
						type="button"
						className="gif-more"
						disabled={search.loadingMore}
						onMouseDown={(e) => e.preventDefault()}
						onClick={search.loadMore}
					>
						{search.loadingMore ? 'Loading…' : 'Load more'}
					</button>
				)}
			</div>
			<div className="gif-foot muted small">
				{search.loading ? 'Searching…' : query ? `${search.results.length} results for “${query}”` : 'Trending'} · Powered by GIPHY · Rating
				G{hint ? ` · ${hint}` : ''}
			</div>
		</>
	)
}

/**
 * A panel drawn over the whole window, next to `anchor`: above or below it, whichever has more room, never taller than
 * that room (its content scrolls instead). Drawn outside any dialog, so a dialog edge cannot cut it off.
 */
function Floating({
	anchor,
	prefer,
	panelRef,
	className,
	label,
	children,
	onKeyDown,
}: {
	anchor: RefObject<HTMLElement | null>
	prefer: 'above' | 'below'
	panelRef?: RefObject<HTMLDivElement | null>
	className: string
	label: string
	children: ReactNode
	onKeyDown?(e: KeyboardEvent<HTMLDivElement>): void
}) {
	const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' })
	useLayoutEffect(() => {
		const place = (): void => {
			const el = anchor.current
			if (!el) return
			const r = el.getBoundingClientRect()
			const gap = 6
			const margin = 8
			const width = Math.min(380, window.innerWidth - 2 * margin)
			const left = Math.max(margin, Math.min(r.left, window.innerWidth - width - margin))
			const above = r.top - gap - margin
			const below = window.innerHeight - r.bottom - gap - margin
			const up = prefer === 'above' ? above >= 240 || above >= below : below < 240 && above > below
			setStyle(
				up
					? { left, width, bottom: window.innerHeight - r.top + gap, maxHeight: Math.min(420, above) }
					: { left, width, top: r.bottom + gap, maxHeight: Math.min(420, below) },
			)
		}
		place()
		window.addEventListener('resize', place)
		window.addEventListener('scroll', place, true)
		return () => {
			window.removeEventListener('resize', place)
			window.removeEventListener('scroll', place, true)
		}
	}, [anchor, prefer])
	return createPortal(
		<div ref={panelRef} className={`floating ${className}`} style={style} role="dialog" aria-label={label} onKeyDown={onKeyDown}>
			{children}
		</div>,
		document.body,
	)
}

interface PickerProps {
	disabled?: boolean
	onPick(markdown: string): void
	onOpenSettings(): void
}

/** The GIF button: a popover with its own search field. */
export function GifPicker({ disabled, onPick, onOpenSettings }: PickerProps) {
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState('')
	const search = useGifSearch(open, query)
	const root = useRef<HTMLDivElement>(null)
	const panel = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (!open) return
		const close = (e: MouseEvent): void => {
			const t = e.target as Node
			if (!root.current?.contains(t) && !panel.current?.contains(t)) setOpen(false)
		}
		document.addEventListener('mousedown', close)
		return () => document.removeEventListener('mousedown', close)
	}, [open])

	return (
		<div className="emoji-picker" ref={root}>
			<button
				type="button"
				className="btn small ghost"
				disabled={disabled}
				aria-haspopup="dialog"
				aria-expanded={open}
				title="Insert a GIF from GIPHY (or type /gif and a word in the text)"
				onClick={() => setOpen((x) => !x)}
			>
				GIF
			</button>
			{open && (
				<Floating
					anchor={root}
					prefer="above"
					panelRef={panel}
					className="gif-pop"
					label="GIF"
					onKeyDown={(e) => {
						if (e.key === 'Escape') {
							e.stopPropagation()
							setOpen(false)
						}
					}}
				>
					<input autoFocus placeholder="Search GIPHY" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search GIFs" />
					<GifResults
						search={search}
						query={query}
						selected={-1}
						onPick={(g) => {
							onPick(gifMarkdown(g))
							setOpen(false)
							setQuery('')
						}}
						onOpenSettings={() => {
							setOpen(false)
							onOpenSettings()
						}}
					/>
				</Floating>
			)}
		</div>
	)
}

/**
 * "/gif party" typed in a text box opens GIF results for "party" next to it; picking one (click, or arrows and Enter)
 * replaces the command with the image. Esc closes it until the command is typed again.
 * `onKeyDown` returns true when it handled the key, so the box skips its own shortcuts.
 */
export function useGifCommand(
	text: string,
	ref: RefObject<HTMLTextAreaElement | null>,
	apply: (next: string, cursor: number) => void,
	onOpenSettings?: () => void,
	prefer: 'above' | 'below' = 'below',
): { panel: ReactNode; onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean } {
	const cursor = ref.current?.selectionEnd ?? text.length
	const cmd = gifCommandAt(text, cursor)
	const slash = cmd ? null : gifSlashAt(text, cursor)
	const [slashDismissed, setSlashDismissed] = useState<number | null>(null)
	const suggest = !!slash && slashDismissed !== slash.start
	const [dismissed, setDismissed] = useState<number | null>(null)
	const [selected, setSelected] = useState(0)
	const active = !!cmd && dismissed !== cmd.start
	const search = useGifSearch(active, cmd?.query ?? '')

	useEffect(() => {
		if (!cmd && dismissed !== null) setDismissed(null)
	}, [cmd, dismissed])
	useEffect(() => {
		if (!slash && slashDismissed !== null) setSlashDismissed(null)
	}, [slash, slashDismissed])

	// Completes "/", "/g"… to "/gif ", which opens the search.
	const complete = (): void => {
		if (!slash) return
		const next = `${text.slice(0, slash.start)}/gif ${text.slice(cursor)}`
		const at = slash.start + 5
		apply(next, at)
		requestAnimationFrame(() => {
			ref.current?.focus()
			ref.current?.setSelectionRange(at, at)
		})
	}
	useEffect(() => setSelected(0), [cmd?.query])

	const pick = (g: GifResult): void => {
		if (!cmd) return
		const r = insertGif(text, cmd.start, cmd.end, gifMarkdown(g))
		apply(r.text, r.cursor)
		requestAnimationFrame(() => {
			ref.current?.focus()
			ref.current?.setSelectionRange(r.cursor, r.cursor)
		})
	}

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
		if (suggest && slash) {
			if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey)) {
				e.preventDefault()
				complete()
				return true
			}
			if (e.key === 'Escape') {
				e.preventDefault()
				e.stopPropagation()
				setSlashDismissed(slash.start)
				return true
			}
			return false
		}
		if (!active || !cmd) return false
		const n = search.results.length
		const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 3, ArrowUp: -3 }[e.key]
		if (move !== undefined && n) {
			e.preventDefault()
			setSelected((i) => Math.min(n - 1, Math.max(0, i + move)))
			return true
		}
		if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && n) {
			e.preventDefault()
			pick(search.results[Math.min(selected, n - 1)])
			return true
		}
		if (e.key === 'Escape') {
			e.preventDefault()
			e.stopPropagation()
			setDismissed(cmd.start)
			return true
		}
		return false
	}

	const panel = suggest ? (
		<Floating anchor={ref} prefer={prefer} className="slash-menu" label="Commands">
			<button type="button" className="slash-item on" onMouseDown={(e) => e.preventDefault()} onClick={complete}>
				<span className="cmd-tag">/gif</span>
				<span>Search GIPHY for a GIF</span>
				<span className="spacer" />
				<kbd>Tab</kbd>
			</button>
		</Floating>
	) : active ? (
		<Floating anchor={ref} prefer={prefer} className="gif-pop gif-command" label="GIF">
			<div className="gif-head">
				<span className="cmd-tag">/gif</span>
				<span className="ellipsis">{cmd.query ? `“${cmd.query}”` : 'Trending'}</span>
				<span className="spacer" />
				<button
					type="button"
					className="btn small ghost"
					aria-label="Close GIF search"
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => setDismissed(cmd.start)}
				>
					✕
				</button>
			</div>
			<GifResults
				search={search}
				query={cmd.query}
				selected={selected}
				onPick={pick}
				onOpenSettings={onOpenSettings}
				hint="arrows and Enter to pick, Esc to close"
			/>
		</Floating>
	) : null
	return { panel, onKeyDown }
}
