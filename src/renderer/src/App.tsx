import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { blockingSummary, findingRoots } from '../../shared/findings.ts'
import type {
	AiRun,
	AiSettingsView,
	AiScope,
	Anchor,
	AppError,
	BrowserState,
	CompareTarget,
	Comparison,
	Discussion,
	DiscussionThread,
	Finding,
	FindingLevel,
	GitHubStatus,
	PrGraph,
	PrReviewState,
	LoadedComparison,
	ModelSelection,
	RepoSession,
	RepoTab,
	Result,
	Review,
	ReviewerChoice,
	ReviewRule,
	ReviewSummary,
	ReviewTarget,
	TargetProbe,
} from '../../shared/types.ts'
import { AiRunControl } from './AiRunControl.tsx'
import { Browser, type BrowserHandle } from './Browser.tsx'
import { GitHubSettings } from './GitHubSettings.tsx'
import { BranchPrHint, isAuthProblem, lookupProblem, useBranchPr } from './BranchPrHint.tsx'
import { PublishDialog } from './PublishDialog.tsx'
import { QuickOpen } from './QuickOpen.tsx'
import { ReviewBadge } from './PrReview.tsx'
import { PanelBoundary } from './PanelBoundary.tsx'
import { usePrGraph } from './prGraph.ts'
import { stackOf } from '../../shared/prStack.ts'
import { CommentsPanel } from './CommentsPanel.tsx'
import { ContextPanel } from './ContextPanel.tsx'
import { discussedAt } from './discussed.ts'
import { DiscussionPanel } from './Discussion.tsx'
import { FindingsPanel } from './FindingsPanel.tsx'
import { ModelPicker } from './ModelPicker.tsx'
import { ProviderSettings } from './ProviderSettings.tsx'
import { DiffView, type RevealRequest } from './DiffView.tsx'
import { FileTree } from './FileTree.tsx'
import * as ops from './reviewOps.ts'
import { Splitter, usePanelWidth } from './Splitter.tsx'
import { buildTree, flatten } from './tree.ts'
import { AiOrb } from './AiOrb.tsx'

type SaveState = { kind: 'idle' | 'dirty' | 'saving' | 'saved' | 'error'; at?: string; message?: string }

