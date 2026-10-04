import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { FILTER_NEEDS_LOGIN, parsePrQuery, PR_QUERY_EXAMPLES } from '../../shared/prQuery.ts'
import type {
	AppError,
	BranchPreview,
	BranchRef,
	BrowserState,
	GitHubMapping,
	GitHubStatus,
	PrDetail,
	PrFilter,
	PrGraph,
	PrGraphNode,
	PrPage,
	PrState,
	PrSummary,
	RepoInfo,
	ReviewSummary,
	ReviewTarget,
} from '../../shared/types.ts'
import { ago, baseOptions, branchRows, defaultBaseFor, matchBranches, revealBranch, treeScope, type BranchRow } from './branches.ts'
import { BranchPrHint, useBranchPr } from './BranchPrHint.tsx'
import { ReviewBadge, ReviewList } from './PrReview.tsx'
import { usePrGraph } from './prGraph.ts'
import { graphSummary, stackOf, stackRows, type StackRow } from '../../shared/prStack.ts'
import { INBOX_LABEL } from '../../shared/inbox.ts'
import { Splitter, usePanelWidth } from './Splitter.tsx'
import { VirtualList } from './VirtualList.tsx'

export interface BrowserHandle {
	focusSearch(): void
	reveal(sel: { kind: 'pr'; pr: PrSummary } | { kind: 'branch'; branch: BranchRef }): void
}

interface Props {
	repo: RepoInfo
	state: BrowserState
	github: GitHubStatus | null
	mapping: GitHubMapping
	reviews: Array<ReviewSummary>
	opening: boolean
	onState(next: BrowserState): void
	onOpen(target: ReviewTarget): void
	onOpenSnapshot(reviewId: string): void
	onConnectGitHub(): void
	onRefreshRepo(): void
}

const FILTERS: Array<[PrFilter, string]> = [
	['inbox', 'Inbox'],
	['open', 'Open'],
	['review-requested', 'Review requested'],
	['mine', 'Mine'],
	['drafts', 'Drafts'],
	['merged', 'Merged'],
	['closed', 'Closed'],
	['all', 'All'],
]

const STATE_LABEL: Record<PrState, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' }
const ROW = 44
const BRANCH_ROW = 26

interface PrList {
	key: string
	items: Array<PrSummary>
	page: PrPage | null
	loading: boolean
	error: AppError | null
}

