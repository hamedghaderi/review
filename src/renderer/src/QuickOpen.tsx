import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { INBOX_LABEL } from '../../shared/inbox.ts'
import { parsePrQuery } from '../../shared/prQuery.ts'
import type { AppError, BranchRef, InboxStatus, PrFilter, PrSummary, RepoInfo, ReviewSummary, ReviewTarget } from '../../shared/types.ts'
import { ago, defaultBaseFor, matchBranches } from './branches.ts'
import { ReviewBadge } from './PrReview.tsx'

interface Props {
	repo: RepoInfo
	githubRepo: string | null
	signedIn: boolean
	viewer: string | null
	reviews: Array<ReviewSummary>
	onConnect(): void
	onClose(): void
	onPickPr(pr: PrSummary): void
	onPickBranch(b: BranchRef): void
	onOpenReview(target: ReviewTarget): void
	onOpenSnapshot(reviewId: string): void
}

type Item = { t: 'pr'; pr: PrSummary } | { t: 'branch'; b: BranchRef } | { t: 'review'; r: ReviewSummary }
type Scope = 'all' | 'prs' | 'branches'
interface Section {
	title: string
	items: Array<Item>
	error?: AppError
}
interface Action {
	label: string
	keys?: string
	run(): void
}

// Row badges must stay short, or they crowd out the title; the full wording is in the tooltip.
const INBOX_SHORT: Record<Exclude<InboxStatus, 'reviewed'>, string> = {
	new: 'New',
	waiting: 'Waiting',
	're-requested': 'Re-requested',
	updated: 'New commits',
}

const SCOPES: Array<{ id: Scope; label: string }> = [
	{ id: 'all', label: 'All' },
	{ id: 'prs', label: 'Pull requests' },
	{ id: 'branches', label: 'Branches' },
]

/** "pr …" and "b …" narrow the palette to one kind, like picking the scope with Tab. */
function scopePrefix(q: string): { scope: Scope | null; text: string } {
	const m = /^(prs?|b|br|branch(?:es)?)\s+/i.exec(q)
	if (!m) return { scope: null, text: q.trim() }
	return { scope: m[1].toLowerCase().startsWith('p') ? 'prs' : 'branches', text: q.slice(m[0].length).trim() }
}

function shortRef(ref: string | null): string {
	return (ref ?? 'HEAD').replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/[^/]+\//, '')
}

function reviewKey(r: ReviewSummary): string {
	const t = r.target
	return !t ? `branch:HEAD|${r.baseRef}` : t.kind === 'pr' ? `pr:${t.repo.toLowerCase()}#${t.number}` : `branch:${t.headRef}|${t.baseRef}`
}

function reviewTitle(r: ReviewSummary): string {
	return r.pr ? r.pr.title : `${shortRef(r.headRef ?? (r.target?.kind === 'branch' ? r.target.headRef : null))} → ${shortRef(r.baseRef)}`
}

function itemKey(it: Item): string {
	return it.t === 'pr' ? `pr:${it.pr.number}` : it.t === 'branch' ? `b:${it.b.ref}` : `r:${it.r.id}`
}

async function copy(text: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text)
	} catch {
		// Clipboard access can be refused; the palette has already closed, so there is nothing to show.
	}
}

/**
 * Cmd/Ctrl+P palette. With no query it shows what you most likely want: PRs waiting for your review, your recent
 * reviews, the checked-out branch and recently updated branches. Typing searches branches instantly and pull requests
 * on GitHub (debounced). Enter opens the review; Cmd+K lists the other actions for the selected row.
 */
