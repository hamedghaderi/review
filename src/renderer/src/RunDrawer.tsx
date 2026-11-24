import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AiRun, BeatTone, RunBeat } from '../../shared/types.ts'
import { AiOrb } from './AiOrb.tsx'
import { announce } from './announce.ts'
import { keyLabel } from './keymap.ts'
import {
	elapsed,
	journeyRows,
	journeyTally,
	lookupSummary,
	lookupText,
	memberLabel,
	memberSlot,
	TONE_GLYPH,
	TONE_LABEL,
	trailLayout,
	withLive,
	type JourneyRow,
	type TrailItem,
	type TrailLine,
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
 * The drawer under the review (issue #299): what a review run did, as a trail. The run's spine splits into a strand per
 * reviewer once its requests are packed, findings and verdicts settle on them as they happen, and the strands join
 * again at the double-check. Only what the app saw: stages, the files and searches the reviewers asked for, their
 * answers, and the checks' verdicts. A finished run can be replayed.
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
			window.review.onAiRunBeat((id, beat) => {
				setLive((l) => (l.runId === id ? { runId: id, beats: [...l.beats, beat] } : { runId: id, beats: [beat] }))
				// A verdict is the moment worth hearing; the rest is on screen.
				if (beat.kind === 'verdict') announce(`${TONE_LABEL[beat.tone]}: ${beat.title}`, 'progress')
			}),
		[],
	)
	const beats = useMemo(() => (run ? withLive(run.journey ?? [], live.runId === run.id ? live.beats : []) : []), [run, live])

	// Replaying a finished run shows its steps again one by one, with the gaps between them shortened.
	const [replay, setReplay] = useState<{ runId: string; shown: number; speed: 1 | 4 } | null>(null)
	const playing = replay && run && replay.runId === run.id ? replay : null
	useEffect(() => {
		if (!playing) return
		if (playing.shown >= beats.length) return setReplay(null)
		const gap = playing.shown ? beats[playing.shown].at - beats[playing.shown - 1].at : 0
		const wait = Math.min(900, Math.max(150, gap)) / playing.speed
		const t = window.setTimeout(() => setReplay((r) => r && { ...r, shown: r.shown + 1 }), wait)
		return () => window.clearTimeout(t)
	}, [playing, beats])
	const shown = playing ? beats.slice(0, playing.shown) : beats

	const rows = useMemo(() => journeyRows(shown), [shown])
	const trail = useMemo(() => (run ? trailLayout(run, rows) : { items: [], lanes: 0 }), [run, rows])
	const tally = useMemo(() => journeyTally(shown), [shown])

	// Steps that arrive while the drawer is open come in with a little motion; what was already there does not.
	const seen = useRef<{ runId: string | null; seq: number }>({ runId: null, seq: -1 })
	if (run && seen.current.runId !== run.id) seen.current = { runId: run.id, seq: beats.at(-1)?.seq ?? -1 }

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

	const startReplay = (): void => {
		if (!run) return
		seen.current = { runId: run.id, seq: -1 }
		stick.current = true
		setReplay({ runId: run.id, shown: 1, speed: 1 })
	}
	const key = keyLabel('runDrawer')
	const width = railWidth(trail.lanes)
	const lastRow = [...trail.items].reverse().find((x) => x.kind === 'row')
	const tip = run?.status === 'running' || playing ? lastRow : null
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
				<Tally tally={tally} />
				<span className="spacer" />
				{run && run.status !== 'running' && beats.length > 1 && !playing && (
					<button className="btn small ghost" onClick={startReplay} title="Play this run's steps again">
						▶ Replay
					</button>
				)}
				{playing && (
					<>
						<button
							className="btn small ghost"
							onClick={() => setReplay((r) => r && { ...r, speed: r.speed === 1 ? 4 : 1 })}
							title="Replay speed"
							aria-label={`Replay speed ${playing.speed}×`}
						>
							{playing.speed}×
						</button>
						<button className="btn small ghost" onClick={() => setReplay(null)} title="Show every step now">
							Skip to end
						</button>
					</>
				)}
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
					{trail.items.map((item, i) =>
						item.kind === 'row' ? (
							<Row
								key={rowKey(item.row)}
								run={run}
								item={item}
								width={width}
								fresh={rowKey(item.row) > seen.current.seq}
								tip={item === tip}
								onOpen={onOpen}
							/>
						) : (
							<Link key={`${item.kind}-${i}`} item={item} width={width} run={run} />
						),
					)}
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

const TALLY_ORDER: Array<BeatTone> = ['confirmed', 'concern', 'cleared', 'pending', 'unsettled']

/** How the findings and checks stand so far: ✗ 1 ⚠ 2 ✓ 1. */
function Tally({ tally }: { tally: Record<BeatTone, number> }) {
	const shown = TALLY_ORDER.filter((t) => tally[t] > 0)
	if (!shown.length) return null
	return (
		<span className="run-tally">
			{shown.map((t) => (
				<span key={t} className={`tone-${t}`} title={TONE_LABEL[t]}>
					<span aria-hidden>{TONE_GLYPH[t]}</span>
					<span className="sr-only">{TONE_LABEL[t]}:</span> {tally[t]}
				</span>
			))}
		</span>
	)
}

// The trail's geometry, in pixels: the spine's place, the room per strand, and how far down a row its node sits.
const SPINE_X = 11
const LANE_W = 15
const NODE_Y = 11
const LINK_H = 12

const laneX = (lane: number): number => SPINE_X + lane * LANE_W
const railWidth = (lanes: number): number => laneX(lanes) + 11

function slotOf(run: AiRun, lane: number): number | undefined {
	const m = lane ? run.team?.members[lane - 1] : undefined
	return m ? (memberSlot(run, m.id) ?? undefined) : undefined
}

/** Where the strands split from the spine, or join it again. */
function Link({ item, width, run }: { item: Exclude<TrailItem, { kind: 'row' }>; width: number; run: AiRun }) {
	const mid = LINK_H / 2
	const curve = (from: number, to: number): string => `M${from} 0 C${from} ${mid} ${to} ${mid} ${to} ${LINK_H}`
	return (
		<li className={`run-link ${item.kind}`} aria-hidden>
			<svg width={width} height={LINK_H} viewBox={`0 0 ${width} ${LINK_H}`}>
				{item.lanes.map((l) => (
					<path key={l} data-slot={slotOf(run, l)} d={item.kind === 'fork' ? curve(laneX(0), laneX(l)) : curve(laneX(l), laneX(0))} />
				))}
				{item.kind === 'merge' &&
					item.through.map((l) => <path key={`t${l}`} data-slot={slotOf(run, l)} d={`M${laneX(l)} 0 L${laneX(l)} ${LINK_H}`} />)}
			</svg>
		</li>
	)
}

/** The trail beside one row: the strands passing through it, and its own node. */
function Rail({
	run,
	lines,
	lane,
	width,
	node,
}: {
	run: AiRun
	lines: Array<TrailLine>
	lane: number
	width: number
	node: { kind: string; tone?: BeatTone; glyph?: string; label?: string }
}) {
	return (
		<span className="run-rail" style={{ width }} aria-hidden>
			{lines.map((l) =>
				l.top || l.bottom ? (
					<i
						key={l.lane}
						className="run-strand"
						data-slot={slotOf(run, l.lane)}
						style={{
							left: laneX(l.lane),
							top: l.top ? 0 : NODE_Y,
							...(l.bottom ? { bottom: 0 } : { height: NODE_Y }),
						}}
					/>
				) : null,
			)}
			<i
				className={`run-node node-${node.kind}${node.tone ? ` tone-${node.tone}` : ''}`}
				data-slot={slotOf(run, lane)}
				style={{ left: laneX(lane), top: NODE_Y }}
				title={node.label}
			>
				{node.glyph}
			</i>
		</span>
	)
}

function Row({
	run,
	item,
	width,
	fresh,
	tip,
	onOpen,
}: {
	run: AiRun
	item: Extract<TrailItem, { kind: 'row' }>
	width: number
	fresh: boolean
	tip: boolean
	onOpen: (path: string, line: number | null) => void
}) {
	const row = item.row
	const first = row.kind === 'beat' ? row.beat : row.beats[0]
	const who = memberLabel(run, first.memberId)
	const chip = who && (
		<span className="run-member" data-slot={memberSlot(run, first.memberId) ?? undefined}>
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
	const li = (kind: string, node: Parameters<typeof Rail>[0]['node'], content: React.ReactNode, tone?: BeatTone) => (
		<li className={`run-beat is-${kind}${tone ? ` tone-${tone}` : ''}${fresh ? ' fresh' : ''}${tip ? ' tip' : ''}`}>
			<Rail run={run} lines={item.lines} lane={item.lane} width={width} node={node} />
			{chip}
			{content}
			{time}
		</li>
	)
	const said = (tone: BeatTone) => <span className="sr-only">{TONE_LABEL[tone]}: </span>

	if (row.kind === 'lookups')
		return li(
			'lookups',
			{ kind: 'look' },
			row.beats.length === 1 ? (
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
			),
		)

	const b = row.beat
	switch (b.kind) {
		case 'stage': {
			const end = b.stage === 'finished' || b.stage === 'late-finished'
			return li('stage', { kind: end ? 'end' : 'stage', glyph: end ? '★' : undefined }, <span className="run-text">{b.text}</span>)
		}
		case 'request':
			return li(
				'request',
				{ kind: b.error ? 'fail' : 'req' },
				<span className="run-text">
					{b.error
						? `Request ${b.index + 1} of ${b.total} failed: ${b.error}`
						: `Answered request ${b.index + 1} of ${b.total}${b.findings ? ` · ${b.findings} new finding${b.findings === 1 ? '' : 's'}` : ' · nothing new'}`}
				</span>,
				b.error ? 'unsettled' : undefined,
			)
		case 'finding':
			return li(
				'finding',
				{ kind: 'mark', tone: b.tone, glyph: TONE_GLYPH[b.tone], label: TONE_LABEL[b.tone] },
				<span className="run-text">
					{said(b.tone)}Raised <strong>{b.title}</strong> {place(b.path, b.line)}
				</span>,
				b.tone,
			)
		case 'verdict':
			return li(
				'verdict',
				{ kind: 'verdict', tone: b.tone, glyph: TONE_GLYPH[b.tone], label: TONE_LABEL[b.tone] },
				<span className="run-text">
					{said(b.tone)}
					{b.of === 'finding' ? 'Double-checked' : b.of === 'near-miss' ? 'Challenged near miss' : 'Checked bot thread'}{' '}
					<strong>{b.title}</strong> {place(b.path, b.line)}
					<span className="run-reason">{b.reason}</span>
				</span>,
				b.tone,
			)
		default:
			return li('lookups', { kind: 'look' }, <span className="run-text">{lookupText(b)}</span>)
	}
}
