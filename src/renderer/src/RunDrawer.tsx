import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AiRun, RunBeat } from '../../shared/types.ts'
import { AiOrb } from './AiOrb.tsx'
import { keyLabel } from './keymap.ts'
import {
	elapsed,
	journeyRows,
	lookupSummary,
	lookupText,
	memberLabel,
	memberSlot,
	TONE_GLYPH,
	TONE_LABEL,
	withLive,
	type JourneyRow,
} from './journeyView.ts'
import { pane } from './panes.ts'

const HEIGHT_KEY = 'runDrawer.height'
const USED_KEY = 'runDrawer.used'
const MIN_HEIGHT = 120
const DEFAULT_HEIGHT = 260

/** Whether you have opened the drawer yourself: only then does starting a run open it. */
export function drawerUsed(): boolean {
	try {
		return localStorage.getItem(USED_KEY) === '1'
	} catch {
		return false
	}
}

export function rememberDrawerUsed(): void {
	try {
		localStorage.setItem(USED_KEY, '1')
	} catch {
		// starting a run just won't open it
	}
}

/** The closed drawer: a thin bar to open it, which pulses while a run is going (an automatic review never opens it). */
export function RunDrawerHandle({ running, onOpen }: { running: boolean; onOpen: () => void }) {
	const key = keyLabel('runDrawer')
	return (
		<button
			className={`run-drawer-handle${running ? ' live' : ''}`}
			onClick={onOpen}
			title={key ? `Show the run (${key})` : 'Show the run'}
		>
			<span className="run-drawer-dot" aria-hidden />
			Run{running ? ' · in progress' : ''}
			{key && <kbd>{key}</kbd>}
		</button>
	)
}

/**
 * The drawer under the review (issue #299): what a review run did, step by step, as it happens. Only what the app saw:
 * the stages, the files and searches the reviewers asked for, their answers, and the double-checks' verdicts.
 */
export function RunDrawer({
	runs,
	runId,
	onRunId,
	onClose,
	onOpen,
}: {
	runs: ReadonlyArray<AiRun>
	runId: string | null
	onRunId: (id: string) => void
	onClose: () => void
	onOpen: (path: string, line: number | null) => void
}) {
	const run = runs.find((r) => r.id === runId) ?? runs.at(-1) ?? null
	const [live, setLive] = useState<{ runId: string | null; beats: Array<RunBeat> }>({ runId: null, beats: [] })
	useEffect(
		() =>
			window.review.onAiRunBeat((id, beat) =>
				setLive((l) => (l.runId === id ? { runId: id, beats: [...l.beats, beat] } : { runId: id, beats: [beat] })),
			),
		[],
	)
	const beats = useMemo(() => (run ? withLive(run.journey ?? [], live.runId === run.id ? live.beats : []) : []), [run, live])
	const rows = useMemo(() => journeyRows(beats), [beats])

	// Follows the newest step while you are at the bottom; scrolling up to read stops it until you scroll back down.
	const list = useRef<HTMLOListElement>(null)
	const stick = useRef(true)
	useLayoutEffect(() => {
		const el = list.current
		if (el && stick.current) el.scrollTop = el.scrollHeight
	}, [rows.length, run?.id])

	const [height, setHeight] = useState(() => {
		try {
			const v = Number(localStorage.getItem(HEIGHT_KEY))
			return v >= MIN_HEIGHT ? v : DEFAULT_HEIGHT
		} catch {
			return DEFAULT_HEIGHT
		}
	})
	const resize = (e: React.PointerEvent): void => {
		e.preventDefault()
		const y0 = e.clientY
		const h0 = height
		let last = h0
		const move = (ev: PointerEvent): void => {
			last = Math.max(MIN_HEIGHT, Math.min(window.innerHeight * 0.7, h0 + y0 - ev.clientY))
			setHeight(last)
		}
		const up = (): void => {
			window.removeEventListener('pointermove', move)
			window.removeEventListener('pointerup', up)
			document.body.classList.remove('resizing-y')
			try {
				localStorage.setItem(HEIGHT_KEY, String(Math.round(last)))
			} catch {
				// the height just isn't remembered
			}
		}
		document.body.classList.add('resizing-y')
		window.addEventListener('pointermove', move)
		window.addEventListener('pointerup', up)
	}

	const key = keyLabel('runDrawer')
	return (
		<section className="run-drawer" style={{ height }} {...pane('Run')}>
			<div className="run-drawer-grip" onPointerDown={resize} role="separator" aria-orientation="horizontal" aria-label="Resize" />
			<header className="run-drawer-head">
				<h2>Run</h2>
				{run?.status === 'running' && <AiOrb activity="working" size={14} label="Running" />}
				{runs.length > 1 && run && (
					<select className="run-drawer-pick" value={run.id} onChange={(e) => onRunId(e.target.value)} aria-label="Run">
						{[...runs].reverse().map((r) => (
							<option key={r.id} value={r.id}>
								{runName(r)}
							</option>
						))}
					</select>
				)}
				{runs.length === 1 && run && <span className="muted">{runName(run)}</span>}
				<span className="spacer" />
				<button className="btn small ghost" onClick={onClose} title={key ? `Close (${key})` : 'Close'} aria-label="Close">
					✕
				</button>
			</header>
			{!run ? (
				<p className="run-drawer-empty muted">No AI review of this snapshot yet. Start one and you can follow it here.</p>
			) : !beats.length ? (
				<p className="run-drawer-empty muted">
					{run.status === 'running' ? 'Starting…' : 'This run was recorded before Review kept what happened during a run.'}
				</p>
			) : (
				<ol
					className="run-journey"
					ref={list}
					aria-label="What the run did"
					onScroll={(e) => {
						const el = e.currentTarget
						stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
					}}
				>
					{rows.map((row) => (
						<Row key={rowKey(row)} run={run} row={row} onOpen={onOpen} />
					))}
				</ol>
			)}
		</section>
	)
}