export function QuickOpen(props: Props) {
	const { repo, githubRepo, signedIn, viewer, reviews, onConnect, onClose } = props
	const [q, setQ] = useState('')
	const [chosenScope, setChosenScope] = useState<Scope>('all')
	const [cursor, setCursor] = useState(0)
	const [actionsOpen, setActionsOpen] = useState(false)
	const [actionCursor, setActionCursor] = useState(0)
	const [prs, setPrs] = useState<{ key: string; items: Array<PrSummary>; total: number; error: AppError | null } | null>(null)
	const [loading, setLoading] = useState(false)
	const input = useRef<HTMLInputElement>(null)
	const restore = useRef<Element | null>(document.activeElement)
	const req = useRef(0)

	const prefix = scopePrefix(q)
	const scope = prefix.scope ?? chosenScope
	const text = prefix.text
	const words = useMemo(() => text.toLowerCase().split(/\s+/).filter(Boolean), [text])
	const parsed = parsePrQuery(text)
	const exact = parsed.kind === 'number' || parsed.kind === 'url'
	// An empty palette asks for your inbox when signed in (the inbox filter needs a login), otherwise recent open PRs.
	const filter: PrFilter = text ? 'all' : signedIn ? 'inbox' : 'open'
	const fetchKey = `${filter}|${text}`
	const wantPrs = !!githubRepo && scope !== 'branches'

	useEffect(() => {
		input.current?.focus()
		const el = restore.current
		return () => {
			if (el instanceof HTMLElement && document.contains(el)) el.focus()
		}
	}, [])

	useEffect(() => {
		if (!wantPrs) {
			setLoading(false)
			return
		}
		const id = ++req.current
		setLoading(true)
		const t = window.setTimeout(
			() => {
				void window.review.searchPrs(repo.id, { filter, text, cursor: null }, 'palette').then((r) => {
					if (id !== req.current) return
					setLoading(false)
					if (r.ok) setPrs({ key: fetchKey, items: r.value.items.slice(0, 20), total: r.value.total, error: r.value.error })
					else if (r.error.code !== 'cancelled') setPrs({ key: fetchKey, items: [], total: 0, error: r.error })
				})
			},
			text ? 250 : 0,
		)
		return () => window.clearTimeout(t)
	}, [fetchKey, filter, text, repo.id, wantPrs])

	// Earlier results stay on screen, dimmed, until the new search answers, so the list doesn't flash empty.
	const stale = !!prs && prs.key !== fetchKey

	const sections: Array<Section> = useMemo(() => {
		const out: Array<Section> = []
		const prItems = wantPrs ? (prs?.items ?? []) : []
		const prError = wantPrs ? (prs?.error ?? undefined) : undefined
		const latest = new Map<string, ReviewSummary>()
		for (const r of [...reviews].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)))
			if (!latest.has(reviewKey(r))) latest.set(reviewKey(r), r)
		const recentReviews = [...latest.values()]

		if (!text) {
			const waiting = prItems.filter((p) => p.inbox && p.inbox !== 'reviewed')
			const current = repo.branches.find((b) => b.current)
			const locals = new Set(repo.branches.filter((b) => b.kind === 'local').map((b) => b.short))
			const recentBranches = [...repo.branches]
				.filter((b) => !b.current && (b.kind === 'local' || !locals.has(b.short)))
				.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
			if (scope !== 'branches') {
				if (filter === 'inbox' && waiting.length)
					out.push({ title: 'Needs your review', items: waiting.slice(0, 8).map((pr) => ({ t: 'pr', pr })) })
				if (filter === 'open' && prItems.length)
					out.push({ title: 'Open pull requests', items: prItems.slice(0, 8).map((pr) => ({ t: 'pr', pr })) })
				if (prError) out.push({ title: 'Pull requests', items: [], error: prError })
			}
			if (scope === 'all' && recentReviews.length)
				out.push({ title: 'Recent reviews', items: recentReviews.slice(0, 5).map((r) => ({ t: 'review', r })) })
			if (scope !== 'prs') {
				if (current) out.push({ title: 'Checked out', items: [{ t: 'branch', b: current }] })
				out.push({
					title: 'Recent branches',
					items: recentBranches.slice(0, scope === 'branches' ? 30 : 6).map((b) => ({ t: 'branch', b })),
				})
			}
			return out.filter((s) => s.items.length || s.error)
		}

		if (scope === 'all' && !exact) {
			const matches = recentReviews.filter((r) => {
				const hay = `${reviewTitle(r)} ${r.headRef ?? ''} ${r.pr ? `#${r.pr.number}` : ''}`.toLowerCase()
				return words.every((w) => hay.includes(w))
			})
			if (matches.length) out.push({ title: 'Recent reviews', items: matches.slice(0, 3).map((r) => ({ t: 'review', r })) })
		}
		if (scope !== 'prs' && !exact) {
			// A branch that has a pull request in the results is listed once, as that PR.
			const prHeads = new Set(prItems.filter((p) => p.headRef && !p.crossRepo).map((p) => p.headRef))
			const matched = matchBranches(repo.branches, text, 'recent').filter((b) => !prHeads.has(b.short))
			const locals = new Set(matched.filter((b) => b.kind === 'local').map((b) => b.short))
			const branches = matched.filter((b) => b.kind === 'local' || !locals.has(b.short))
			if (branches.length)
				out.push({ title: 'Branches', items: branches.slice(0, scope === 'branches' ? 30 : 6).map((b) => ({ t: 'branch', b })) })
		}
		if (scope !== 'branches' && (prItems.length || prError))
			out.push({
				title: 'Pull requests',
				items: prItems.slice(0, scope === 'prs' ? 20 : 10).map((pr) => ({ t: 'pr', pr })),
				error: prError,
			})
		return out
	}, [prs, wantPrs, reviews, text, words, scope, filter, exact, repo.branches])

	const items = useMemo(() => sections.flatMap((s) => s.items), [sections])
	const selected: Item | undefined = items[cursor]

	useEffect(() => setCursor(0), [q, chosenScope])
	useEffect(() => setActionsOpen(false), [q, chosenScope, cursor])

	const actionsFor = (it: Item): Array<Action> => {
		const close = (fn: () => void) => () => {
			onClose()
			fn()
		}
		if (it.t === 'pr') {
			const pr = it.pr
			const out: Array<Action> = []
			if (githubRepo)
				out.push({
					label: 'Open review',
					keys: '↵',
					run: close(() => props.onOpenReview({ kind: 'pr', repo: githubRepo, number: pr.number })),
				})
			out.push({ label: 'Show in Browse', keys: '⌘↵', run: close(() => props.onPickPr(pr)) })
			out.push({ label: 'Open on GitHub', run: close(() => window.open(pr.url, '_blank')) })
			out.push({ label: 'Copy link', run: close(() => void copy(pr.url)) })
			if (pr.headRef) out.push({ label: 'Copy branch name', run: close(() => void copy(pr.headRef!)) })
			return out
		}
		if (it.t === 'branch') {
			const b = it.b
			const base = defaultBaseFor(b, repo.branches, repo.baseCandidates)
			const baseName = repo.branches.find((x) => x.ref === base)?.name
			const out: Array<Action> = []
			if (base)
				out.push({
					label: `Open review against ${baseName ?? shortRef(base)}`,
					keys: '↵',
					run: close(() => props.onOpenReview({ kind: 'branch', headRef: b.ref, baseRef: base })),
				})
			out.push({
				label: base ? 'Choose a base in Browse' : 'Show in Browse',
				keys: base ? '⌘↵' : '↵',
				run: close(() => props.onPickBranch(b)),
			})
			out.push({ label: 'Copy branch name', run: close(() => void copy(b.short)) })
			return out
		}
		const r = it.r
		const out: Array<Action> = [{ label: 'Open review', keys: '↵', run: close(() => props.onOpenSnapshot(r.id)) }]
		if (r.pr) {
			const url = r.pr.url
			out.push({ label: 'Open on GitHub', run: close(() => window.open(url, '_blank')) })
			out.push({ label: 'Copy link', run: close(() => void copy(url)) })
		}
		const head = r.headRef ?? (r.target?.kind === 'branch' ? r.target.headRef : null)
		if (head && head !== 'HEAD') out.push({ label: 'Copy branch name', run: close(() => void copy(shortRef(head))) })
		return out
	}

	const actions = selected ? actionsFor(selected) : []
	const primary = actions[0]

	const cycleScope = (dir: 1 | -1): void => {
		const i = SCOPES.findIndex((s) => s.id === scope)
		const next = SCOPES[(i + dir + SCOPES.length) % SCOPES.length].id
		setChosenScope(next)
		if (prefix.scope) setQ(text) // the chips take over from a typed prefix
	}

	const onKey = (e: React.KeyboardEvent): void => {
		const mod = e.metaKey || e.ctrlKey
		if (mod && e.key.toLowerCase() === 'k') {
			e.preventDefault()
			if (selected) {
				setActionCursor(0)
				setActionsOpen((o) => !o)
			}
			return
		}
		if (e.key === 'Escape') {
			e.preventDefault()
			e.stopPropagation()
			if (actionsOpen) setActionsOpen(false)
			else onClose()
			return
		}
		if (actionsOpen) {
			if (e.key === 'ArrowDown') {
				e.preventDefault()
				setActionCursor((c) => Math.min(actions.length - 1, c + 1))
			} else if (e.key === 'ArrowUp') {
				e.preventDefault()
				setActionCursor((c) => Math.max(0, c - 1))
			} else if (e.key === 'Enter') {
				e.preventDefault()
				actions[actionCursor]?.run()
			} else if (e.key === 'Tab') e.preventDefault()
			return
		}
		if (e.key === 'ArrowDown') {
			e.preventDefault()
			setCursor((c) => Math.min(items.length - 1, c + 1))
		} else if (e.key === 'ArrowUp') {
			e.preventDefault()
			setCursor((c) => Math.max(0, c - 1))
		} else if (e.key === 'Enter') {
			e.preventDefault()
			if (!selected) return
			const browse = actions.find((a) => a.keys === '⌘↵')
			if (mod && browse) browse.run()
			else primary?.run()
		} else if (e.key === 'Tab') {
			e.preventDefault() // focus stays in the modal palette; Tab switches the scope instead
			cycleScope(e.shiftKey ? -1 : 1)
		}
	}

	useEffect(() => {
		document.getElementById(`qo-${cursor}`)?.scrollIntoView({ block: 'nearest' })
	}, [cursor])

	let index = -1
	return (
		<div className="modal-backdrop top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
			<div className="palette" role="dialog" aria-modal="true" aria-label="Quick open" onKeyDown={onKey}>
				<div className="palette-search">
					<svg
						width="20"
						height="20"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						aria-hidden="true"
					>
						<circle cx="11" cy="11" r="7" />
						<path d="m20 20-3.5-3.5" />
					</svg>
					<input
						ref={input}
						className="palette-input"
						type="search"
						role="combobox"
						aria-expanded
						aria-controls="qo-list"
						aria-activedescendant={selected ? `qo-${cursor}` : undefined}
						placeholder={
							scope === 'prs'
								? 'Search pull requests'
								: scope === 'branches' || !githubRepo
									? 'Search branches'
									: 'Search pull requests, branches and reviews'
						}
						value={q}
						onChange={(e) => setQ(e.target.value)}
						spellCheck={false}
					/>
					{loading && <span className="palette-spinner" aria-label="Searching GitHub" />}
					{githubRepo && (
						<div className="palette-scopes" role="tablist" aria-label="Show">
							{SCOPES.map((s) => (
								<button
									key={s.id}
									role="tab"
									aria-selected={scope === s.id}
									className={scope === s.id ? 'on' : ''}
									tabIndex={-1}
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => {
										setChosenScope(s.id)
										if (prefix.scope) setQ(text)
									}}
								>
									{s.label}
								</button>
							))}
						</div>
					)}
				</div>
				<div className="palette-list" role="listbox" id="qo-list" aria-label="Results">
					{sections.map((s) => (
						<Fragment key={s.title}>
							<div className="palette-section" role="presentation">
								{s.title}
							</div>
							{s.error && (
								<div className="palette-error small" role="alert">
									<span>
										{s.error.code === 'github-not-found'
											? 'GitHub says the repository doesn’t exist, which is what it says for private repositories without a token.'
											: s.error.message}
									</span>
									{['github-not-found', 'github-auth', 'github-forbidden'].includes(s.error.code) && (
										<button
											className="btn small primary"
											onClick={() => {
												onClose()
												onConnect()
											}}
										>
											Connect GitHub
										</button>
									)}
								</div>
							)}
							{s.items.map((it) => {
								const i = ++index
								return (
									<div
										key={`${s.title}:${itemKey(it)}`}
										id={`qo-${i}`}
										role="option"
										aria-selected={i === cursor}
										className={`palette-item ${i === cursor ? 'active' : ''} ${it.t === 'pr' && stale ? 'stale' : ''}`}
										onMouseMove={() => i !== cursor && setCursor(i)}
										onClick={() => {
											setCursor(i)
											actionsFor(it)[0]?.run()
										}}
									>
										<Row it={it} words={words} viewer={viewer} />
									</div>
								)
							})}
						</Fragment>
					))}
					{items.length === 0 && !loading && !sections.some((s) => s.error) && (
						<div className="palette-empty">{text ? `No results for “${text}”` : 'Nothing to show yet'}</div>
					)}
				</div>
				{actionsOpen && selected && (
					<div className="palette-actions" role="menu" aria-label="Actions">
						{actions.map((a, i) => (
							<div
								key={a.label}
								role="menuitem"
								className={`palette-action-item ${i === actionCursor ? 'active' : ''}`}
								onMouseMove={() => setActionCursor(i)}
								onClick={() => a.run()}
							>
								<span className="ellipsis">{a.label}</span>
								<span className="spacer" />
								{a.keys && <kbd>{a.keys}</kbd>}
							</div>
						))}
					</div>
				)}
				<div className="palette-foot">
					{!githubRepo ? (
						<span>No GitHub remote, so only branches are listed</span>
					) : loading ? (
						<span>Searching GitHub…</span>
					) : !text ? (
						<span>
							<kbd>tab</kbd> switch · try <kbd>#128</kbd> <kbd>author:name</kbd> or paste a PR link
						</span>
					) : prs && !stale && scope !== 'branches' && prs.total > prs.items.length ? (
						<span>
							Showing {prs.items.length} of {prs.total.toLocaleString()} pull requests
						</span>
					) : null}
					<span className="spacer" />
					{primary && (
						<span className="palette-action">
							{primary.label} <kbd>↵</kbd>
						</span>
					)}
					{selected && (
						<>
							<span className="divider" />
							<button className="palette-action link-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => setActionsOpen((o) => !o)}>
								Actions <kbd>⌘K</kbd>
							</button>
						</>
					)}
				</div>
			</div>
		</div>
	)
}

