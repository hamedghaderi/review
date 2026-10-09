import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
	Anchor,
	ChangedFile,
	CommentDraft,
	Comparison,
	DiscussionThread,
	FileLinesResult,
	PatchResult,
	ReviewComment,
	Side,
} from '../../shared/types.ts'
import { CommentCard, Composer, DraftStub, type PostedState } from './Comment.tsx'
import { ThreadCard } from './Discussion.tsx'
import { anchorRow, buildRows, computeGaps, excerpt, lineNo, linesToReveal, normalizeSpan, type Range, type Row } from './diffModel.ts'

const EXPAND_STEP = 20

export interface RevealRequest {
	fileKey: string
	itemId: string | null
	anchor: Anchor | null
	nonce: number
}

interface Props {
	comparison: Comparison
	file: ChangedFile
	viewed: boolean
	comments: Array<ReviewComment>
	drafts: Array<CommentDraft>
	activeDraftId: string | null
	reveal: RevealRequest | null
	highlight: Anchor | null // an AI finding's source range, shown while the finding is selected
	threads: Array<DiscussionThread> // this file's existing GitHub threads (PR reviews)
	published: ReadonlyMap<string, PostedState> // comment id → its state on GitHub (PR reviews only)
	discussed(anchor: Anchor, commentId: string | null): Array<DiscussionThread>
	onToggleViewed(): void
	onStartDraft(anchor: Anchor): void
	onUpdateDraft(id: string, patch: { body?: string; anchor?: Anchor }): void
	onActivateDraft(id: string | null): void
	onSubmitDraft(id: string): void
	onDiscardDraft(id: string): void
	onEditComment(id: string): void
	onDeleteComment(id: string): void
	onShowFinding?(findingId: string): void // opens the finding a comment was made from, to ask about it
}

type Load<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'done'; value: T }

type Item = { kind: 'comment'; c: ReviewComment } | { kind: 'draft'; d: CommentDraft } | { kind: 'thread'; t: DiscussionThread }