export const Browser = forwardRef<BrowserHandle, Props>(function Browser(p, ref) {
	const { repo, state } = p
	const side = usePanelWidth('panel.browse', 240, 170, 480)
	const search = useRef<HTMLInputElement>(null)
	const list = useRef<HTMLDivElement>(null)
	const [showHelp, setShowHelp] = useState(false)
	// Merge into the latest state, so delayed callbacks (scroll settle, debounced input) never overwrite newer changes.
	const latest = useRef(state)
	latest.current = state
	const set = useCallback(
		(patch: Partial<BrowserState>) => {
			latest.current = { ...latest.current, ...patch }
			p.onState(latest.current)
		},
		[p],
	)

	const isPrs = state.section === 'prs'
	const query = isPrs ? state.prQuery : state.branchQuery
	const expanded = useMemo(() => new Set(state.expanded), [state.expanded])
	const pinned = useMemo(() => new Set(state.pinned), [state.pinned])
	const remotes = useMemo(() => [...new Set(repo.branches.filter((b) => b.remote).map((b) => b.remote!))].sort(), [repo.branches])

	// ─── Pull requests: debounced provider-side search, newest request wins ──────────────────────────
	const ghRepo = p.mapping.selected
	const prKey = `${repo.id}|${ghRepo}|${state.prFilter}|${state.prQuery.trim()}|${p.github?.login ?? ''}`
	const [prs, setPrs] = useState<PrList>({ key: '', items: [], page: null, loading: false, error: null })
	const reqId = useRef(0)
	const loadPrs = useCallback(
		async (cursor: string | null, key: string) => {
			const id = ++reqId.current
			setPrs((s) => ({
				...s,
				key,
				loading: true,
				error: cursor ? s.error : null,
				...(cursor ? {} : { items: s.key === key ? s.items : [], page: s.key === key ? s.page : null }),
			}))
			const r = await window.review.searchPrs(repo.id, { filter: state.prFilter, text: state.prQuery, cursor }, 'list')
			if (id !== reqId.current) return // a newer search replaced this one
			if (!r.ok) {
				if (r.error.code === 'cancelled') return
				setPrs((s) => ({ ...s, loading: false, error: r.error }))
				return
			}
			setPrs((s) => {
				const base = cursor && s.key === key ? s.items : []
				const seen = new Set(base.map((x) => x.number))
				return {
					key,
					items: [...base, ...r.value.items.filter((x) => !seen.has(x.number))],
					page: r.value,
					loading: false,
					error: r.value.error,
				}
			})
		},
		[repo.id, state.prFilter, state.prQuery],
	)
	const ghReady = !!ghRepo && !!p.github && p.github.state !== 'checking'
	useEffect(() => {
		if (!isPrs || !ghReady) return
		if (prs.key === prKey && (prs.page || prs.loading)) return
		const t = window.setTimeout(() => void loadPrs(null, prKey), prs.key === '' ? 0 : 300)
		return () => window.clearTimeout(t)
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [prKey, isPrs, ghReady])
	const loadMore = useCallback(() => {
		if (prs.loading || !prs.page?.next || prs.key !== prKey || prs.error) return
		void loadPrs(prs.page.next, prKey)
	}, [prs, prKey, loadPrs])
	const refreshPrs = (): void => void loadPrs(null, prKey)
	// The Inbox reloads when the background check sees a change on GitHub, and when you come back to the window after a
	// while. Same key, so the rows, selection and scroll position stay while it loads.
	const live = useRef({ watching: false, reload: refreshPrs, fetchedAt: '' })
	live.current = {
		watching: isPrs && ghReady && state.prFilter === 'inbox' && prs.key === prKey, // one page, so a reload never drops loaded rows
		reload: refreshPrs,
		fetchedAt: prs.page?.fetchedAt ?? '',
	}
	useEffect(() => {
		let t: number | undefined
		const soon = (): void => {
			window.clearTimeout(t)
			t = window.setTimeout(() => live.current.watching && live.current.reload(), 500)
		}
		const off = window.review.onInboxChanged(soon)
		const onFocus = (): void => {
			const age = Date.now() - Date.parse(live.current.fetchedAt || '0')
			if (live.current.watching && age > 60_000) soon()
		}
		window.addEventListener('focus', onFocus)
		return () => {
			off()
			window.removeEventListener('focus', onFocus)
			window.clearTimeout(t)
		}
	}, [])
	// Open PRs and their branches connect stacks in the list (when grouped) and in the preview (always).
	const graph = usePrGraph(repo.id, isPrs && ghReady && p.github?.state === 'connected', prs.page?.fetchedAt)
	const prRows: Array<StackRow> = useMemo(
		() => (state.prStacks ? stackRows(prs.items, graph) : prs.items.map((pr) => ({ pr, depth: 0, context: false }))),
		[state.prStacks, prs.items, graph],
	)

	// ─── Branch rows ───────────────────────────────────────────────────────────
	const sectionBranches = useMemo(() => {
		if (state.section === 'pinned') return repo.branches.filter((b) => pinned.has(b.ref))
		if (state.section === 'local') return repo.branches.filter((b) => b.kind === 'local')
		if (state.section.startsWith('remote:')) return repo.branches.filter((b) => b.remote === state.section.slice(7))
		return []
	}, [repo.branches, state.section, pinned])

	const branchList: Array<BranchRow> = useMemo(() => {
		if (isPrs) return []
		if (state.branchQuery.trim()) {
			// Searching spans every branch so a match is never hidden behind the wrong section; full names identify it.
			return matchBranches(repo.branches, state.branchQuery).map((b) => ({ t: 'branch', key: b.ref, branch: b, label: b.name, depth: 0 }))
		}
		if (state.section === 'pinned')
			return [...sectionBranches]
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((b) => ({ t: 'branch', key: b.ref, branch: b, label: b.name, depth: 0 }))
		return branchRows(sectionBranches, treeScope(state.section), expanded)
	}, [isPrs, state.branchQuery, state.section, sectionBranches, repo.branches, expanded])

	// ─── Selection & cursor ─────────────────────────────────────────────────────
	const count = isPrs ? prRows.length : branchList.length
	const selectedIndex = useMemo(() => {
		const s = state.selected
		if (!s) return -1
		if (isPrs) return s.kind === 'pr' ? prRows.findIndex((x) => x.pr.number === s.number) : -1
		return s.kind === 'branch' ? branchList.findIndex((r) => r.t === 'branch' && r.branch.ref === s.ref) : -1
	}, [state.selected, isPrs, prRows, branchList])
	const [cursor, setCursor] = useState(-1)
	useEffect(() => setCursor(selectedIndex), [selectedIndex, state.section, query])

	const selectIndex = (i: number): void => {
		setCursor(i)
		if (isPrs) {
			const pr = prRows[i]?.pr
			if (pr) set({ selected: { kind: 'pr', number: pr.number } })
		} else {
			const row = branchList[i]
			if (row?.t === 'branch') set({ selected: { kind: 'branch', ref: row.branch.ref } })
		}
	}

	const toggleFolder = (key: string): void =>
		set({ expanded: expanded.has(key) ? state.expanded.filter((k) => k !== key) : [...state.expanded, key] })
	const togglePin = (ref: string): void => set({ pinned: pinned.has(ref) ? state.pinned.filter((r) => r !== ref) : [...state.pinned, ref] })

	// Keep a selected PR even when it scrolls out of the current result set (e.g. picked from quick open).
	const [extraPr, setExtraPr] = useState<PrSummary | null>(null)
	const selectedPr =
		state.selected?.kind === 'pr'
			? (prRows.find((x) => x.pr.number === (state.selected as { number: number }).number)?.pr ??
				(extraPr?.number === state.selected.number ? extraPr : null))
			: null
	const selectedBranch =
		state.selected?.kind === 'branch' ? (repo.branches.find((b) => b.ref === (state.selected as { ref: string }).ref) ?? null) : null

	// Looking at a PR in the preview counts as seen: the Inbox stops calling it new (here at once, in the store for next time).
	const [seen, setSeen] = useState<ReadonlySet<number>>(new Set())
	const seenNumber = selectedPr?.number ?? null
	useEffect(() => {
		if (seenNumber === null || !ghRepo) return
		const t = window.setTimeout(() => {
			setSeen((s) => new Set(s).add(seenNumber))
			void window.review.markPrSeen(repo.id, seenNumber)
		}, 800)
		return () => window.clearTimeout(t)
	}, [repo.id, ghRepo, seenNumber])

	const selectPr = (pr: PrSummary): void => {
		setExtraPr(pr)
		set({ selected: { kind: 'pr', number: pr.number } })
	}

	const openSelected = (): void => {
		if (p.opening) return
		if (selectedPr && ghRepo) p.onOpen({ kind: 'pr', repo: ghRepo, number: selectedPr.number })
		else if (selectedBranch) {
			const base = resolveBase(repo, selectedBranch, state.baseRef)
			if (base) p.onOpen({ kind: 'branch', headRef: selectedBranch.ref, baseRef: base })
		}
	}

	useImperativeHandle(ref, () => ({
		focusSearch: () => {
			search.current?.focus()
			search.current?.select()
		},
		reveal: (sel) => {
			if (sel.kind === 'pr') {
				setExtraPr(sel.pr)
				p.onState({ ...state, view: 'browse', section: 'prs', selected: { kind: 'pr', number: sel.pr.number } })
			} else {
				const b = sel.branch
				const { section, expand: keys } = revealBranch(b)
				p.onState({
					...state,
					view: 'browse',
					section,
					branchQuery: '',
					selected: { kind: 'branch', ref: b.ref },
					expanded: [...new Set([...state.expanded, ...keys])],
				})
			}
			window.setTimeout(() => list.current?.querySelector<HTMLElement>('.vlist')?.focus(), 0)
		},
	}))

	const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault()
			const next = e.key === 'ArrowDown' ? Math.min(count - 1, cursor + 1) : Math.max(0, cursor - 1)
			if (count) selectIndex(next)
		} else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault()
			openSelected()
		} else if (e.key === 'Enter') {
			e.preventDefault()
			if (cursor < 0 && count) selectIndex(0)
			else if (!isPrs && branchList[cursor]?.t === 'folder') toggleFolder(branchList[cursor].key)
			else list.current?.querySelector<HTMLElement>('.vlist')?.focus()
		} else if (e.key === 'Escape' && query) {
			e.preventDefault()
			e.stopPropagation()
			set(isPrs ? { prQuery: '' } : { branchQuery: '' })
		}
	}

	const scrollKey = `${state.section}|${isPrs ? `${state.prFilter}|${state.prQuery.trim()}` : state.branchQuery.trim()}`
	const listId = `${repo.id}|${scrollKey}`

	const parsed = isPrs ? parsePrQuery(state.prQuery) : null
	const sections = (
		<nav className="browse-side" aria-label="Browse" style={{ width: side.width }}>
			<SideItem
				label="Pull requests"
				icon="⇅"
				on={isPrs}
				onClick={() => set({ section: 'prs' })}
				badge={ghRepo ? undefined : '—'}
				title={ghRepo ? `GitHub · ${ghRepo}` : 'No GitHub remote'}
			/>
			<SideGroup id="sec:pinned" label="Pinned" expanded={expanded} onToggle={toggleFolder}>
				{state.pinned.length === 0 ? (
					<div className="side-hint muted small">Pin branches with ☆ to keep them here.</div>
				) : (
					<SideItem
						label="Pinned branches"
						icon="★"
						on={state.section === 'pinned'}
						count={repo.branches.filter((b) => pinned.has(b.ref)).length}
						onClick={() => set({ section: 'pinned' })}
					/>
				)}
			</SideGroup>
			<SideGroup id="sec:local" label="Branches" expanded={expanded} onToggle={toggleFolder}>
				<SideItem
					label="Local"
					icon="⎇"
					on={state.section === 'local'}
					count={repo.branches.filter((b) => b.kind === 'local').length}
					onClick={() => set({ section: 'local' })}
				/>
			</SideGroup>
			<SideGroup id="sec:remotes" label="Remotes" expanded={expanded} onToggle={toggleFolder}>
				{remotes.length === 0 && <div className="side-hint muted small">No remote-tracking branches.</div>}
				{remotes.map((r) => {
					const gh = repo.remotes.find((x) => x.name === r)?.github
					return (
						<SideItem
							key={r}
							label={r}
							icon="☁"
							on={state.section === `remote:${r}`}
							count={repo.branches.filter((b) => b.remote === r).length}
							title={gh ? `github.com/${gh}` : r}
							onClick={() => set({ section: `remote:${r}` })}
						/>
					)
				})}
			</SideGroup>
			<SideGroup id="sec:recent" label="Recent reviews" expanded={expanded} onToggle={toggleFolder}>
				{p.reviews.length === 0 && <div className="side-hint muted small">Reviews you open appear here.</div>}
				{p.reviews.slice(0, 8).map((r) => (
					<button
						key={r.id}
						className="side-item"
						onClick={() => p.onOpenSnapshot(r.id)}
						title={`${r.baseSha.slice(0, 7)}…${r.headSha.slice(0, 7)}`}
					>
						<span className="side-icon" aria-hidden>
							{r.pr ? '⇅' : '⎇'}
						</span>
						<span className="ellipsis">{r.pr ? `#${r.pr.number} ${r.pr.title}` : (r.headRef ?? r.headSha.slice(0, 7))}</span>
						{r.comments > 0 && <span className="count">{r.comments}</span>}
					</button>
				))}
			</SideGroup>
		</nav>
	)

	return (
		<div className="browse">
			{sections}
			<Splitter onPointerDown={side.start(1)} />
			<section className="browse-main" ref={list}>
				<div className="browse-tools">
					<div className="search-wrap">
						<input
							ref={search}
							className="search big"
							type="search"
							placeholder={
								isPrs
									? 'Search pull requests: title, #128, URL, author:, head:, base:'
									: 'Filter branches by name or remote (e.g. origin feat)'
							}
							value={query}
							onChange={(e) => set(isPrs ? { prQuery: e.target.value } : { branchQuery: e.target.value })}
							onKeyDown={onSearchKey}
							aria-label={isPrs ? 'Search pull requests' : 'Filter branches'}
							aria-controls="browse-list"
							data-search
							spellCheck={false}
						/>
						<kbd className="kbd-hint" aria-hidden>
							/
						</kbd>
						{isPrs && (
							<button className="btn small ghost" onClick={() => setShowHelp((x) => !x)} aria-expanded={showHelp} title="Search syntax">
								?
							</button>
						)}
					</div>
					{isPrs && showHelp && (
						<div className="query-help small" role="note">
							{PR_QUERY_EXAMPLES.map((x) => (
								<button key={x.query} className="query-example" onClick={() => set({ prQuery: x.query })}>
									<code>{x.query}</code>
									<span className="muted">{x.description}</span>
								</button>
							))}
							<span className="muted">
								Words match titles. Searches run on GitHub across the whole repository. ↑↓ move · Enter select · ⌘/Ctrl+Enter open review ·
								Esc clear.
							</span>
						</div>
					)}
					{isPrs && (
						<div className="seg filters" role="radiogroup" aria-label="Pull request filter">
							{FILTERS.map(([k, label]) => (
								<button
									key={k}
									role="radio"
									aria-checked={state.prFilter === k}
									className={state.prFilter === k ? 'on' : ''}
									onClick={() => set({ prFilter: k })}
									title={FILTER_NEEDS_LOGIN.has(k) && p.github?.state !== 'connected' ? 'Needs a GitHub token' : undefined}
								>
									{label}
								</button>
							))}
						</div>
					)}
					{isPrs && (
						<label
							className="stack-toggle small"
							title={
								p.github?.state === 'connected'
									? 'Show each pull request under the one it is stacked on (its base branch is that PR’s branch)'
									: 'Needs a GitHub token'
							}
						>
							<input type="checkbox" checked={state.prStacks} onChange={(e) => set({ prStacks: e.target.checked })} />
							Stacks
						</label>
					)}
				</div>
				{isPrs ? (
					<PrStatusBar
						page={prs.key === prKey ? prs.page : null}
						shown={prs.items.length}
						loading={prs.loading || prs.key !== prKey}
						error={prs.key === prKey ? prs.error : null}
						mapping={p.mapping}
						github={p.github}
						parsed={parsed}
						onRetry={refreshPrs}
						onConnect={p.onConnectGitHub}
					/>
				) : (
					<div className="list-status small muted">
						{state.branchQuery.trim()
							? `${branchList.length} of ${repo.branches.length} branches match`
							: `${sectionBranches.length} branch${sectionBranches.length === 1 ? '' : 'es'}`}
						<span className="spacer" />
						<button className="link" onClick={p.onRefreshRepo} title="Re-read branches from Git (does not fetch)">
							Reload
						</button>
					</div>
				)}
				<div className="list-area" id="browse-list">
					{isPrs && !ghRepo ? (
						<div className="empty">
							<h2>No GitHub repository</h2>
							<p className="muted">
								None of this repository’s remotes point to github.com. Local and remote branches are available in the sidebar.
							</p>
						</div>
					) : (
						<VirtualList
							id={listId}
							label={isPrs ? 'Pull requests' : 'Branches'}
							count={count}
							rowHeight={isPrs ? ROW : BRANCH_ROW}
							active={cursor}
							initialScroll={state.scroll[scrollKey] ?? 0}
							onScrollSettled={(top) => set({ scroll: { ...trimScroll(latest.current.scroll), [scrollKey]: top } })}
							rowKey={(i) => (isPrs ? `pr:${prRows[i].pr.number}` : branchList[i].key)}
							rowClass={(i) => {
								if (isPrs) return state.selected?.kind === 'pr' && prRows[i].pr.number === state.selected.number ? 'selected' : ''
								const r = branchList[i]
								return r.t === 'branch' && state.selected?.kind === 'branch' && r.branch.ref === state.selected.ref ? 'selected' : ''
							}}
							onRowClick={(i) => {
								if (!isPrs && branchList[i].t === 'folder') {
									setCursor(i)
									toggleFolder(branchList[i].key)
								} else selectIndex(i)
							}}
							onRowDoubleClick={(i) => {
								if (isPrs && prRows[i]) p.onOpen({ kind: 'pr', repo: ghRepo!, number: prRows[i].pr.number })
							}}
							onMove={(i) => {
								if (!isPrs && branchList[i]?.t === 'folder') setCursor(i)
								else selectIndex(i)
							}}
							onEnter={(i) => {
								if (!isPrs && branchList[i]?.t === 'folder') toggleFolder(branchList[i].key)
								else selectIndex(i)
							}}
							onKey={(e, i) => {
								if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
									e.preventDefault()
									openSelected()
									return true
								}
								const row = !isPrs ? branchList[i] : null
								if (row?.t === 'folder' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
									if ((e.key === 'ArrowRight') !== row.open) toggleFolder(row.key)
									e.preventDefault()
									return true
								}
								if (e.key === 'Escape' && query) {
									set(isPrs ? { prQuery: '' } : { branchQuery: '' })
									e.preventDefault()
									e.stopPropagation()
									return true
								}
								return false
							}}
							onEndReached={isPrs ? loadMore : undefined}
							renderRow={(i) =>
								isPrs ? (
									<PrRow row={prRows[i]} viewer={p.github?.login ?? null} seen={seen} />
								) : (
									<BranchRowView row={branchList[i]} pinned={pinned} onPin={togglePin} searching={!!state.branchQuery.trim()} />
								)
							}
							empty={
								<div className="empty muted small">
									{isPrs
										? prs.loading
											? 'Loading pull requests…'
											: prs.error
												? ''
												: 'No pull requests match.'
										: state.branchQuery.trim()
											? 'No branches match.'
											: state.section === 'pinned'
												? 'No pinned branches. Use ☆ on any branch to pin it.'
												: 'No branches here.'}
								</div>
							}
							footer={
								isPrs && prs.items.length > 0 && prs.key === prKey ? (
									<div className="list-foot small muted">
										{prs.loading ? (
											'Loading more…'
										) : prs.page?.next ? (
											<button className="link" onClick={loadMore}>
												Load more
											</button>
										) : (
											endText(prs.page, prs.items.length)
										)}
									</div>
								) : null
							}
						/>
					)}
				</div>
				<div className="preview">
					{isPrs ? (
						selectedPr ? (
							<PrPreview
								key={`${ghRepo}#${selectedPr.number}`}
								repoId={repo.id}
								repo={ghRepo!}
								pr={selectedPr}
								opening={p.opening}
								onOpen={p.onOpen}
								reviews={p.reviews}
								viewer={p.github?.login ?? null}
								onOpenSnapshot={p.onOpenSnapshot}
								graph={graph}
								onSelectPr={selectPr}
							/>
						) : (
							<div className="preview-empty muted small">Select a pull request to see its details.</div>
						)
					) : selectedBranch ? (
						<BranchPreviewPane
							key={selectedBranch.ref}
							repo={repo}
							branch={selectedBranch}
							pinned={pinned.has(selectedBranch.ref)}
							baseRef={state.baseRef}
							opening={p.opening}
							onPin={() => togglePin(selectedBranch.ref)}
							onBase={(baseRef) => set({ baseRef })}
							onOpen={p.onOpen}
							onConnect={p.onConnectGitHub}
							ghRepo={ghRepo}
						/>
					) : (
						<div className="preview-empty muted small">Select a branch to compare it with a base branch.</div>
					)}
				</div>
			</section>
		</div>
	)
})

