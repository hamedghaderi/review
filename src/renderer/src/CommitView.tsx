import { useEffect, useMemo, useState } from 'react'
import type { Anchor, Comparison, CommitView as CommitData, Review } from '../../shared/types.ts'
import { anchorToCommit, anchorToHead, type CommitFileMap } from '../../shared/commitStep.ts'
import { DiffView } from './DiffView.tsx'
import { FileTree } from './FileTree.tsx'
import { Splitter } from './Splitter.tsx'
import type { PostedState } from './Comment.tsx'
import type { SymbolRequest } from './SymbolNav.tsx'
import { keyLabel } from './keymap.ts'
import { buildTree, displayPath, flatten } from './tree.ts'
import { CommitCheckPanel, type CommitChecks } from './CommitCheck.tsx'
import type { CommitCheckNote } from '../../shared/types.ts'

/** What the review does with drafts and comments; shared by the review's own diff and a commit's. */
export interface DraftHandlers {
	start(a: Anchor): void
	update(id: string, patch: { body?: string; anchor?: Anchor }): void
	activate(id: string | null): void
	submit(id: string): void
	discard(id: string): void
	edit(commentId: string): void
	remove(commentId: string): void
	showFinding?(findingId: string): void
	startWith(a: Anchor, body: string): void // a draft with text already in it
}

interface Props {
	head: Comparison // the review's own comparison; comments live there
	commit: CommitData
	position: { index: number; total: number } // 0-based, in the review's commits
	review: Review
	activeDraftId: string | null
	drafts: DraftHandlers
	leftWidth: number
	onSplitter(e: React.PointerEvent): void
	onStep(dir: 1 | -1): void
	onAllChanges(): void
	onLookup(r: SymbolRequest): void
	placeRef: React.RefObject<(() => number) | null>
	checks: CommitChecks
	checkDisabled: string | null // why the AI can't check commits now
	// Walking through the commits: file by file, then on to the next commit when you say so. Null: not walking.
	walk: { onStop(): void; onFinish(): void } | null
}

type MapState = CommitFileMap | { error: string }

const NO_THREADS: [] = []
const NO_QUESTIONS: [] = []
const NOT_ASKING: ReadonlySet<string> = new Set()

/**
 * One commit of a review on its own: its message, its files and their diffs. Comments are the review's: those whose
 * lines are unchanged from this commit to the head show here, and one written here moves to those same lines at the
 * head, or is refused when they change again later.
 */