function runName(r: AiRun): string {
	const at = new Date(r.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
	return `${r.providerLabel} · ${at}${r.status === 'running' ? ' · running' : ''}`
}

function rowKey(row: JourneyRow): number {
	return row.kind === 'beat' ? row.beat.seq : row.beats[0].seq
}

function Row({ run, row, onOpen }: { run: AiRun; row: JourneyRow; onOpen: (path: string, line: number | null) => void }) {
	const first = row.kind === 'beat' ? row.beat : row.beats[0]
	const who = memberLabel(run, first.memberId)
	const slot = memberSlot(run, first.memberId)
	const chip = who && (
		<span className="run-member" data-slot={slot ?? undefined}>
			{who}
		</span>
	)
	const time = <span className="run-time">{elapsed(run, first.at)}</span>
	const place = (path: string | null, line: number | null) =>
		path && (
			<button className="run-place mono" onClick={() => onOpen(path, line)}>
				{path}
				{line !== null ? `:${line}` : ''}
			</button>
		)

	if (row.kind === 'lookups')
		return (
			<li className="run-beat is-lookups">
				<span className="run-glyph" aria-hidden>
					·
				</span>
				{chip}
				{row.beats.length === 1 ? (
					<span className="run-text">{lookupSummary(row.beats)}</span>
				) : (
					<details className="run-text">
						<summary>{lookupSummary(row.beats)}</summary>
						<ul>
							{row.beats.map((b) => (
								<li key={b.seq}>{lookupText(b)}</li>
							))}
						</ul>
					</details>
				)}
				{time}
			</li>
		)

	const b = row.beat
	switch (b.kind) {
		case 'stage':
			return (
				<li className={`run-beat is-stage stage-${b.stage}`}>
					<span className="run-glyph" aria-hidden>
						◉
					</span>
					<span className="run-text">{b.text}</span>
					{time}
				</li>
			)
		case 'request':
			return (
				<li className={`run-beat is-request${b.error ? ' tone-unsettled' : ''}`}>
					<span className="run-glyph" aria-hidden>
						{b.error ? '○' : '◆'}
					</span>
					{chip}
					<span className="run-text">
						{b.error
							? `Request ${b.index + 1} of ${b.total} failed: ${b.error}`
							: `Answered request ${b.index + 1} of ${b.total}${b.findings ? ` · ${b.findings} new finding${b.findings === 1 ? '' : 's'}` : ' · nothing new'}`}
					</span>
					{time}
				</li>
			)
		case 'finding':
			return (
				<li className={`run-beat is-finding tone-${b.tone}`}>
					<span className="run-glyph" title={TONE_LABEL[b.tone]}>
						{TONE_GLYPH[b.tone]}
					</span>
					{chip}
					<span className="run-text">
						Raised <strong>{b.title}</strong> {place(b.path, b.line)}
					</span>
					{time}
				</li>
			)
		case 'verdict':
			return (
				<li className={`run-beat is-verdict tone-${b.tone}`}>
					<span className="run-glyph" title={TONE_LABEL[b.tone]}>
						{TONE_GLYPH[b.tone]}
					</span>
					{chip}
					<span className="run-text">
						{b.of === 'finding' ? 'Double-checked' : b.of === 'near-miss' ? 'Challenged near miss' : 'Checked bot thread'}{' '}
						<strong>{b.title}</strong> {place(b.path, b.line)}
						<span className="run-reason">
							{TONE_LABEL[b.tone]}: {b.reason}
						</span>
					</span>
					{time}
				</li>
			)
		default:
			return (
				<li className="run-beat">
					<span className="run-text">{lookupText(b)}</span>
					{time}
				</li>
			)
	}
}