export function DiffView(p: Props) {
	const { comparison, file } = p
	const [patch, setPatch] = useState<Load<PatchResult>>({ state: 'loading' })
	const [force, setForce] = useState(false)
	const [lines, setLines] = useState<FileLinesResult | null>(null)
	const [revealed, setRevealed] = useState<Set<number>>(() => new Set())
	const [pivot, setPivot] = useState<number | null>(null)
	const [extending, setExtending] = useState(false)
	const [notice, setNotice] = useState<string | null>(null)
	const [blockIdx, setBlockIdx] = useState(-1)
	const scroller = useRef<HTMLDivElement>(null)

	useEffect(() => {
		let live = true
		setPatch({ state: 'loading' })
		void window.review.loadPatch(comparison.id, file.key, force).then((r) => {
			if (!live) return
			setPatch(r.ok ? { state: 'done', value: r.value } : { state: 'error', message: r.error.message })
			if (r.ok && r.value.kind === 'text' && file.oldPath && file.newPath) {
				void window.review.loadFileLines(comparison.id, file.key).then((l) => live && setLines(l.ok ? l.value : null))
			}
		})
		return () => {
			live = false
		}
	}, [comparison.id, file.key, file.oldPath, file.newPath, force])

	const hunks = patch.state === 'done' && patch.value.kind === 'text' ? patch.value.hunks : null
	const fileLines = lines?.kind === 'text' ? lines.lines : null
	// Only files with both versions have unchanged lines to expand; added/deleted files are a single full hunk.
	const gaps = useMemo(
		() => (hunks && file.oldPath && file.newPath ? computeGaps(hunks, fileLines ? fileLines.length : null) : null),
		[hunks, fileLines, file],
	)

	// Lines of stored anchors that fall in collapsed context are always shown, so comments render at their source lines.
	const shown = useMemo(() => {
		if (!gaps || !fileLines) return revealed
		const s = new Set(revealed)
		const ranges: Array<{ side: Side | null; startLine: number | null; endLine: number | null }> = [
			...p.comments.map((c) => c.anchor),
			...p.drafts.map((d) => d.anchor),
			...(p.highlight ? [p.highlight] : []),
			...p.threads.flatMap((t) => (t.placed ? [{ side: t.side, ...t.placed }] : [])),
		]
		for (const a of ranges) {
			if (a.side && a.startLine && a.endLine)
				for (const n of linesToReveal(gaps, { side: a.side, start: a.startLine, end: a.endLine }, fileLines.length)) s.add(n)
		}
		return s
	}, [gaps, fileLines, p.comments, p.drafts, p.highlight, p.threads, revealed])

	const { rows, blocks } = useMemo(
		() => (hunks ? buildRows(hunks, gaps, shown, fileLines) : { rows: [] as Array<Row>, blocks: [] }),
		[hunks, gaps, shown, fileLines],
	)

	const activeDraft = p.drafts.find((d) => d.id === p.activeDraftId) ?? null
	const activeRange: Range | null =
		activeDraft?.anchor.side && activeDraft.anchor.startLine && activeDraft.anchor.endLine
			? { side: activeDraft.anchor.side, start: activeDraft.anchor.startLine, end: activeDraft.anchor.endLine }
			: null

	// Attach comments and drafts to the last rendered row of their range. Unplaceable ones are listed above the diff.
	const { byRow, fileLevel, unplaced, elsewhere } = useMemo(() => {
		const byRow = new Map<number, Array<Item>>()
		const fileLevel: Array<Item> = []
		const unplaced: Array<Item> = []
		const elsewhere: Array<Item> = [] // GitHub threads that can't be shown at a line of this snapshot
		// GitHub threads come first, so a comment sits below the discussion it may be answering. A thread your comment was
		// published as is shown on that comment instead, not twice.
		const mine = new Set([...p.published.values()].flatMap((s) => (s.thread ? [s.thread.id] : [])))
		for (const t of p.threads) {
			if (mine.has(t.id)) continue
			const at = t.placed
			if (!at) elsewhere.push({ kind: 'thread', t })
			else if (at.startLine === null || at.endLine === null || !t.side) fileLevel.push({ kind: 'thread', t })
			else {
				const i = anchorRow(rows, { side: t.side, start: at.startLine, end: at.endLine })
				if (i === null) elsewhere.push({ kind: 'thread', t })
				else byRow.set(i, [...(byRow.get(i) ?? []), { kind: 'thread', t }])
			}
		}
		const items: Array<Item> = [
			...p.comments.map((c): Item => ({ kind: 'comment', c })),
			...p.drafts.filter((d) => d.commentId === null || d.id === p.activeDraftId).map((d): Item => ({ kind: 'draft', d })),
		]
		for (const it of items) {
			if (it.kind === 'thread') continue
			const a = it.kind === 'comment' ? it.c.anchor : it.d.anchor
			if (!a.side || !a.startLine || !a.endLine) {
				fileLevel.push(it)
				continue
			}
			const i = anchorRow(rows, { side: a.side, start: a.startLine, end: a.endLine })
			if (i === null) unplaced.push(it)
			else byRow.set(i, [...(byRow.get(i) ?? []), it])
		}
		return { byRow, fileLevel, unplaced, elsewhere }
	}, [rows, p.comments, p.drafts, p.activeDraftId, p.threads, p.published])

	const commentedLines = useMemo(() => {
		const s = new Set<string>()
		for (const c of p.comments) {
			const a = c.anchor
			if (a.side && a.startLine && a.endLine)
				for (let n = a.startLine; n <= a.endLine && n - a.startLine < 5000; n++) s.add(`${a.side}${n}`)
		}
		return s
	}, [p.comments])

	// Scroll to a requested anchor once its rows are rendered.
	const handled = useRef(0)
	useLayoutEffect(() => {
		const r = p.reveal
		if (!r || r.fileKey !== file.key || handled.current === r.nonce || patch.state !== 'done') return
		const a = r.anchor
		let target: Element | null = null
		if (a?.side && a.startLine) {
			const n = rows.findIndex((row) => lineNo(row, a.side!) === a.startLine)
			if (n >= 0) target = scroller.current?.querySelector(`[data-row="${n}"]`) ?? null
			else if (gaps && lines === null) return // context lines still loading
		}
		if (!target && r.itemId) target = scroller.current?.querySelector(`[data-item="${CSS.escape(r.itemId)}"]`) ?? null
		handled.current = r.nonce
		target?.scrollIntoView({ block: 'center' })
	}, [p.reveal, rows, file.key, patch.state, gaps, lines])

	const flash = (msg: string): void => {
		setNotice(msg)
		window.setTimeout(() => setNotice((m) => (m === msg ? null : m)), 2500)
	}

	const makeAnchor = (r: Range | null): Anchor => ({
		repoId: comparison.repoId,
		baseSha: comparison.baseSha,
		headSha: comparison.headSha,
		fileKey: file.key,
		oldPath: file.oldPath,
		newPath: file.newPath,
		side: r?.side ?? null,
		startLine: r?.start ?? null,
		endLine: r?.end ?? null,
		excerpt: r ? excerpt(rows, r) : '',
	})

	const clickLine = (i: number, side: Side, shift: boolean): void => {
		window.getSelection()?.removeAllRanges()
		if ((shift || extending) && activeDraft && activeRange) {
			const m = lineNo(rows[i], activeRange.side)
			if (m === null) {
				flash(`A selection stays in one version. Pick a line number in the ${activeRange.side} column.`)
				return
			}
			const from = pivot ?? activeRange.start
			const r = { side: activeRange.side, start: Math.min(from, m), end: Math.max(from, m) }
			if (pivot === null) setPivot(from)
			p.onUpdateDraft(activeDraft.id, { anchor: makeAnchor(r) })
			setExtending(false)
			return
		}
		const n = lineNo(rows[i], side)
		if (n === null) return
		setPivot(n)
		setExtending(false)
		p.onStartDraft(makeAnchor({ side, start: n, end: n }))
	}

	const onMouseUp = (e: React.MouseEvent): void => {
		if ((e.target as Element).closest('.ln')) return
		const sel = window.getSelection()
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) return
		const range = sel.getRangeAt(0)
		const rowOf = (n: Node): number | null => {
			const el = (n instanceof Element ? n : n.parentElement)?.closest('[data-row]')
			return el && scroller.current?.contains(el) ? Number(el.getAttribute('data-row')) : null
		}
		const start = rowOf(range.startContainer)
		let end = rowOf(range.endContainer)
		if (start === null || end === null) return
		if (end > start && range.endOffset === 0) end-- // triple-click / drag to the start of the next line
		const forward = sel.anchorNode === range.startContainer && sel.anchorOffset === range.startOffset
		const r = forward ? normalizeSpan(rows, start, end) : normalizeSpan(rows, end, start)
		if (!r) return
		setPivot(r.start)
		setExtending(false)
		p.onStartDraft(makeAnchor(r))
	}

	const expand = (row: Row & { t: 'gap' }, dir: 'up' | 'down' | 'all'): void => {
		if (!fileLines) return
		const to = row.to ?? fileLines.length
		let from = row.from
		let end = to
		if (dir === 'up') end = Math.min(to, row.from + EXPAND_STEP - 1) // lines just below the previous hunk
		if (dir === 'down') from = Math.max(row.from, to - EXPAND_STEP + 1) // lines just above the next hunk
		setRevealed((s) => {
			const n = new Set(s)
			for (let i = from; i <= end; i++) n.add(i)
			return n
		})
	}

	const jump = (dir: 1 | -1): void => {
		const sc = scroller.current
		if (!sc || blocks.length === 0) return
		const tops = blocks.map((b) => (sc.querySelector(`[data-row="${b}"]`) as HTMLElement | null)?.offsetTop ?? 0)
		const cur = sc.scrollTop + 40
		let idx: number
		if (dir === 1) idx = tops.findIndex((t) => t > cur + 1)
		else idx = tops.findLastIndex((t) => t < cur - 1)
		if (idx < 0) idx = dir === 1 ? blocks.length - 1 : 0
		setBlockIdx(idx)
		sc.scrollTo({ top: Math.max(0, tops[idx] - 40) })
	}

	const renderItem = (it: Item): React.ReactNode => {
		if (it.kind === 'thread') return <ThreadCard key={it.t.id} thread={it.t} />
		if (it.kind === 'comment') {
			const pending = p.drafts.some((d) => d.commentId === it.c.id)
			if (pending && activeDraft?.commentId === it.c.id) return null
			return (
				<CommentCard
					key={it.c.id}
					comment={it.c}
					posted={p.published.get(it.c.id) ?? null}
					pendingEdit={pending}
					discussed={p.discussed(it.c.anchor, it.c.id)}
					onEdit={() => p.onEditComment(it.c.id)}
					onDelete={() => p.onDeleteComment(it.c.id)}
					onAskAi={it.c.findingId && p.onShowFinding ? () => p.onShowFinding!(it.c.findingId!) : undefined}
				/>
			)
		}
		const d = it.d
		if (d.id === p.activeDraftId) {
			return (
				<Composer
					key={d.id}
					draft={d}
					discussed={p.discussed(d.anchor, d.commentId)}
					extending={extending}
					onChange={(body) => p.onUpdateDraft(d.id, { body })}
					onSubmit={() => p.onSubmitDraft(d.id)}
					onKeep={() => p.onActivateDraft(null)}
					onDiscard={() => p.onDiscardDraft(d.id)}
					onToggleExtend={() => setExtending((x) => !x)}
					onAskAi={d.findingId && p.onShowFinding ? () => p.onShowFinding!(d.findingId!) : undefined}
				/>
			)
		}
		return (
			<DraftStub
				key={d.id}
				draft={d}
				onResume={() => {
					setPivot(d.anchor.startLine)
					p.onActivateDraft(d.id)
				}}
				onDiscard={() => p.onDiscardDraft(d.id)}
			/>
		)
	}

	const renderRow = (row: Row, i: number): React.ReactNode => {
		if (row.t === 'hunk') {
			const h = row.hunk
			return (
				<div key={row.key} className="row hunk-row">
					<span className="hunk-text">
						@@ −{h.oldStart},{h.oldCount} +{h.newStart},{h.newCount} @@ {h.section}
					</span>
				</div>
			)
		}
		if (row.t === 'gap') {
			const count = row.to === null ? null : row.to - row.from + 1
			if (count !== null && count <= 0) return null
			const canExpand = !!fileLines
			return (
				<div key={row.key} className="row gap-row">
					<span className="gap-label">
						{count === null ? 'Unchanged lines' : `${count.toLocaleString()} unchanged line${count === 1 ? '' : 's'}`}
					</span>
					{canExpand ? (
						<span className="gap-actions">
							{count !== null && count > EXPAND_STEP ? (
								<>
									{row.edge !== 'top' && (
										<button className="link" onClick={() => expand(row, 'up')}>
											↓ {EXPAND_STEP} more
										</button>
									)}
									{row.edge !== 'bottom' && (
										<button className="link" onClick={() => expand(row, 'down')}>
											↑ {EXPAND_STEP} more
										</button>
									)}
								</>
							) : null}
							<button className="link" onClick={() => expand(row, 'all')}>
								Show all
							</button>
						</span>
					) : lines && lines.kind !== 'text' ? (
						<span className="muted small">Context unavailable ({lines.kind === 'binary' ? 'binary content' : lines.reason})</span>
					) : null}
				</div>
			)
		}
		const l = row.line
		const selOld = activeRange?.side === 'old' && l.oldNo !== null && l.oldNo >= activeRange.start && l.oldNo <= activeRange.end
		const selNew = activeRange?.side === 'new' && l.newNo !== null && l.newNo >= activeRange.start && l.newNo <= activeRange.end
		const h = p.highlight
		const hNo = h?.side === 'old' ? l.oldNo : h?.side === 'new' ? l.newNo : null
		const found = h !== null && hNo !== null && hNo >= (h.startLine ?? 0) && hNo <= (h.endLine ?? 0)
		const marked = (l.oldNo !== null && commentedLines.has(`old${l.oldNo}`)) || (l.newNo !== null && commentedLines.has(`new${l.newNo}`))
		const items = byRow.get(i)
		return (
			<div key={row.key} className="row-wrap">
				<div
					data-row={i}
					className={`row line ${l.kind} ${selOld || selNew ? 'sel' : ''} ${found ? 'finding-hl' : ''} ${marked ? 'marked' : ''}`}
				>
					<button
						className="ln"
						disabled={l.oldNo === null}
						onClick={(e) => clickLine(i, 'old', e.shiftKey)}
						title={l.oldNo === null ? undefined : `Old line ${l.oldNo}. Click to select, Shift-click to extend.`}
						tabIndex={-1}
					>
						{l.oldNo ?? ''}
					</button>
					<button
						className="ln"
						disabled={l.newNo === null}
						onClick={(e) => clickLine(i, 'new', e.shiftKey)}
						title={l.newNo === null ? undefined : `New line ${l.newNo}. Click to select, Shift-click to extend.`}
						tabIndex={-1}
					>
						{l.newNo ?? ''}
					</button>
					<span className="mark" aria-hidden>
						{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
					</span>
					<span className="code">
						{l.text}
						{l.noNewline && (
							<span className="eol" title="No newline at end of file">
								{' '}
								⏎̸
							</span>
						)}
					</span>
				</div>
				{items && <div className="inline-items">{items.map(renderItem)}</div>}
			</div>
		)
	}

	const pathLabel =
		file.oldPath && file.newPath && file.oldPath !== file.newPath ? `${file.oldPath} → ${file.newPath}` : (file.newPath ?? file.oldPath)

	let body: React.ReactNode
	if (patch.state === 'loading') body = <div className="state">Loading diff…</div>
	else if (patch.state === 'error') body = <div className="state error">Could not load this file: {patch.message}</div>
	else if (patch.value.kind === 'binary') body = <div className="state">Binary file. Its content is not shown.</div>
	else if (patch.value.kind === 'too-large') {
		const v = patch.value
		body = (
			<div className="state">
				<p>This diff is too large to display normally: {v.reason}.</p>
				{v.canForce ? (
					<button className="btn" onClick={() => setForce(true)}>
						Load diff anyway
					</button>
				) : (
					<p className="muted">It cannot be shown in this version of Review.</p>
				)}
			</div>
		)
	} else {
		const onlyMeta =
			hunks?.length === 0 ? (
				<div className="state">
					No content changes
					{file.status === 'renamed'
						? ' — the file was only renamed'
						: file.status === 'type-changed'
							? ' — only the file type or mode changed'
							: ''}
					.
				</div>
			) : null
		body = (
			<>
				{onlyMeta}
				<div
					className="diff-table"
					onMouseUp={onMouseUp}
					onMouseDown={(e) => {
						// Shift-click on a line number extends the comment range, not the browser's text selection.
						if (e.shiftKey && (e.target as Element).closest('.ln')) e.preventDefault()
					}}
				>
					{rows.map(renderRow)}
				</div>
			</>
		)
	}

	return (
		<div className="diff">
			<div className="diff-head">
				<span className={`status st-${file.status}`}>{file.status}</span>
				<span className="mono ellipsis diff-path" title={pathLabel ?? ''}>
					{pathLabel}
				</span>
				{file.similarity !== null && file.status === 'renamed' && <span className="muted small">{file.similarity}% similar</span>}
				{!file.binary && (
					<span className="small">
						<span className="plus">+{file.additions}</span> <span className="minus">−{file.deletions}</span>
					</span>
				)}
				<span className="spacer" />
				{blocks.length > 0 && (
					<span className="nav">
						<span className="muted small">
							{blockIdx >= 0 ? `${blockIdx + 1}/` : ''}
							{blocks.length} change{blocks.length === 1 ? '' : 's'}
						</span>
						<button className="btn small" onClick={() => jump(-1)} title="Previous change">
							↑
						</button>
						<button className="btn small" onClick={() => jump(1)} title="Next change">
							↓
						</button>
					</span>
				)}
				<button className="btn small" onClick={() => p.onStartDraft(makeAnchor(null))}>
					Comment on file
				</button>
				<label className="viewed-toggle">
					<input type="checkbox" checked={p.viewed} onChange={p.onToggleViewed} /> Viewed
				</label>
			</div>
			{notice && <div className="notice">{notice}</div>}
			<div className="diff-scroll" ref={scroller}>
				{(fileLevel.length > 0 || unplaced.length > 0 || elsewhere.length > 0) && (
					<div className="file-items">
						{fileLevel.map(renderItem)}
						{elsewhere.length > 0 && (
							<>
								<div className="muted small">On GitHub, but not at a line of this snapshot:</div>
								{elsewhere.map(renderItem)}
							</>
						)}
						{unplaced.length > 0 && (
							<>
								<div className="muted small">These comments point at lines that are not currently displayed:</div>
								{unplaced.map(renderItem)}
							</>
						)}
					</div>
				)}
				{body}
			</div>
		</div>
	)
}