/** The base last chosen in the preview, if it is valid for this branch; otherwise a repository-specific default. */
function resolveBase(repo: RepoInfo, b: BranchRef, chosen: string | null): string | null {
	if (chosen && chosen !== b.ref && repo.branches.some((x) => x.ref === chosen)) return chosen
	return defaultBaseFor(b, repo.branches, repo.baseCandidates)
}

function trimScroll(s: Record<string, number>): Record<string, number> {
	const e = Object.entries(s)
	return Object.fromEntries(e.slice(Math.max(0, e.length - 40)))
}

function endText(page: PrPage | null, shown: number): string {
	if (!page) return ''
	if (page.capped)
		return `Showing ${shown.toLocaleString()} of ${page.total.toLocaleString()}. GitHub returns at most 1,000 results per search; narrow the query to see others.`
	return page.exact ? '' : `All ${shown.toLocaleString()} shown.`
}

function SideGroup(props: { id: string; label: string; expanded: Set<string>; onToggle(id: string): void; children: React.ReactNode }) {
	const open = props.expanded.has(props.id)
	return (
		<div className="side-group">
			<button className="side-head" aria-expanded={open} onClick={() => props.onToggle(props.id)}>
				<span className={`chev ${open ? 'open' : ''}`} aria-hidden>
					▸
				</span>
				{props.label}
			</button>
			{open && props.children}
		</div>
	)
}