function Row({ it, words, viewer }: { it: Item; words: Array<string>; viewer: string | null }) {
	if (it.t === 'pr') {
		const pr = it.pr
		const inbox = pr.inbox && pr.inbox !== 'reviewed' ? pr.inbox : null
		const requested = inbox ? INBOX_SHORT[inbox] : pr.reviewRequested === 'you' ? 'Review requested' : null
		return (
			<>
				<span className={`palette-icon pr ${pr.state}`} title={pr.state}>
					<PrIcon />
				</span>
				<span className="palette-title ellipsis" title={pr.title}>
					<Highlight text={pr.title} words={words} />
				</span>
				<span className="palette-sub" title={pr.headRef ? `${pr.headRef} → ${pr.baseRef}` : undefined}>
					#{pr.number}
					{pr.headRef && (
						<>
							{' · '}
							<Highlight text={pr.headRef} words={words} />
						</>
					)}
				</span>
				<span className="spacer" />
				{pr.state === 'draft' && <span className="pill small-pill">Draft</span>}
				{requested ? (
					<span className={`pill small-pill inbox-pill ${inbox ?? ''}`} title={inbox ? INBOX_LABEL[inbox] : undefined}>
						{requested}
					</span>
				) : (
					<ReviewBadge review={pr.review} viewer={viewer} />
				)}
				<span className="palette-acc" title={new Date(pr.updatedAt).toLocaleString()}>
					{pr.author ?? 'ghost'} · {ago(pr.updatedAt)}
				</span>
			</>
		)
	}
	if (it.t === 'branch') {
		const b = it.b
		return (
			<>
				<span className={`palette-icon branch ${b.kind}`} title={b.kind === 'local' ? 'Local branch' : 'Remote branch'}>
					<BranchIcon />
				</span>
				<span className="palette-title ellipsis" title={b.subject}>
					<Highlight text={b.short} words={words} />
				</span>
				<span className="palette-sub">{b.remote ?? 'local'}</span>
				{b.current && <span className="pill small-pill">checked out</span>}
				<span className="spacer" />
				<span className="palette-acc" title={new Date(b.date).toLocaleString()}>
					{ago(b.date)}
				</span>
			</>
		)
	}
	const r = it.r
	const notes = r.comments + r.drafts
	return (
		<>
			<span className="palette-icon review" title="Review you opened before">
				<ReviewIcon />
			</span>
			<span className="palette-title ellipsis">
				<Highlight text={reviewTitle(r)} words={words} />
			</span>
			<span className="palette-sub">{r.pr ? `#${r.pr.number}` : 'branch review'}</span>
			<span className="spacer" />
			{notes > 0 && (
				<span className="palette-acc">
					{notes} comment{notes === 1 ? '' : 's'}
				</span>
			)}
			<span className="palette-acc" title={new Date(r.updatedAt).toLocaleString()}>
				{ago(r.updatedAt)}
			</span>
		</>
	)
}

/** Bolds the parts of `text` that match the typed words, so it's clear why a row is listed. */
function Highlight({ text, words }: { text: string; words: Array<string> }) {
	if (!words.length) return <>{text}</>
	const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
	const parts = text.split(re)
	return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : <Fragment key={i}>{p}</Fragment>))}</>
}

function PrIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<circle cx="6" cy="6" r="2.5" />
			<circle cx="6" cy="18" r="2.5" />
			<circle cx="18" cy="18" r="2.5" />
			<path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4M13 3.5 10.5 6 13 8.5" />
		</svg>
	)
}

function BranchIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<circle cx="6" cy="5" r="2.5" />
			<circle cx="6" cy="19" r="2.5" />
			<circle cx="18" cy="7" r="2.5" />
			<path d="M6 7.5v9M18 9.5a6 6 0 0 1-6 6H8" />
		</svg>
	)
}

function ReviewIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
			<path d="m9 12 2 2 4-4" />
		</svg>
	)
}