export function CommitView(p: Props) {
	const { commit, head } = p
	const c = commit.comparison
	// The order the file list shows them in, which the walkthrough follows.
	const ordered = useMemo(() => flatten(buildTree(c.files)), [c.files])
	const [selected, setSelected] = useState<string | null>(ordered[0]?.key ?? null)
	const fileIndex = ordered.findIndex((f) => f.key === selected)
	const nextFile = fileIndex >= 0 ? (ordered[fileIndex + 1] ?? null) : null
	const [maps, setMaps] = useState<ReadonlyMap<string, MapState>>(new Map())
	const [bodyOpen, setBodyOpen] = useState(true)
	const [notice, setNotice] = useState<string | null>(null)

	useEffect(() => {
		let live = true
		for (const f of c.files)
			void window.review.commitFileMap(head.id, c.id, f.key).then((r) => {
				if (live) setMaps((m) => new Map(m).set(f.key, r.ok ? r.value : { error: r.error.message }))
			})
		return () => {
			live = false
		}
	}, [head.id, c.id]) // eslint-disable-line react-hooks/exhaustive-deps

	const file = c.files.find((f) => f.key === selected) ?? null
	const fileMap = file ? maps.get(file.key) : undefined
	const map = fileMap && !('error' in fileMap) ? fileMap : null

	// The review's comments and drafts that belong at a line (or on the file) of this commit's version.
	const here = useMemo(() => {
		const comments = new Map<string, Array<Review['comments'][number]>>()
		const drafts = new Map<string, Array<Review['drafts'][number]>>()
		for (const f of c.files) {
			const m = maps.get(f.key)
			if (!m || 'error' in m) continue
			comments.set(
				f.key,
				p.review.comments.flatMap((x) => {
					const a = anchorToCommit(x.anchor, m, c, f)
					return a ? [{ ...x, anchor: a }] : []
				}),
			)
			drafts.set(
				f.key,
				p.review.drafts.flatMap((x) => {
					const a = anchorToCommit(x.anchor, m, c, f)
					return a ? [{ ...x, anchor: a }] : []
				}),
			)
		}
		return { comments, drafts }
	}, [maps, p.review.comments, p.review.drafts, c])

	const commented = useMemo(() => new Map([...here.comments].flatMap(([k, v]) => (v.length ? [[k, v.length] as const] : []))), [here])
	const fileComments = useMemo(() => (file ? (here.comments.get(file.key) ?? []) : []), [here, file])
	const fileDrafts = useMemo(() => (file ? (here.drafts.get(file.key) ?? []) : []), [here, file])
	const published = useMemo(() => {
		const m = new Map<string, PostedState>()
		if (!head.pr) return m
		for (const x of fileComments) {
			const pub = p.review.publication?.comments[x.id]
			m.set(x.id, { url: pub?.url ?? x.carried?.published?.url ?? null, edited: !!pub && pub.body !== x.body, thread: null })
		}
		return m
	}, [head.pr, fileComments, p.review.publication])

	const toHead = (a: Anchor): { anchor: Anchor } | { refused: string } => {
		if (fileMap && 'error' in fileMap) return { refused: `This file couldn’t be lined up with the latest commit: ${fileMap.error}` }
		if (!map) return { refused: 'Still lining this file up with the latest commit. Try again in a moment.' }
		return anchorToHead(a, map, head, commit.entry.sha)
	}

	const fileAt = (path: string) => c.files.find((f) => f.newPath === path || f.oldPath === path) ?? null
	// A check's note as a comment: at its line in the latest commit, or on the file (naming the commit and line) when
	// that line changed later.
	const commentFrom = (n: CommitCheckNote): void => {
		setNotice(null)
		const f = n.path ? fileAt(n.path) : null
		const m = f ? maps.get(f.key) : undefined
		if (!f || !m || 'error' in m) return setNotice('That file can’t be lined up with the latest commit yet. Try again in a moment.')
		const at = (line: number | null): Anchor => ({
			repoId: c.repoId,
			baseSha: c.baseSha,
			headSha: c.headSha,
			fileKey: f.key,
			oldPath: f.oldPath,
			newPath: f.newPath,
			side: line ? 'new' : null,
			startLine: line,
			endLine: line,
			excerpt: '',
		})
		const sha = commit.entry.sha.slice(0, 7)
		let r = anchorToHead(at(n.line), m, head, commit.entry.sha)
		let body = n.text
		if ('refused' in r && n.line) {
			r = anchorToHead(at(null), m, head, commit.entry.sha)
			body = `In ${sha}, line ${n.line}: ${n.text}`
		}
		if ('refused' in r) return setNotice(r.refused)
		setSelected(f.key)
		p.drafts.startWith(r.anchor, body)
	}

	const { index, total } = p.position
	const next = keyLabel('commitNext')
	const prev = keyLabel('commitPrev')
	const date = new Date(commit.entry.at)
	return (
		<>
			<aside className="side left" style={{ width: p.leftWidth }}>
				<FileTree files={c.files} selected={selected} viewed={NO_VIEWED} commented={commented} onSelect={setSelected} />
			</aside>
			<Splitter onPointerDown={p.onSplitter} />
			<section className="center">
				<div className="commit-head">
					<div className="commit-title">
						<span className="muted small nowrap">
							Commit {index + 1} of {total}
						</span>
						<strong className="commit-subject selectable">{commit.entry.subject || '(no message)'}</strong>
						<span className="spacer" />
						<button
							className="btn small"
							onClick={() => p.onStep(-1)}
							title={`${index === 0 ? 'All changes' : 'Previous commit'}${prev ? ` (${prev})` : ''}`}
						>
							↑
						</button>
						<button
							className="btn small"
							onClick={() => p.onStep(1)}
							disabled={index >= total - 1}
							title={`Next commit${next ? ` (${next})` : ''}`}
						>
							↓
						</button>
						<button className="btn small" onClick={p.onAllChanges}>
							All changes
						</button>
					</div>
					<div className="muted small commit-meta">
						<span className="mono selectable">{commit.entry.sha.slice(0, 7)}</span> · {commit.entry.author} ·{' '}
						<span title={date.toLocaleString()}>{date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</span>
						{commit.body && (
							<>
								{' '}
								·{' '}
								<button className="link" onClick={() => setBodyOpen((o) => !o)} aria-expanded={bodyOpen}>
									{bodyOpen ? 'Hide message' : 'Show message'}
								</button>
							</>
						)}
					</div>
					{commit.body && bodyOpen && <pre className="commit-body selectable">{commit.body}</pre>}
					<CommitCheckPanel
						sha={commit.entry.sha}
						cc={p.checks}
						disabled={p.checkDisabled}
						onOpenFile={(path) => {
							const f = fileAt(path)
							if (f) setSelected(f.key)
						}}
						onComment={commentFrom}
					/>
					{map && !map.headFileKey && <div className="muted small commit-note">Comments can’t go on this file here: {map.reason}</div>}
					{notice && (
						<button className="link small error-text" onClick={() => setNotice(null)} title="Dismiss">
							{notice} ✕
						</button>
					)}
				</div>
				{c.files.length === 0 ? (
					<div className="empty muted">This commit changes no files.</div>
				) : file ? (
					<DiffView
						key={`${c.id}:${file.key}`}
						comparison={c}
						file={file}
						viewed={false}
						comments={fileComments}
						drafts={fileDrafts}
						activeDraftId={p.activeDraftId}
						reveal={null}
						highlight={null}
						threads={NO_THREADS}
						published={published}
						questions={NO_QUESTIONS}
						asking={NOT_ASKING}
						askDisabled="Questions about the code are asked in All changes."
						askModel={null}
						askModelPicker={null}
						onAskCode={async () => null}
						onDeleteQuestion={() => undefined}
						discussed={() => NO_THREADS}
						refuseAnchor={(a) => {
							const r = toHead(a)
							return 'refused' in r ? r.refused : null
						}}
						onStartDraft={(a) => {
							const r = toHead(a)
							if ('anchor' in r) p.drafts.start(r.anchor)
						}}
						onUpdateDraft={(id, patch) => {
							if (!patch.anchor) return p.drafts.update(id, patch)
							const r = toHead(patch.anchor)
							if ('anchor' in r) p.drafts.update(id, { ...patch, anchor: r.anchor })
						}}
						onActivateDraft={p.drafts.activate}
						onSubmitDraft={p.drafts.submit}
						onDiscardDraft={p.drafts.discard}
						onEditComment={p.drafts.edit}
						onDeleteComment={p.drafts.remove}
						onShowFinding={p.drafts.showFinding}
						onLookup={p.onLookup}
						placeRef={p.placeRef}
					/>
				) : (
					<div className="empty muted">Select a file.</div>
				)}
				{p.walk && (
					<div className="walk-bar" role="region" aria-label="Walkthrough">
						<span className="muted small nowrap">
							Walkthrough · commit {index + 1} of {total}
							{ordered.length > 1 && fileIndex >= 0 ? ` · file ${fileIndex + 1} of ${ordered.length}` : ''}
						</span>
						<span className="spacer" />
						<button className="btn small ghost" onClick={p.walk.onStop}>
							Stop walkthrough
						</button>
						{nextFile ? (
							<button className="btn small primary" onClick={() => setSelected(nextFile.key)}>
								Next file: {displayPath(nextFile)}
							</button>
						) : index < total - 1 ? (
							<button className="btn small primary" onClick={() => p.onStep(1)}>
								Continue to commit {index + 2} of {total}
							</button>
						) : (
							<button className="btn small primary" onClick={p.walk.onFinish}>
								Finish: see all changes
							</button>
						)}
					</div>
				)}
			</section>
		</>
	)
}

const NO_VIEWED: Set<string> = new Set()