function short(sha: string): string {
	return sha.slice(0, 7)
}
function refName(ref: string): string {
	return ref.replace(/^refs\/(heads|remotes)\//, '')
}

const ERROR_TITLES: Partial<Record<AppError['code'], string>> = {
	'git-missing': 'Git is not available',
	'not-a-repo': 'Not a Git repository',
	'bare-repo': 'Bare repository',
	'dubious-ownership': 'Repository not trusted by Git',
	'no-commits': 'No commits yet',
	'unrelated-histories': 'Unrelated histories',
	'missing-commits': 'Review snapshot unavailable',
	'shallow-history': 'History not downloaded',
	'pr-unavailable': 'Original comparison unavailable',
	'pr-changed': 'Pull request kept changing',
	'fetch-failed': 'Could not fetch the pull request',
	offline: 'Offline',
}

function targetOf(r: { target: ReviewTarget | null | undefined; baseRef: string }): ReviewTarget {
	return r.target ?? { kind: 'branch', headRef: 'HEAD', baseRef: r.baseRef }
}

function targetKey(t: ReviewTarget): string {
	return t.kind === 'pr' ? `pr:${t.repo.toLowerCase()}#${t.number}` : `branch:${t.headRef}|${t.baseRef}`
}

function isTyping(el: Element | null): boolean {
	if (!(el instanceof HTMLElement)) return false
	return (
		el.isContentEditable ||
		el.tagName === 'TEXTAREA' ||
		el.tagName === 'SELECT' ||
		(el.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes((el as HTMLInputElement).type))
	)
}

export function App() {
	const [session, setSession] = useState<RepoSession | null>(null)
	const [repoError, setRepoError] = useState<AppError | null>(null)
	const [tabs, setTabs] = useState<Array<RepoTab>>([])
	const [tabError, setTabError] = useState<string | null>(null)
	const [busy, setBusy] = useState<string | null>('Restoring last review…')
	const [loaded, setLoaded] = useState<LoadedComparison | null>(null)
	const [compareError, setCompareError] = useState<AppError | null>(null)
	const [review, setReview] = useState<Review | null>(null)
	const [selected, setSelected] = useState<string | null>(null)
	const [activeDraftId, setActiveDraftId] = useState<string | null>(null)
	const [reveal, setReveal] = useState<RevealRequest | null>(null)
	const [save, setSave] = useState<SaveState>({ kind: 'idle' })
	const [probe, setProbe] = useState<TargetProbe | null>(null)
	const [browser, setBrowser] = useState<BrowserState | null>(null)
	const [opening, setOpening] = useState<ReviewTarget | null>(null)
	const [openError, setOpenError] = useState<{ error: AppError; url: string | null } | null>(null)
	const [notice, setNotice] = useState<string | null>(null)
	const [github, setGithub] = useState<GitHubStatus | null>(null)
	const [githubOpen, setGithubOpen] = useState(false)
	const [paletteOpen, setPaletteOpen] = useState(false)
	const [publishOpen, setPublishOpen] = useState(false)
	const browserRef = useRef<BrowserHandle>(null)
	const [aiSettings, setAiSettings] = useState<AiSettingsView | null>(null)
	const [settingsOpen, setSettingsOpen] = useState<false | { team: 'new' | string | null }>(false)
	const [aiRuns, setAiRuns] = useState<Array<AiRun>>([])
	const [aiError, setAiError] = useState<string | null>(null)
	const [rightTab, setRightTab] = useState<'comments' | 'findings' | 'github' | 'context'>('comments')
	const [discussion, setDiscussion] = useState<{ reviewId: string; value: Discussion | null; loading: boolean } | null>(null)
	const [selectedFinding, setSelectedFinding] = useState<Finding | null>(null)
	const left = usePanelWidth('panel.left', 280, 180, 600)
	const right = usePanelWidth('panel.right', 320, 220, 640)

	const reviewRef = useRef<Review | null>(null)
	reviewRef.current = review
	const dirtyRef = useRef(false)
	const saveChain = useRef<Promise<unknown>>(Promise.resolve())

	const comparison = loaded?.comparison ?? null
	const files = useMemo(() => (comparison ? flatten(buildTree(comparison.files)) : []), [comparison])

	const persist = useCallback((): Promise<void> => {
		const run = async (): Promise<void> => {
			const r = reviewRef.current
			if (!r || !dirtyRef.current) return
			dirtyRef.current = false
			setSave({ kind: 'saving' })
			const res = await window.review.saveReview(ops.forSave(r))
			if (res.ok) setSave(dirtyRef.current ? { kind: 'dirty' } : { kind: 'saved', at: res.value.savedAt })
			else {
				dirtyRef.current = true
				setSave({ kind: 'error', message: res.error.message })
			}
		}
		const p = saveChain.current.then(run, run)
		saveChain.current = p
		return p
	}, [])

	const change = useCallback((fn: (r: Review) => Review): void => {
		setReview((r) => (r ? fn(r) : r))
		dirtyRef.current = true
		setSave({ kind: 'dirty' })
	}, [])

	// Autosave shortly after edits; the header button saves immediately.
	useEffect(() => {
		if (save.kind !== 'dirty') return
		const t = window.setTimeout(() => void persist(), 800)
		return () => window.clearTimeout(t)
	}, [review, save.kind, persist])

	// Browser state (sidebar, search, selection, scroll) is saved per repository shortly after it changes.
	const browserSave = useRef<{ repoId: string; state: BrowserState } | null>(null)
	const flushBrowser = useCallback(async (): Promise<void> => {
		const pending = browserSave.current
		browserSave.current = null
		if (pending) await window.review.saveBrowserState(pending.repoId, pending.state)
	}, [])
	const updateBrowser = useCallback(
		(next: BrowserState): void => {
			setBrowser(next)
			if (session) browserSave.current = { repoId: session.repo.id, state: next }
		},
		[session],
	)
	useEffect(() => {
		if (!browserSave.current) return
		const t = window.setTimeout(() => void flushBrowser(), 400)
		return () => window.clearTimeout(t)
	}, [browser, flushBrowser])

	useEffect(() => window.review.onFlushRequest(async () => void (await Promise.all([persist(), flushBrowser()]))), [persist, flushBrowser])

	useEffect(() => {
		void window.review.githubStatus().then((r) => r.ok && setGithub(r.value))
		return window.review.onGitHubStatus(setGithub)
	}, [])

	useEffect(() => {
		void window.review.getAiSettings().then((r) => r.ok && setAiSettings(r.value))
		return window.review.onAiSettingsChanged(setAiSettings)
	}, [])

	// Run updates are accepted only for the comparison currently on screen; the main process persists them regardless.
	const comparisonIdRef = useRef<string | null>(null)
	const runsRef = useRef<Array<AiRun>>([])
	runsRef.current = aiRuns
	const autoAddRef = useRef<Array<FindingLevel>>([])
	autoAddRef.current = aiSettings?.levels.autoAdd ?? []
	useEffect(
		() =>
			window.review.onAiRunUpdate((run) => {
				if (run.reviewId !== comparisonIdRef.current) return
				const runs = runsRef.current
				const i = runs.findIndex((r) => r.id === run.id)
				const next = i < 0 ? [...runs, run] : runs.map((r) => (r.id === run.id ? run : r))
				runsRef.current = next
				setAiRuns(next)
				// When a run finishes, its findings at the chosen levels go into the code as comments.
				const finished = runs[i]?.status === 'running' && (run.status === 'completed' || run.status === 'partial')
				if (!finished || !autoAddRef.current.length) return
				const current = reviewRef.current
				if (!current || current.id !== run.reviewId) return
				const { review: withDrafts, added } = ops.autoAddFindings(current, run, next, findingRoots(next), autoAddRef.current)
				if (!added) return
				reviewRef.current = withDrafts
				change(() => withDrafts)
				setNotice(`Added ${added} finding${added === 1 ? '' : 's'} to the code as comments. Nothing is posted until you publish.`)
			}),
		[change],
	)

	const applyComparison = useCallback((r: Result<LoadedComparison>): boolean => {
		if (!r.ok) {
			comparisonIdRef.current = null
			setCompareError(r.error)
			setLoaded(null)
			setReview(null)
			setAiRuns([])
			return false
		}
		setCompareError(null)
		setNotice(r.value.notice)
		comparisonIdRef.current = r.value.comparison.id
		setLoaded(r.value)
		setReview(r.value.review)
		setAiRuns(r.value.aiRuns)
		setAiError(null)
		setSelectedFinding(null)
		dirtyRef.current = false
		setSave({ kind: 'idle' })
		setActiveDraftId(null)
		const first = flatten(buildTree(r.value.comparison.files))
		setSelected(first.find((f) => !r.value.review.viewed.includes(f.key))?.key ?? first[0]?.key ?? null)
		setProbe(null)
		return true
	}, [])

	const refreshSession = useCallback(async (repoId: string) => {
		const s = await window.review.refreshRepo(repoId)
		if (s.ok) {
			setSession(s.value)
			setTabs(s.value.tabs)
		}
	}, [])

	// Review-request counts on the tabs follow the background check, and GitHub connecting or notifications turning off.
	const reloadTabs = useCallback((): void => {
		void window.review.repoTabs().then((r) => r.ok && setTabs(r.value))
	}, [])
	useEffect(() => window.review.onInboxChanged(reloadTabs), [reloadTabs])
	useEffect(reloadTabs, [github?.state, github?.notifications.enabled, reloadTabs])

	const setView = useCallback(
		(view: BrowserState['view']) =>
			setBrowser((b) => {
				if (!b) return b
				const next = { ...b, view }
				const repoId = sessionRef.current?.repo.id
				if (repoId) browserSave.current = { repoId, state: next }
				return next
			}),
		[],
	)
	const sessionRef = useRef<RepoSession | null>(null)
	sessionRef.current = session

	/** Opens a review for a target or a stored snapshot. On failure the browser stays put and explains why. */
	const openReview = useCallback(
		async (repoId: string, target: CompareTarget, prUrl: string | null = null) => {
			await persist()
			setOpenError(null)
			setOpening(target.kind === 'target' ? target.target : null)
			setBusy(
				target.kind === 'target' && target.target.kind === 'pr' ? `Fetching pull request #${target.target.number}…` : 'Loading changes…',
			)
			const r = await window.review.loadComparison(repoId, target)
			setBusy(null)
			setOpening(null)
			if (!r.ok) {
				if (r.error.code !== 'cancelled')
					setOpenError({
						error: r.error,
						url:
							prUrl ??
							(r.error.code === 'pr-unavailable' && target.kind === 'target' && target.target.kind === 'pr'
								? `https://github.com/${target.target.repo}/pull/${target.target.number}`
								: null),
					})
				return false
			}
			applyComparison(r)
			setView('review')
			await refreshSession(repoId)
			return true
		},
		[applyComparison, persist, refreshSession, setView],
	)

	const openSession = useCallback(
		async (r: Result<RepoSession | null>) => {
			if (!r.ok) {
				setRepoError(r.error)
				setBusy(null)
				return
			}
			if (!r.value) {
				setBusy(null)
				return
			}
			await flushBrowser()
			setRepoError(null)
			setTabError(null)
			setOpenError(null)
			setSession(r.value)
			setTabs(r.value.tabs)
			setBrowser(r.value.browser)
			comparisonIdRef.current = null
			setLoaded(null)
			setReview(null)
			setAiRuns([])
			setCompareError(null)
			setBusy(null)
			const s = r.value
			// Restore the review that was on screen last time; otherwise start in the browser.
			if (s.browser.view === 'review' && s.activeReviewId && s.reviews.some((x) => x.id === s.activeReviewId)) {
				const ok = await openReview(s.repo.id, { kind: 'snapshot', reviewId: s.activeReviewId })
				if (!ok) setView('browse')
			} else if (s.browser.view === 'review') setView('browse')
		},
		[flushBrowser, openReview, setView],
	)

	useEffect(() => {
		void window.review.restoreLast().then(openSession)
	}, [openSession])

	const sessionRepoRef = useRef<string | null>(null)
	sessionRepoRef.current = session?.repo.id ?? null

	/** Switches to a repository opened before, restoring where you were in it. Returns whether it opened. */
	const switchRepo = useCallback(
		async (repoId: string): Promise<boolean> => {
			if (sessionRepoRef.current === repoId) return true
			await persist()
			const r = await window.review.openKnownRepo(repoId)
			if (!r.ok && sessionRepoRef.current) {
				// Keep the current repository on screen; the tab strip says why the other one did not open.
				setTabError(r.error.message)
				return false
			}
			await openSession(r)
			return r.ok
		},
		[openSession, persist],
	)

	// A clicked review-request notification opens that PR's review, switching to its repository first if needed.
	useEffect(
		() =>
			window.review.onInboxOpen(async (t) => {
				if (!(await switchRepo(t.repoId))) return
				void window.review.markPrSeen(t.repoId, t.number)
				await openReview(t.repoId, { kind: 'target', target: { kind: 'pr', repo: t.repo, number: t.number } })
			}),
		[switchRepo, openReview],
	)

	/** Closes a repository tab. Closing the one on screen moves to its neighbour, or to the empty state if it was the last. */
	const closeTab = async (repoId: string): Promise<void> => {
		const active = sessionRepoRef.current === repoId
		if (active) await Promise.all([persist(), flushBrowser()])
		const r = await window.review.closeRepoTab(repoId)
		if (!r.ok) {
			setTabError(r.error.message)
			return
		}
		const at = tabs.findIndex((t) => t.id === repoId)
		setTabs(r.value)
		setTabError(null)
		if (!active) return
		const next = r.value[Math.min(Math.max(at, 0), r.value.length - 1)]
		if (next && (await switchRepo(next.id))) return
		comparisonIdRef.current = null
		setSession(null)
		setBrowser(null)
		setLoaded(null)
		setReview(null)
		setAiRuns([])
		setCompareError(null)
		setRepoError(null)
	}
	const tabsRef = useRef(tabs)
	tabsRef.current = tabs
	const switchRepoRef = useRef(switchRepo)
	switchRepoRef.current = switchRepo

	const openRepo = async (): Promise<void> => {
		await persist()
		setBusy('Opening repository…')
		await openSession(await window.review.openRepository())
		setBusy(null)
	}

	const chooseSnapshot = async (reviewId: string): Promise<void> => {
		if (!session) return
		await openReview(session.repo.id, { kind: 'snapshot', reviewId })
	}

	const loadLatest = async (): Promise<void> => {
		if (!session || !comparison) return
		await openReview(session.repo.id, { kind: 'target', target: targetOf(comparison), from: comparison.id })
	}

	const backToBrowser = async (): Promise<void> => {
		await persist()
		setView('browse')
		window.setTimeout(() => browserRef.current?.focusSearch(), 0)
	}

	const view = browser?.view ?? 'browse'

	// A branch review whose branch has a pull request offers to open that instead (publishing needs a PR review).
	const branchHead =
		comparison && !comparison.pr && comparison.target?.kind === 'branch'
			? comparison.target.headRef
			: comparison && !comparison.pr && !comparison.target
				? 'HEAD'
				: null
	const branchPr = useBranchPr(session?.repo.id ?? '', branchHead, view === 'review' && !!session?.github.selected && !!branchHead)
	const openBranchPr = (pr: { number: number }): void => {
		const repo = branchPr.data?.repo
		if (session && repo && comparison)
			void openReview(session.repo.id, { kind: 'target', target: { kind: 'pr', repo, number: pr.number }, from: comparison.id })
	}

	// Detect new commits on the open review's target. Branch checks are local; PR checks use the API, so they run less often.
	useEffect(() => {
		if (!session || !comparison || view !== 'review') return
		const repoId = session.repo.id
		const id = comparison.id
		const isPr = comparison.pr !== null
		let live = true
		const check = (): void => {
			void window.review.probeTarget(repoId, id).then((r) => {
				if (live && r.ok) setProbe(r.value)
			})
		}
		check()
		const t = window.setInterval(check, isPr ? 120_000 : 15_000)
		window.addEventListener('focus', check)
		return () => {
			live = false
			window.clearInterval(t)
			window.removeEventListener('focus', check)
		}
	}, [session?.repo.id, comparison?.id, view]) // eslint-disable-line react-hooks/exhaustive-deps

	// The PR's existing discussion on GitHub, read when a PR review opens and on Refresh. Read-only.
	const loadDiscussion = useCallback((repoId: string, reviewId: string): void => {
		setDiscussion((d) => ({ reviewId, value: d?.reviewId === reviewId ? d.value : null, loading: true }))
		void window.review.prDiscussion(repoId, reviewId).then((r) => {
			if (comparisonIdRef.current !== reviewId) return
			setDiscussion({
				reviewId,
				loading: false,
				value: r.ok
					? r.value
					: {
							status: 'unavailable',
							reason: r.error.message,
							fetchedAt: new Date().toISOString(),
							prHead: null,
							threads: [],
							reviews: [],
							conversation: [],
							omitted: { threads: 0, comments: 0, reviews: 0, conversation: 0 },
						},
			})
		})
	}, [])
	const isPrReview = !!comparison?.pr
	useEffect(() => {
		if (session && comparison?.pr) loadDiscussion(session.repo.id, comparison.id)
		else setDiscussion(null)
	}, [session?.repo.id, comparison?.id]) // eslint-disable-line react-hooks/exhaustive-deps

	// Who approved or reviewed the open pull request, re-read as often as the PR is checked for new commits.
	const [prReview, setPrReview] = useState<{ id: string; value: PrReviewState | null; author: string | null } | null>(null)
	useEffect(() => {
		if (!session || !comparison?.pr || view !== 'review') return
		const id = comparison.id
		const n = comparison.pr.number
		let live = true
		const read = (): void => {
			void window.review
				.prDetail(session.repo.id, n)
				.then((r) => live && r.ok && setPrReview({ id, value: r.value.review, author: r.value.author }))
		}
		read()
		const t = window.setInterval(read, 120_000)
		return () => {
			live = false
			window.clearInterval(t)
		}
	}, [session?.repo.id, comparison?.id, view]) // eslint-disable-line react-hooks/exhaustive-deps

	// Global shortcuts: Cmd/Ctrl+P quick open, Cmd/Ctrl+1–9 repository tabs, "/" focuses the visible search unless typing somewhere.
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (!sessionRef.current || document.querySelector('.modal')) return
			if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'p') {
				e.preventDefault()
				setPaletteOpen(true)
			} else if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
				// 9 is the last tab, as in browsers.
				const list = tabsRef.current
				const tab = e.key === '9' ? list[list.length - 1] : list[Number(e.key) - 1]
				if (!tab) return
				e.preventDefault()
				void switchRepoRef.current(tab.id)
			} else if (
				e.key === '/' &&
				!e.metaKey &&
				!e.ctrlKey &&
				!e.altKey &&
				!isTyping(document.activeElement) &&
				!document.querySelector('.palette')
			) {
				const el = [...document.querySelectorAll<HTMLInputElement>('[data-search]')].find((x) => x.offsetParent !== null)
				if (el) {
					e.preventDefault()
					el.focus()
					el.select()
				}
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [])

	const repo = probe?.repo ?? session?.repo ?? null
	const update = probe?.changed && comparison ? probe : null

	const viewed = useMemo(() => new Set(review?.viewed ?? []), [review?.viewed])
	const commented = useMemo(() => {
		const m = new Map<string, number>()
		for (const c of review?.comments ?? []) m.set(c.anchor.fileKey, (m.get(c.anchor.fileKey) ?? 0) + 1)
		return m
	}, [review?.comments])

	const selectFile = (key: string): void => {
		if (key === selected) return
		if (activeDraftId) {
			const d = review?.drafts.find((x) => x.id === activeDraftId)
			if (d && ops.isBlank(d)) change((r) => ops.discardDraft(r, d.id))
		}
		setActiveDraftId(null)
		setSelected(key)
	}

	const nextUnreviewed = (): void => {
		const i = files.findIndex((f) => f.key === selected)
		const order = [...files.slice(i + 1), ...files.slice(0, Math.max(0, i))]
		const next = order.find((f) => !viewed.has(f.key))
		if (next) selectFile(next.key)
	}

	const openItem = (fileKey: string, itemId: string, anchor: Anchor, draftId: string | null): void => {
		if (!comparison?.files.some((x) => x.key === fileKey)) return // an outdated comment on a file no longer in the change
		selectFile(fileKey)
		if (draftId) setActiveDraftId(draftId)
		setSelectedFinding(null)
		setReveal({ fileKey, itemId, anchor, nonce: Date.now() })
	}

	const roots = useMemo(() => findingRoots(aiRuns), [aiRuns])

	const current = discussion && comparison && discussion.reviewId === comparison.id ? discussion : null
	const threads: Array<DiscussionThread> = useMemo(() => current?.value?.threads ?? [], [current?.value])
	const fileThreads = useMemo(() => threads.filter((t) => t.fileKey === selected), [threads, selected])
	// A comment isn't "already discussed" by the thread it was itself published as.
	const discussed = (anchor: Anchor, commentId: string | null): Array<DiscussionThread> => {
		const c = commentId ? review?.comments.find((x) => x.id === commentId) : undefined
		const own = new Set<string>()
		const pub = commentId ? review?.publication?.comments[commentId] : undefined
		if (pub) own.add(pub.githubId).add(pub.url)
		if (c?.carried?.published) own.add(c.carried.published.url)
		return discussedAt(threads, anchor, own)
	}
	const openThread = (t: DiscussionThread): void => {
		if (!t.fileKey || !comparison) return
		selectFile(t.fileKey)
		setSelectedFinding(null)
		const at = t.placed
		const anchor: Anchor | null =
			at && at.startLine !== null && t.side
				? {
						repoId: comparison.repoId,
						baseSha: comparison.baseSha,
						headSha: comparison.headSha,
						fileKey: t.fileKey,
						oldPath: null,
						newPath: null,
						side: t.side,
						startLine: at.startLine,
						endLine: at.endLine,
						excerpt: '',
					}
				: null
		setReveal({ fileKey: t.fileKey, itemId: t.id, anchor, nonce: Date.now() })
	}
	const activeRun = aiRuns.find((r) => r.status === 'running') ?? null

	const aiSelection: ModelSelection | null = aiSettings?.selection ?? null
	const aiProblem =
		aiSettings && !aiSettings.connections.some((c) => c.status === 'connected')
			? 'No AI provider is connected. Open Settings → AI providers to connect one; manual review works without it.'
			: (aiSettings?.selectionIssue ?? null)

	const selectModel = async (sel: ModelSelection): Promise<void> => {
		const r = await window.review.selectModel(sel)
		if (r.ok) setAiSettings(r.value)
		else setAiError(r.error.message)
	}

	const reviewer: ReviewerChoice | null = aiSettings?.reviewer ?? null
	const selectTeam = async (teamId: string): Promise<void> => {
		const r = await window.review.selectTeam(teamId)
		if (r.ok) setAiSettings(r.value)
		else setAiError(r.error.message)
	}

	const startAi = async (scope: AiScope, passes = false): Promise<void> => {
		if (!comparison || !reviewer) return
		await persist()
		setAiError(null)
		setRightTab('findings')
		const r = await window.review.startAiReview(comparison.id, scope, reviewer.kind === 'model' ? { ...reviewer, passes } : reviewer)
		if (!r.ok) setAiError(r.error.message)
		else if (comparisonIdRef.current === r.value.reviewId)
			setAiRuns((runs) => (runs.some((x) => x.id === r.value.id) ? runs : [...runs, r.value]))
	}

	const retryRules = async (run: AiRun, rules: Array<ReviewRule>): Promise<void> => {
		if (!comparison) return
		await persist()
		setAiError(null)
		const r = await window.review.retryAiRules(comparison.id, run.id, rules)
		if (!r.ok) setAiError(r.error.message)
		else if (comparisonIdRef.current === r.value.reviewId) setAiRuns((runs) => runs.map((x) => (x.id === r.value.id ? r.value : x)))
	}

	// Where the open pull request sits in its stack, from the mapped repository's open PRs.
	const stackRepo = view === 'review' && comparison?.pr && session?.github.selected?.toLowerCase() === comparison.pr.repo.toLowerCase()
	const prGraph = usePrGraph(session?.repo.id ?? null, !!stackRepo && github?.state === 'connected', comparison?.id)

	const openFinding = (f: Finding): void => {
		selectFile(f.anchor.fileKey)
		setSelectedFinding(f)
		setReveal({ fileKey: f.anchor.fileKey, itemId: null, anchor: f.anchor, nonce: Date.now() })
	}

	const acceptFinding = (f: Finding): void => {
		if (!review) return
		const res = ops.acceptFinding(review, f, roots)
		if (res.created) change(() => res.review)
		selectFile(f.anchor.fileKey)
		setSelectedFinding(null)
		if (res.draftId) setActiveDraftId(res.draftId)
		setReveal({ fileKey: f.anchor.fileKey, itemId: res.draftId ?? res.commentId, anchor: f.anchor, nonce: Date.now() })
	}

	const askFinding = async (f: Finding, question: string): Promise<string | null> => {
		if (!comparison) return 'No comparison is open.'
		const r = await window.review.askFinding(comparison.id, f.id, question)
		if (!r.ok) return r.error.message
		if (comparisonIdRef.current === r.value.reviewId) setAiRuns((runs) => runs.map((x) => (x.id === r.value.id ? r.value : x)))
		return null
	}

	// From a draft or comment made from a finding: show that finding (and its questions) in the Findings tab.
	const [askFocus, setAskFocus] = useState<{ findingId: string; nonce: number } | null>(null)
	const showFinding = (findingId: string): void => {
		const f = aiRuns.flatMap((r) => r.findings).find((x) => x.id === findingId)
		if (!f) return
		setRightTab('findings')
		setSelectedFinding(f)
		setAskFocus({ findingId, nonce: Date.now() })
	}

	const file = comparison?.files.find((f) => f.key === selected) ?? null
	const fileComments = useMemo(() => review?.comments.filter((c) => c.anchor.fileKey === selected) ?? [], [review?.comments, selected])
	const fileDrafts = useMemo(() => review?.drafts.filter((d) => d.anchor.fileKey === selected) ?? [], [review?.drafts, selected])

	// Short on screen; when it was saved, or why it failed, is in the tooltip.
	const saveLabel =
		save.kind === 'saving' ? 'Saving…' : save.kind === 'dirty' ? 'Unsaved' : save.kind === 'error' ? 'Save failed' : review ? 'Saved' : ''
	const savedAt = save.kind === 'saved' ? save.at! : (review?.updatedAt ?? null)
	const saveTitle =
		save.kind === 'error'
			? `Save failed: ${save.message}\nClick to try again.`
			: `${savedAt && save.kind !== 'dirty' && save.kind !== 'saving' ? `Saved on this computer ${new Date(savedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}.\n` : ''}Edits save automatically; click to save now. Nothing is sent to GitHub until you publish.`

	const snapshotsForTarget: Array<ReviewSummary> = useMemo(() => {
		if (!comparison || !session) return []
		const key = targetKey(targetOf(comparison))
		return session.reviews.filter((r) => targetKey(targetOf(r)) === key)
	}, [comparison, session])

	return (
		<div className="app">
			{tabs.length > 0 && (
				<RepoTabs
					tabs={tabs}
					activeId={session?.repo.id ?? null}
					error={tabError}
					onSelect={(id) => void switchRepo(id)}
					onClose={(id) => void closeTab(id)}
					onOpen={() => void openRepo()}
					onDismissError={() => setTabError(null)}
				/>
			)}
			<header className="header">
				<div className="hctx">
					{!repo && (
						<button className="btn repo-btn" onClick={() => void openRepo()}>
							<span className="ellipsis">Open repository</span>
						</button>
					)}
					{repo && session && browser && (
						<>
							<div className="seg view-switch" role="tablist" aria-label="Workspace">
								<button
									role="tab"
									aria-selected={view === 'browse'}
									className={view === 'browse' ? 'on' : ''}
									onClick={() => void backToBrowser()}
								>
									Browse
								</button>
								<button
									role="tab"
									aria-selected={view === 'review'}
									className={view === 'review' ? 'on' : ''}
									disabled={!comparison}
									onClick={() => setView('review')}
									title={comparison ? undefined : 'Open a review from the browser first'}
								>
									Review
								</button>
							</div>
							{view === 'browse' && (
								<span
									className="hfield shrink checked-out"
									title={`Checked out: ${repo.branch ?? 'detached HEAD'}. Opening a review never changes it.`}
								>
									<span className="muted">Checked out</span>
									<span className="mono ellipsis">{repo.branch ?? `detached HEAD${repo.headSha ? ` @ ${short(repo.headSha)}` : ''}`}</span>
								</span>
							)}
						</>
					)}
				</div>
				<div className="hactions">
					{session && (
						<button
							className="btn ghost icon"
							onClick={() => setPaletteOpen(true)}
							title="Go to a pull request or branch (⌘P / Ctrl+P)"
							aria-label="Go to"
						>
							<svg
								width="15"
								height="15"
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
						</button>
					)}
					{view === 'review' && comparison && review && (
						<div className="hgroup ai-group">
							<ModelPicker
								settings={aiSettings}
								selection={aiSelection}
								disabled={activeRun !== null}
								onSelect={(sel) => void selectModel(sel)}
								onSelectTeam={(id) => void selectTeam(id)}
								onManage={(team) => setSettingsOpen({ team: team ?? null })}
							/>
							{reviewer && (
								<AiRunControl
									settings={aiSettings}
									reviewer={reviewer}
									activeRun={activeRun}
									currentFile={file}
									fileCount={comparison.files.length}
									onStart={(scope, passes) => void startAi(scope, passes)}
									onCancel={() => activeRun && void window.review.cancelAiReview(activeRun.id)}
								/>
							)}
						</div>
					)}
					{view === 'review' && review && (
						<>
							<button
								className={`btn ghost small save-status ${save.kind === 'error' ? 'error' : 'muted'}`}
								onClick={() => {
									dirtyRef.current = true
									void persist()
								}}
								disabled={save.kind === 'saving'}
								title={saveTitle}
							>
								<span role="status" aria-live="polite">
									{saveLabel}
								</span>
							</button>
							{comparison?.pr ? (
								<button
									className="btn primary"
									onClick={() => setPublishOpen(true)}
									title="Add your comments to a pending review on GitHub, then submit it when you're ready"
								>
									Publish to GitHub…
								</button>
							) : (
								!branchPr.data?.prs.length && (
									<button
										className="btn"
										disabled
										title={
											!session?.github.selected
												? 'Publishing needs a GitHub remote and a pull request.'
												: branchPr.error
													? `This is a branch review, and its pull request couldn’t be looked up: ${lookupProblem(branchPr.error)}`
													: 'This is a branch review, and no pull request was found for this branch. Publishing works on pull request reviews.'
										}
									>
										Publish to GitHub…
									</button>
								)
							)}
						</>
					)}
					<span className="divider" />
					<button
						className={`btn ghost small ${github?.state === 'connected' ? '' : 'muted'}`}
						onClick={() => setGithubOpen(true)}
						title={github?.state === 'connected' ? `GitHub · ${github.login}` : 'Settings · GitHub'}
					>
						GitHub{github?.state === 'connected' ? ' ✓' : ''}
					</button>
					<button
						className="btn ghost icon settings-btn"
						onClick={() => setSettingsOpen({ team: null })}
						title="Settings · AI providers"
						aria-label="Settings"
					>
						<svg
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
							<circle cx="12" cy="12" r="3" />
						</svg>
					</button>
				</div>
			</header>
			{view === 'review' && comparison && repo && (
				<div className="target-bar">
					<TargetLabel
						comparison={comparison}
						author={comparison.pr?.author ?? (prReview?.id === comparison.id ? prReview.author : null)}
					/>
					{comparison.pr && prReview?.id === comparison.id && <ReviewBadge review={prReview.value} viewer={github?.login ?? null} short />}
					{stackRepo && prGraph && comparison.pr && <StackBadge graph={prGraph} number={comparison.pr.number} />}
					{snapshotsForTarget.length > 1 && (
						<label className="hfield shrink snapshot-pick" title="Earlier snapshots of this target stay pinned to their original commits">
							<span className="muted">Snapshot</span>
							<select value={comparison.id} onChange={(e) => void chooseSnapshot(e.target.value)}>
								{snapshotsForTarget.map((s) => (
									<option key={s.id} value={s.id}>
										{short(s.headSha)} · {new Date(s.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
										{s.comments ? ` · ${s.comments} comment${s.comments === 1 ? '' : 's'}` : ''}
									</option>
								))}
							</select>
						</label>
					)}
					{repo.uncommitted > 0 && (
						<span className="pill warn" title="Only committed changes are reviewed. Working-tree and staged changes are not included.">
							{repo.uncommitted} uncommitted change{repo.uncommitted === 1 ? '' : 's'} excluded
						</span>
					)}
				</div>
			)}

			{view === 'review' && update && comparison && (
				<div className="banner" role="status">
					<span>
						Update available: {update.summary}. Your comments carry over to the update, and those whose lines changed are marked outdated.
						This snapshot ({short(comparison.baseSha)}…{short(comparison.headSha)}) keeps its own comments, findings and viewed files.
					</span>
					<button className="btn small primary" onClick={() => void loadLatest()} disabled={!!busy}>
						{comparison.pr ? 'Fetch and review update' : 'Review update'}
					</button>
				</div>
			)}
			{view === 'review' && comparison && !comparison.pr && branchPr.error && (
				<div className="banner" role="status">
					<span>
						This is a <strong>branch review</strong>, so it can’t be published. To publish, open the branch’s pull request as a review; but{' '}
						{isAuthProblem(branchPr.error)
							? 'this repository needs a GitHub token to list its pull requests.'
							: lookupProblem(branchPr.error)}
					</span>
					{isAuthProblem(branchPr.error) && (
						<button className="btn small primary" onClick={() => setGithubOpen(true)}>
							Connect GitHub
						</button>
					)}
				</div>
			)}
			{view === 'review' && comparison && !comparison.pr && branchPr.data?.prs[0] && (
				<div className="banner" role="status">
					<span>
						This branch has a pull request. Open it as a pull request review to publish comments to GitHub. Your comments carry over, and
						this branch review keeps its own copy.
					</span>
					<BranchPrHint data={branchPr.data} error={null} opening={!!busy} onOpen={openBranchPr} />
				</div>
			)}
			{view === 'review' && notice && (
				<button className="banner notice-banner" onClick={() => setNotice(null)} title="Dismiss">
					{notice} ✕
				</button>
			)}
			{openError && (
				<div className="banner error-banner" role="alert">
					<span className="selectable">
						<strong>{ERROR_TITLES[openError.error.code] ?? 'Could not open the review'}.</strong> {openError.error.message}
					</span>
					<span className="spacer" />
					{openError.url && (
						<a className="btn small" href={openError.url} target="_blank" rel="noreferrer">
							Open on GitHub ↗
						</a>
					)}
					<button className="btn small ghost" onClick={() => setOpenError(null)} aria-label="Dismiss">
						✕
					</button>
				</div>
			)}

			<main className="body">
				{session && browser && (
					<div className="workspace" hidden={view !== 'browse'}>
						<Browser
							key={session.repo.id}
							ref={browserRef}
							repo={repo ?? session.repo}
							state={browser}
							github={github}
							mapping={session.github}
							reviews={session.reviews}
							opening={opening !== null}
							onState={updateBrowser}
							onOpen={(t) => void openReview(session.repo.id, { kind: 'target', target: t })}
							onOpenSnapshot={(id) => void chooseSnapshot(id)}
							onConnectGitHub={() => setGithubOpen(true)}
							onRefreshRepo={() => void refreshSession(session.repo.id)}
						/>
						{opening && (
							<div className="opening-overlay" role="status">
								<span className="spinner" aria-hidden /> {busy}
								<button className="btn small" onClick={() => void window.review.cancelOpen()}>
									Cancel
								</button>
							</div>
						)}
					</div>
				)}
				{session && view === 'browse' ? null : busy && !comparison ? (
					<div className="empty">{busy}</div>
				) : repoError && !session ? (
					<ErrorState error={repoError} onOpen={() => void openRepo()} />
				) : !session ? (
					<div className="empty">
						<h1>Review</h1>
						<p className="muted">Open a local Git repository to review its committed branch changes.</p>
						<button className="btn primary" onClick={() => void openRepo()}>
							Open repository
						</button>
					</div>
				) : compareError ? (
					<ErrorState error={compareError} onOpen={() => void backToBrowser()} openLabel="Back to browser" />
				) : comparison && review ? (
					<>
						{repoError && (
							<button className="notice floating" onClick={() => setRepoError(null)} title="Dismiss">
								{repoError.message} ✕
							</button>
						)}
						<aside className="side left" style={{ width: left.width }}>
							<FileTree
								files={comparison.files}
								selected={selected}
								viewed={viewed}
								commented={commented}
								onSelect={selectFile}
								onToggleViewed={(k) => change((r) => ops.setViewed(r, k, !viewed.has(k)))}
								onNextUnreviewed={nextUnreviewed}
							/>
						</aside>
						<Splitter onPointerDown={left.start(1)} />
						<section className="center">
							{comparison.files.length === 0 ? (
								<div className="empty">
									<h2>No committed changes</h2>
									<p className="muted">{emptyReason(comparison)}</p>
									{repo && repo.uncommitted > 0 && (
										<p className="muted">
											{repo.uncommitted} uncommitted change{repo.uncommitted === 1 ? ' is' : 's are'} excluded. Review only reads commits,
											so commit the work (for example on a feature branch) to review it here.
										</p>
									)}
									<p className="muted">
										<button className="link" onClick={() => void backToBrowser()}>
											Back to browser
										</button>{' '}
										to pick a different base branch or target.
									</p>
								</div>
							) : file ? (
								<DiffView
									key={`${comparison.id}:${file.key}`}
									comparison={comparison}
									file={file}
									viewed={viewed.has(file.key)}
									comments={fileComments}
									drafts={fileDrafts}
									activeDraftId={activeDraftId}
									reveal={reveal}
									highlight={selectedFinding && selectedFinding.anchor.fileKey === file.key ? selectedFinding.anchor : null}
									threads={fileThreads}
									discussed={discussed}
									onToggleViewed={() => change((r) => ops.setViewed(r, file.key, !viewed.has(file.key)))}
									onStartDraft={(a) => {
										const res = ops.startDraft(review, a, activeDraftId)
										change(() => res.review)
										setActiveDraftId(res.id)
									}}
									onUpdateDraft={(id, patch) => change((r) => ops.updateDraft(r, id, patch))}
									onActivateDraft={(id) => {
										const cur = review.drafts.find((d) => d.id === activeDraftId)
										if (cur && cur.id !== id && ops.isBlank(cur)) change((r) => ops.discardDraft(r, cur.id))
										setActiveDraftId(id)
									}}
									onSubmitDraft={(id) => {
										change((r) => ops.submitDraft(r, id))
										setActiveDraftId(null)
									}}
									onDiscardDraft={(id) => {
										change((r) => ops.discardDraft(r, id))
										if (id === activeDraftId) setActiveDraftId(null)
									}}
									onEditComment={(cid) => {
										const res = ops.editComment(review, cid)
										if (!res.id) return
										change(() => res.review)
										setActiveDraftId(res.id)
									}}
									onDeleteComment={(cid) => {
										if (!window.confirm('Delete this comment?')) return
										change((r) => ops.deleteComment(r, cid))
									}}
									onShowFinding={showFinding}
								/>
							) : (
								<div className="empty muted">Select a file.</div>
							)}
						</section>
						<Splitter onPointerDown={right.start(-1)} />
						<aside className="side right" style={{ width: right.width }}>
							<div className="panel-title tabs" role="tablist">
								<button
									role="tab"
									aria-selected={rightTab === 'comments'}
									className={rightTab === 'comments' ? 'on' : ''}
									onClick={() => setRightTab('comments')}
								>
									My comments <span className="count">{review.comments.length}</span>
								</button>
								<button
									role="tab"
									aria-selected={rightTab === 'findings'}
									className={rightTab === 'findings' ? 'on' : ''}
									onClick={() => setRightTab('findings')}
								>
									Findings <span className="count">{aiRuns[aiRuns.length - 1]?.findings.length ?? 0}</span>
									{activeRun && <AiOrb activity="reasoning" size={14} label="AI review running" />}
								</button>
								{isPrReview && (
									<button
										role="tab"
										aria-selected={rightTab === 'github'}
										className={rightTab === 'github' ? 'on' : ''}
										onClick={() => setRightTab('github')}
										title="Existing review threads, reviews and conversation on GitHub (read-only)"
									>
										GitHub <span className="count">{threads.filter((t) => t.resolved !== true).length}</span>
										{current?.loading && <span className="spinner small" aria-label="loading" />}
									</button>
								)}
								<button
									role="tab"
									aria-selected={rightTab === 'context'}
									className={rightTab === 'context' ? 'on' : ''}
									onClick={() => setRightTab('context')}
									title="Notes and files you give the AI reviewer"
								>
									Context
									{!!review.context && (
										<span className="count">
											{review.context.files.length + (review.context.images?.length ?? 0) + (review.context.notes.trim() ? 1 : 0)}
										</span>
									)}
								</button>
							</div>
							{aiError && (
								<button className="notice" onClick={() => setAiError(null)} title="Dismiss">
									{aiError} ✕
								</button>
							)}
							<PanelBoundary resetKey={`${comparison?.id ?? ''}|${rightTab}`}>
								{rightTab === 'context' ? (
									<ContextPanel
										context={review.context ?? null}
										isPr={isPrReview}
										onNotes={(notes) => change((r) => ops.setContextNotes(r, notes))}
										onAddFiles={(f) => change((r) => ops.addContextFiles(r, f))}
										onRemoveFile={(id) => change((r) => ops.removeContextFile(r, id))}
										onAddImages={(i) => change((r) => ops.addContextImages(r, i))}
										onRemoveImage={(id) => change((r) => ops.removeContextImage(r, id))}
									/>
								) : rightTab === 'github' && isPrReview ? (
									<DiscussionPanel
										discussion={current?.value ?? null}
										loading={!!current?.loading}
										files={files}
										onRefresh={() => session && comparison && loadDiscussion(session.repo.id, comparison.id)}
										onOpen={openThread}
										onConnect={() => setGithubOpen(true)}
									/>
								) : rightTab === 'comments' || rightTab === 'github' ? (
									<CommentsPanel comments={review.comments} drafts={review.drafts} files={files} onOpen={openItem} />
								) : (
									<FindingsPanel
										runs={aiRuns}
										review={review}
										roots={roots}
										files={files}
										aiProblem={aiProblem}
										threads={threads}
										selectedFindingId={selectedFinding?.id ?? null}
										askFocus={askFocus}
										onRetryRules={activeRun ? null : (run, rules) => void retryRules(run, rules)}
										onStop={(run) => void window.review.cancelAiReview(run.id)}
										onOpen={openFinding}
										onAccept={acceptFinding}
										onAsk={askFinding}
										onDismiss={(f, reason) => {
											change((r) => ops.setFindingDecision(r, f.id, 'dismissed', { reason }))
											if (selectedFinding?.id === f.id) setSelectedFinding(null)
										}}
										onNote={(f, note) => change((r) => ops.setDismissNote(r, f.id, note))}
										onRestore={(f) => change((r) => ops.setFindingDecision(r, f.id, 'open'))}
									/>
								)}
							</PanelBoundary>
						</aside>
					</>
				) : (
					<div className="empty">{busy ?? 'Loading…'}</div>
				)}
			</main>
			{githubOpen && github && (
				<GitHubSettings
					status={github}
					mapping={session?.github ?? null}
					onClose={() => setGithubOpen(false)}
					onStatus={setGithub}
					onChooseRepo={async (repo) => {
						if (!session) return
						const r = await window.review.githubSetRepo(session.repo.id, repo)
						if (r.ok) setSession({ ...session, github: r.value })
					}}
				/>
			)}
			{publishOpen && session && comparison?.pr && github && (
				<PublishDialog
					repoId={session.repo.id}
					reviewId={comparison.id}
					writeTokenUrl={github.writeTokenUrl}
					onClose={() => {
						setPublishOpen(false)
						loadDiscussion(session.repo.id, comparison.id) // what was just published shows up as discussion
					}}
					onOpenGitHubSettings={() => {
						setPublishOpen(false)
						setGithubOpen(true)
					}}
					beforePublish={persist}
					blocking={review && aiRuns.length ? blockingSummary(review, aiRuns, roots) : null}
				/>
			)}
			{paletteOpen && session && (
				<QuickOpen
					repo={repo ?? session.repo}
					githubRepo={session.github.selected}
					signedIn={github?.state === 'connected'}
					viewer={github?.login ?? null}
					reviews={session.reviews}
					onConnect={() => setGithubOpen(true)}
					onClose={() => setPaletteOpen(false)}
					onPickPr={(pr) => browserRef.current?.reveal({ kind: 'pr', pr })}
					onPickBranch={(b) => browserRef.current?.reveal({ kind: 'branch', branch: b })}
					onOpenReview={(t) => {
						if (t.kind === 'pr') void window.review.markPrSeen(session.repo.id, t.number)
						void openReview(session.repo.id, { kind: 'target', target: t })
					}}
					onOpenSnapshot={(id) => void chooseSnapshot(id)}
				/>
			)}
			{settingsOpen && aiSettings && (
				<ProviderSettings
					settings={aiSettings}
					initialConnectionId={aiSelection?.connectionId ?? null}
					initialTeam={settingsOpen ? settingsOpen.team : null}
					repoId={session?.repo.id ?? null}
					onClose={() => setSettingsOpen(false)}
					onChange={setAiSettings}
				/>
			)}
		</div>
	)
}

/** "Stacked on #123" for a PR whose base branch is another open PR's branch, with the whole stack in the tooltip. */
function StackBadge({ graph, number }: { graph: PrGraph; number: number }) {
	const self = graph.nodes.find((n) => n.number === number)
	const s = self && stackOf(graph, self)
	if (!s) return null
	const parent = s.parents[s.parents.length - 1]
	const onTop = s.children.reduce((n, c) => n + 1 + c.above, 0)
	const title = [
		`Stack: ${[s.base, ...s.parents.map((n) => `#${n.number} ${n.title}`), `#${number} (this PR)`].filter(Boolean).join('\n  › ')}`,
		...(s.children.length
			? [`Stacked on it: ${s.children.map((c) => `#${c.node.number}${c.above ? ` (+${c.above})` : ''}`).join(', ')}`]
			: []),
		'The diff shows only this PR’s changes, against the branch it is stacked on.',
	].join('\n')
	return (
		<span className="pill small-pill stack-badge nowrap" title={title}>
			{parent ? `Stacked on #${parent.number}` : 'Bottom of a stack'}
			{onTop ? ` · ${onTop} above` : ''}
		</span>
	)
}

/** One tab per open repository. Same-named clones are told apart by their parent folder. */
function RepoTabs(props: {
	tabs: Array<RepoTab>
	activeId: string | null
	error: string | null
	onSelect(id: string): void
	onClose(id: string): void
	onOpen(): void
	onDismissError(): void
}) {
	const { tabs, activeId, error } = props
	const mod = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+'
	// When focus is in the tab row, it follows the selected tab, so a shortcut never leaves the ring on the old one.
	const nav = useRef<HTMLElement>(null)
	useEffect(() => {
		const el = nav.current
		if (el && el.contains(document.activeElement) && document.activeElement?.getAttribute('role') === 'tab')
			el.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
	}, [activeId])
	const label = (t: RepoTab): string => {
		if (tabs.filter((x) => x.name === t.name).length < 2) return t.name
		const parent = t.root.split(/[\\/]/).slice(-2, -1)[0]
		return parent ? `${parent}/${t.name}` : t.name
	}
	return (
		<nav className="repo-tabs" aria-label="Repositories" ref={nav}>
			<div className="repo-tab-list" role="tablist">
				{tabs.map((t, i) => (
					<div key={t.id} className={`repo-tab${t.id === activeId ? ' on' : ''}`}>
						<button
							role="tab"
							aria-selected={t.id === activeId}
							className="repo-tab-name ellipsis"
							aria-label={t.requests ? `${label(t)}, ${t.requests} open review request${t.requests === 1 ? '' : 's'}` : undefined}
							title={`${t.root}${i < 8 ? `\n${mod}${i + 1}` : ''}`}
							onClick={() => props.onSelect(t.id)}
							onAuxClick={(e) => e.button === 1 && props.onClose(t.id)}
						>
							{label(t)}
						</button>
						{!!t.requests && (
							<span className="repo-tab-count" title={`${t.requests} open review request${t.requests === 1 ? '' : 's'}`}>
								{t.requests}
							</span>
						)}
						<button
							className="repo-tab-close"
							aria-label={`Close ${t.name}`}
							title="Close tab. Its reviews are kept and its review requests still notify."
							onClick={() => props.onClose(t.id)}
						>
							×
						</button>
					</div>
				))}
			</div>
			<button className="repo-tab-add" aria-label="Open repository" title="Open repository…" onClick={props.onOpen}>
				+
			</button>
			{error && (
				<button className="notice repo-tab-error ellipsis" onClick={props.onDismissError} title={`${error}\nDismiss`}>
					{error} ✕
				</button>
			)}
		</nav>
	)
}

/** What the review compares; for a pull request, its number (linking to GitHub), title and author. */
function TargetLabel({ comparison: c, author }: { comparison: Comparison; author: string | null }) {
	const title = `Comparing ${short(c.baseSha)}…${short(c.headSha)}\nMerge base ${c.baseSha}\nHead ${c.headSha}\n${c.pr ? `PR base ${c.pr.baseSha}` : `Base tip ${c.baseTipSha}`}`
	return (
		<span className="hfield compare shrink" title={title}>
			{c.pr ? (
				<>
					<a
						className={`pr-state pr-link ${c.pr.state}`}
						href={c.pr.url}
						target="_blank"
						rel="noreferrer"
						title={`Open ${c.pr.repo}#${c.pr.number} on GitHub`}
					>
						#{c.pr.number} ↗
					</a>
					<span className="ellipsis target-title">{c.pr.title}</span>
					{author && (
						<span className="pr-author nowrap" title={`Opened by @${author}`}>
							by @{author}
						</span>
					)}
				</>
			) : (
				<span className="mono ellipsis">{c.headRef ?? short(c.headSha)}</span>
			)}
			<span className="muted">→</span>
			<span className="mono small base-ref ellipsis" title={`Into ${refName(c.baseRef)}`}>
				{refName(c.baseRef)}
			</span>
		</span>
	)
}

function emptyReason(c: Comparison): string {
	const head = c.headRef ?? `HEAD (${short(c.headSha)})`
	const base = refName(c.baseRef)
	if (c.headSha === c.baseTipSha)
		return `${head} and ${base} point to the same commit (${short(c.headSha)}), so there is nothing to compare.`
	if (c.headSha === c.baseSha)
		return `${head} has no commits of its own; it is behind ${base}. Every commit on ${head} is already in ${base}.`
	return `${head} has commits that ${base} does not, but together they make no net file changes compared with the merge base (${short(c.baseSha)}).`
}

function ErrorState({ error, onOpen, onRetry, openLabel }: { error: AppError; onOpen(): void; onRetry?(): void; openLabel?: string }) {
	return (
		<div className="empty">
			<h2>{ERROR_TITLES[error.code] ?? 'Something went wrong'}</h2>
			<p className="muted selectable">{error.message}</p>
			<div className="row-actions">
				{onRetry && (
					<button className="btn" onClick={onRetry}>
						Retry
					</button>
				)}
				<button className="btn primary" onClick={onOpen}>
					{openLabel ?? 'Open another repository'}
				</button>
			</div>
		</div>
	)
}