function SideItem(props: { label: string; icon: string; on: boolean; count?: number; badge?: string; title?: string; onClick(): void }) {
	return (
		<button
			className={`side-item ${props.on ? 'on' : ''}`}
			aria-current={props.on ? 'page' : undefined}
			onClick={props.onClick}
			title={props.title}
		>
			<span className="side-icon" aria-hidden>
				{props.icon}
			</span>
			<span className="ellipsis">{props.label}</span>
			<span className="spacer" />
			{props.count !== undefined && <span className="count">{props.count}</span>}
			{props.badge && <span className="count">{props.badge}</span>}
		</button>
	)
}

function PrStatusBar(props: {
	page: PrPage | null
	shown: number
	loading: boolean
	error: AppError | null
	mapping: GitHubMapping
	github: GitHubStatus | null
	parsed: ReturnType<typeof parsePrQuery> | null
	onRetry(): void
	onConnect(): void
}) {
	const { page, error, github } = props
	const anon = github?.state !== 'connected'
	return (
		<div className="list-status small" role="status" aria-live="polite">
			{props.mapping.selected && (
				<button
					className="link repo-link"
					onClick={props.onConnect}
					title={props.mapping.candidates.length > 1 ? 'Choose which repository to browse' : 'GitHub settings'}
				>
					{props.mapping.selected}
					{props.mapping.candidates.length > 1 ? ' ▾' : ''}
				</button>
			)}
			{error ? (
				<span className={page?.stale ? 'warn-text' : 'error-text'}>
					{page?.stale ? `Showing results from ${new Date(page.fetchedAt).toLocaleTimeString()}. ` : ''}
					{error.message}
				</span>
			) : props.loading && !page ? (
				<span className="muted">Searching GitHub…</span>
			) : page ? (
				<span className="muted">
					{page.exact
						? (page.notice ?? `Pull request #${page.items[0]?.number}`)
						: `${page.total.toLocaleString()} match${page.total === 1 ? '' : 'es'}${props.shown < page.total ? `, ${props.shown.toLocaleString()} loaded` : ''}`}
					{page.incomplete && ' · GitHub timed out, so results may be incomplete'}
					{!page.exact && page.notice && ` · ${page.notice}`}
					{` · updated ${new Date(page.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
				</span>
			) : null}
			<span className="spacer" />
			{anon && github?.state !== 'checking' && (
				<button className="link" onClick={props.onConnect}>
					{github?.state === 'failed' ? 'GitHub token failed' : github?.state === 'offline' ? 'Offline' : 'Connect GitHub'}
				</button>
			)}
			{(error || page) && (
				<button className="link" onClick={props.onRetry} disabled={props.loading}>
					{error ? 'Retry' : 'Refresh'}
				</button>
			)}
			{error?.code === 'github-auth' && (
				<button className="link" onClick={props.onConnect}>
					Connect GitHub
				</button>
			)}
		</div>
	)
}

function StateBadge({ state }: { state: PrState }) {
	return <span className={`pr-state ${state}`}>{STATE_LABEL[state]}</span>
}

function PrRow({ row, viewer, seen }: { row: StackRow; viewer: string | null; seen: ReadonlySet<number> }) {
	const { pr, depth } = row
	const inbox = pr.inbox === 'new' && seen.has(pr.number) ? 'waiting' : pr.inbox
	return (
		<div
			className={`pr-row ${row.context ? 'context' : ''}`}
			style={depth ? { paddingLeft: 12 + depth * 18 } : undefined}
			title={row.context ? 'Not in these results: shown because a result is stacked on it' : undefined}
		>
			<div className="pr-line1">
				{depth > 0 && (
					<span className="stack-mark" aria-label="stacked on the PR above">
						↳
					</span>
				)}
				<StateBadge state={pr.state} />
				<span className="pr-title ellipsis" title={pr.title}>
					{pr.title}
				</span>
				<span className="muted mono small">#{pr.number}</span>
				{inbox ? (
					<span className={`pill small-pill inbox-pill ${inbox}`}>{INBOX_LABEL[inbox]}</span>
				) : (
					pr.reviewRequested === 'you' && <span className="pill small-pill">Review requested</span>
				)}
				<ReviewBadge review={pr.review} viewer={viewer} />
			</div>
			<div className="pr-line2 small muted">
				<span className="ellipsis">{pr.author ?? 'ghost'}</span>
				{pr.headRef && (
					<span
						className="mono ellipsis branch-pair"
						title={`${pr.crossRepo && pr.headOwner ? `${pr.headOwner}:` : ''}${pr.headRef} → ${pr.baseRef}`}
					>
						{pr.crossRepo && pr.headOwner ? `${pr.headOwner}:` : ''}
						{pr.headRef} → {pr.baseRef}
					</span>
				)}
				<span className="spacer" />
				{pr.reviewRequested === 'others' && (
					<span title={pr.reviewers.join(', ')}>
						awaiting {pr.reviewers.length} reviewer{pr.reviewers.length === 1 ? '' : 's'}
					</span>
				)}
				<span className="nowrap" title={new Date(pr.updatedAt).toLocaleString()}>
					{ago(pr.updatedAt)}
				</span>
			</div>
		</div>
	)
}

function BranchRowView(props: { row: BranchRow; pinned: Set<string>; searching: boolean; onPin(ref: string): void }) {
	const r = props.row
	if (r.t === 'folder')
		return (
			<div className="branch-row folder" style={{ paddingLeft: 10 + r.depth * 14 }} aria-expanded={r.open}>
				<span className={`chev ${r.open ? 'open' : ''}`} aria-hidden>
					▸
				</span>
				<span className="folder-icon" aria-hidden>
					▭
				</span>
				<span className="ellipsis">{r.name}/</span>
				<span className="count">{r.count}</span>
			</div>
		)
	const b = r.branch
	const isPinned = props.pinned.has(b.ref)
	return (
		<div className="branch-row" style={{ paddingLeft: 10 + r.depth * 14 }}>
			<span
				className={`kind-dot ${b.kind}`}
				aria-hidden
				title={b.kind === 'local' ? 'Local branch' : `Remote-tracking branch on ${b.remote}`}
			/>
			<span className={`ellipsis branch-name ${b.current ? 'current' : ''}`}>
				{props.searching && b.remote ? (
					<>
						<span className="muted">{b.remote}/</span>
						{b.short}
					</>
				) : (
					r.label
				)}
			</span>
			{b.current && (
				<span className="pill small-pill" title="Checked out in this working tree. Opening a review never changes the checkout.">
					checked out
				</span>
			)}
			{b.upstreamGone && (
				<span className="muted small" title="Its upstream branch no longer exists">
					upstream gone
				</span>
			)}
			{b.ahead !== null && (b.ahead > 0 || (b.behind ?? 0) > 0) && (
				<span className="small mono muted nowrap" title={`Relative to its upstream ${b.upstream?.replace(/^refs\/remotes\//, '')}`}>
					↑{b.ahead} ↓{b.behind}
				</span>
			)}
			<span className="spacer" />
			<span className="small muted ellipsis subject" title={b.subject}>
				{b.subject}
			</span>
			<span className="small muted nowrap" title={new Date(b.date).toLocaleString()}>
				{ago(b.date)}
			</span>
			<button
				className={`pin ${isPinned ? 'on' : ''}`}
				tabIndex={-1}
				aria-label={isPinned ? `Unpin ${b.name}` : `Pin ${b.name}`}
				title={isPinned ? 'Unpin' : 'Pin'}
				onClick={(e) => {
					e.stopPropagation()
					props.onPin(b.ref)
				}}
			>
				{isPinned ? '★' : '☆'}
			</button>
		</div>
	)
}

function PrPreview(props: {
	repoId: string
	repo: string
	pr: PrSummary
	opening: boolean
	reviews: Array<ReviewSummary>
	viewer: string | null
	onOpen(t: ReviewTarget): void
	onOpenSnapshot(id: string): void
	graph: PrGraph | null
	onSelectPr(pr: PrSummary): void
}) {
	const { pr } = props
	const [detail, setDetail] = useState<PrDetail | null>(null)
	const [error, setError] = useState<AppError | null>(null)
	const load = useCallback(() => {
		let live = true
		setError(null)
		// Detail is fetched only for the selected row; list rows never trigger per-item requests.
		const t = window.setTimeout(() => {
			void window.review.prDetail(props.repoId, pr.number).then((r) => {
				if (!live) return
				if (r.ok) setDetail(r.value)
				else setError(r.error)
			})
		}, 150)
		return () => {
			live = false
			window.clearTimeout(t)
		}
	}, [props.repoId, pr.number])
	useEffect(load, [load])
	const d = detail ?? null
	const head = d
		? `${d.crossRepo ? `${d.headOwner ?? 'deleted fork'}:` : ''}${d.headRef}`
		: pr.headRef
			? `${pr.crossRepo && pr.headOwner ? `${pr.headOwner}:` : ''}${pr.headRef}`
			: null
	const base = d?.baseRef ?? pr.baseRef
	const earlier = props.reviews.filter((r) => r.pr && r.pr.number === pr.number && r.pr.repo.toLowerCase() === props.repo.toLowerCase())
	const target: ReviewTarget = { kind: 'pr', repo: props.repo, number: pr.number }
	return (
		<div className="preview-body">
			<div className="preview-head">
				<StateBadge state={d?.state ?? pr.state} />
				<h3 className="ellipsis selectable" title={pr.title}>
					{pr.title} <span className="muted">#{pr.number}</span>
				</h3>
				<ReviewBadge review={detail?.review ?? pr.review} viewer={props.viewer} />
				<span className="spacer" />
				<a className="btn" href={pr.url} target="_blank" rel="noreferrer">
					Open on GitHub ↗
				</a>
				<button className="btn primary" disabled={props.opening} onClick={() => props.onOpen(target)}>
					{props.opening ? 'Opening…' : 'Open review'}
				</button>
			</div>
			<div className="preview-meta small">
				<span>
					<span className="muted">by</span> {d?.author ?? pr.author ?? 'ghost'}
				</span>
				{head && base && (
					<span className="mono selectable">
						{head} → {base}
					</span>
				)}
				{d?.crossRepo && (
					<span className="pill small-pill" title={d.headRepo ?? 'The source fork was deleted'}>
						fork
					</span>
				)}
				{d && d.commits !== null && (
					<span>
						{d.commits} commit{d.commits === 1 ? '' : 's'}
					</span>
				)}
				{d && d.changedFiles !== null && (
					<span>
						{d.changedFiles} file{d.changedFiles === 1 ? '' : 's'} <span className="plus">+{d.additions}</span>{' '}
						<span className="minus">−{d.deletions}</span>
					</span>
				)}
				<span className="muted" title={new Date(pr.updatedAt).toLocaleString()}>
					updated {ago(pr.updatedAt)}
				</span>
				{d && d.reviewers.length > 0 && <span className="muted">requested: {d.reviewers.join(', ')}</span>}
				{d?.review && <ReviewList review={d.review} />}
				{d && (
					<span className="muted mono" title="GitHub's base and head commits for this pull request">
						{d.baseSha.slice(0, 7)}…{d.headSha.slice(0, 7)}
					</span>
				)}
			</div>
			{props.graph && <StackLine graph={props.graph} pr={d ?? pr} onSelect={props.onSelectPr} />}
			{earlier.length > 0 && (
				<div className="small preview-earlier">
					<span className="muted">Earlier reviews:</span>
					{earlier.slice(0, 4).map((r) => (
						<button
							key={r.id}
							className="link mono"
							onClick={() => props.onOpenSnapshot(r.id)}
							title={`Merge base ${r.baseSha}\nHead ${r.headSha}`}
						>
							{r.headSha.slice(0, 7)}
							{r.comments ? ` · ${r.comments} comment${r.comments === 1 ? '' : 's'}` : ''}
						</button>
					))}
				</div>
			)}
			{error ? (
				<div className="small error-text">
					{error.message}{' '}
					<button className="link" onClick={load}>
						Retry
					</button>
				</div>
			) : !d ? (
				<div className="small muted">Loading details…</div>
			) : (
				<pre className="pr-body selectable">{d.body.trim() || 'No description provided.'}</pre>
			)}
		</div>
	)
}

function BranchPreviewPane(props: {
	repo: RepoInfo
	branch: BranchRef
	pinned: boolean
	baseRef: string | null
	opening: boolean
	onPin(): void
	onBase(ref: string): void
	onOpen(t: ReviewTarget): void
	onConnect(): void
	ghRepo: string | null
}) {
	const { repo, branch: b } = props
	const branchPr = useBranchPr(repo.id, b.ref, !!props.ghRepo)
	const options = useMemo(() => baseOptions(repo.branches, repo.baseCandidates, b.ref), [repo.branches, repo.baseCandidates, b.ref])
	const base = resolveBase(repo, b, props.baseRef)
	const [preview, setPreview] = useState<BranchPreview | null>(null)
	useEffect(() => {
		if (!base) return
		let live = true
		setPreview(null)
		void window.review.branchPreview(repo.id, b.ref, base).then((r) => live && r.ok && setPreview(r.value))
		return () => {
			live = false
		}
	}, [repo.id, b.ref, b.sha, base])
	const baseName = options.find((o) => o.ref === base)?.name ?? base
	return (
		<div className="preview-body">
			<div className="preview-head">
				<span className={`kind-dot ${b.kind}`} aria-hidden />
				<h3 className="ellipsis selectable mono">{b.name}</h3>
				{b.current && <span className="pill small-pill">checked out</span>}
				<button className={`btn small ghost ${props.pinned ? 'on' : ''}`} onClick={props.onPin} aria-pressed={props.pinned}>
					{props.pinned ? '★ Pinned' : '☆ Pin'}
				</button>
				<span className="spacer" />
				<label className="hfield">
					<span className="muted small">Base</span>
					<BasePicker options={options} value={base} ranked={repo.baseCandidates} onChange={props.onBase} />
				</label>
				<button
					className="btn primary"
					disabled={!base || props.opening || !!preview?.error}
					onClick={() => base && props.onOpen({ kind: 'branch', headRef: b.ref, baseRef: base })}
				>
					{props.opening ? 'Opening…' : 'Open review'}
				</button>
			</div>
			<div className="preview-meta small">
				<span className="mono muted">{b.sha.slice(0, 7)}</span>
				<span className="ellipsis selectable">{b.subject}</span>
				<span className="muted" title={new Date(b.date).toLocaleString()}>
					{ago(b.date)}
				</span>
			</div>
			<div className="preview-meta small">
				{b.kind === 'local' ? (
					b.upstream ? (
						<span>
							<span className="muted">Upstream</span> <span className="mono">{b.upstream.replace(/^refs\/remotes\//, '')}</span>
							{b.upstreamGone ? (
								<span className="muted"> (gone)</span>
							) : (
								<span className="muted">
									{' '}
									· relative to upstream: {b.ahead} ahead, {b.behind} behind
								</span>
							)}
						</span>
					) : (
						<span className="muted">No upstream configured</span>
					)
				) : (
					<span className="muted">Remote-tracking branch on {b.remote}, as of your last fetch. Nothing is fetched here.</span>
				)}
			</div>
			{props.ghRepo && (
				<div className="preview-meta small">
					<BranchPrHint
						data={branchPr.data}
						error={branchPr.error}
						opening={props.opening}
						onOpen={(pr) => branchPr.data && props.onOpen({ kind: 'pr', repo: branchPr.data.repo, number: pr.number })}
						onConnect={props.onConnect}
					/>
				</div>
			)}
			{base && (
				<div className="preview-meta small compare-line">
					{!preview ? (
						<span className="muted">Resolving comparison…</span>
					) : preview.error ? (
						<span className="error-text">{preview.error.message}</span>
					) : (
						<>
							<span>
								Review compares <span className="mono">merge-base</span>{' '}
								<span className="mono muted">{preview.mergeBase?.slice(0, 7)}</span> → <span className="mono">{b.name}</span>{' '}
								<span className="mono muted">{preview.headSha.slice(0, 7)}</span>
							</span>
							{preview.ahead !== null && (
								<span className="muted">
									relative to {baseName}: {preview.ahead} commit{preview.ahead === 1 ? '' : 's'} ahead, {preview.behind} behind
								</span>
							)}
							{preview.ahead === 0 && <span className="warn-text">No commits of its own; the review will be empty.</span>}
						</>
					)}
				</div>
			)}
			{repo.shallow && (
				<div className="small warn-text">This is a shallow clone; merge bases may be missing until you fetch more history.</div>
			)}
		</div>
	)
}

/** Searchable base-branch picker: combobox with a filtered listbox. */
export function BasePicker(props: { options: Array<BranchRef>; value: string | null; ranked: Array<string>; onChange(ref: string): void }) {
	const [open, setOpen] = useState(false)
	const [q, setQ] = useState('')
	const [cursor, setCursor] = useState(0)
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
	const wrap = useRef<HTMLDivElement>(null)
	const input = useRef<HTMLInputElement>(null)
	const shown = useMemo(() => (q.trim() ? matchBranches(props.options, q) : props.options).slice(0, 300), [props.options, q])
	const current = props.options.find((o) => o.ref === props.value)
	useEffect(() => {
		if (!open) return
		input.current?.focus()
		const onDown = (e: MouseEvent): void => {
			if (!wrap.current?.contains(e.target as Node)) setOpen(false)
		}
		window.addEventListener('mousedown', onDown)
		return () => window.removeEventListener('mousedown', onDown)
	}, [open])
	const choose = (b: BranchRef | undefined): void => {
		if (!b) return
		props.onChange(b.ref)
		setOpen(false)
	}
	return (
		<div className="base-picker" ref={wrap}>
			<button
				className="btn model-btn"
				aria-haspopup="listbox"
				aria-expanded={open}
				onClick={() => {
					const r = wrap.current?.getBoundingClientRect()
					if (r) setPos({ top: Math.max(8, r.top - 6), left: Math.min(r.left, window.innerWidth - 390) })
					setQ('')
					setCursor(0)
					setOpen((x) => !x)
				}}
			>
				<span className="ellipsis mono">{current?.name ?? 'Choose base'}</span>
				<span className="chev-down" aria-hidden>
					▾
				</span>
			</button>
			{open && (
				<div
					className="popover picker upward"
					style={pos ? { bottom: window.innerHeight - pos.top, left: pos.left } : undefined}
					onKeyDown={(e) => {
						if (e.key === 'ArrowDown') {
							e.preventDefault()
							setCursor((c) => Math.min(shown.length - 1, c + 1))
						} else if (e.key === 'ArrowUp') {
							e.preventDefault()
							setCursor((c) => Math.max(0, c - 1))
						} else if (e.key === 'Enter') {
							e.preventDefault()
							choose(shown[cursor])
						} else if (e.key === 'Escape') {
							e.preventDefault()
							e.stopPropagation()
							setOpen(false)
						}
					}}
				>
					<input
						ref={input}
						className="search"
						type="search"
						placeholder="Search base branches"
						aria-label="Search base branches"
						value={q}
						onChange={(e) => {
							setQ(e.target.value)
							setCursor(0)
						}}
					/>
					<div className="picker-list" role="listbox" aria-label="Base branches">
						{shown.length === 0 && <div className="muted small pad">No branches match.</div>}
						{shown.map((b, i) => (
							<div
								key={b.ref}
								role="option"
								aria-selected={b.ref === props.value}
								className={`picker-item ${i === cursor ? 'active' : ''} ${b.ref === props.value ? 'selected' : ''}`}
								onMouseEnter={() => setCursor(i)}
								onClick={() => choose(b)}
							>
								<span className={`kind-dot ${b.kind}`} aria-hidden />
								<span className="ellipsis mono">{b.name}</span>
								<span className="spacer" />
								{props.ranked[0] === b.ref && <span className="src-tag catalog">default</span>}
								<span className="muted small nowrap">{ago(b.date)}</span>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	)
}

/** Where the PR sits in its stack: the PRs below it down to the base branch, and the ones stacked directly on it. */
function StackLine(props: {
	graph: PrGraph
	pr: { number: number; headRef: string | null; baseRef: string | null; crossRepo: boolean | null }
	onSelect(pr: PrSummary): void
}) {
	const s = stackOf(props.graph, props.pr)
	if (!s) return null
	const link = (n: PrGraphNode) => (
		<button key={n.number} className="link mono" title={n.title} onClick={() => props.onSelect(graphSummary(n))}>
			#{n.number}
		</button>
	)
	return (
		<div className="small stack-line">
			<span className="muted">Stack:</span>
			{s.base && <span className="mono muted">{s.base}</span>}
			{s.parents.map((n) => (
				<span key={n.number} className="stack-step">
					<span className="muted" aria-hidden>
						›
					</span>
					{link(n)}
				</span>
			))}
			<span className="stack-step">
				<span className="muted" aria-hidden>
					›
				</span>
				<b className="mono">#{props.pr.number}</b>
			</span>
			{s.children.length > 0 && (
				<span className="stack-step">
					<span className="muted">· stacked on it:</span>
					{s.children.map(({ node, above }) => (
						<span key={node.number} className="stack-step">
							{link(node)}
							{above > 0 && <span className="muted">(+{above} above)</span>}
						</span>
					))}
				</span>
			)}
			{props.graph.truncated && <span className="muted">· only the 1,000 most recently updated open PRs were read</span>}
		</div>
	)
}
