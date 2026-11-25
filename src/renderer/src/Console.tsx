import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { formatCost, formatCostRange } from '../../shared/cost.ts'
import { findingRoots, findingState, LEVEL_META } from '../../shared/findings.ts'
import type { AiRun, Finding, Review, ReviewEvent, RunEstimate, RunStage } from '../../shared/types.ts'
import { BlockMark } from './BlockMark.tsx'
import { COMMANDS, parseCommand, suggest, type Command } from './consoleCommands.ts'
import { journeyTally, TONE_GLYPH, TONE_LABEL } from './journeyView.ts'
import { Markdown } from './Markdown.tsx'

/** What the Console can do, each through the same code as the app's own buttons. A string back says why it could not. */
export interface ConsoleActions {
	review(scope: 'all' | 'changed'): Promise<{ run: AiRun } | { error: string }>
	estimate(scope: 'all' | 'changed'): Promise<RunEstimate | null>
	stop(): string | null
	conclude(question: string | null): Promise<{ text: string } | { error: string }>
	openFile(path: string, line: number | null): void
	openFinding(f: Finding): void
	showRun(runId: string): void
	submit(event: ReviewEvent | null): string | null
	resolve(): string | null
}

type Block = { id: number; line: string } & (
	| { kind: 'text'; text: string; error?: boolean }
	| { kind: 'help' }
	| { kind: 'findings'; filter: Extract<Command, { name: 'findings' }>['filter'] }
	| { kind: 'runs' }
	| { kind: 'review'; runId: string }
	| { kind: 'answer'; pending: boolean; text: string | null; error: string | null }
)

type NewBlock = { [K in Block['kind']]: Omit<Extract<Block, { kind: K }>, 'id'> }[Block['kind']]

// Kept for the app session, per review, so closing the drawer or switching tabs does not lose them.
const blocksByReview = new Map<string, Array<Block>>()
const typed: Array<string> = [] // lines you ran, newest last, for ↑ and ↓
let nextId = 1

const STAGE_LABEL: Record<RunStage, string> = {
	sources: 'read',
	background: 'background',
	packed: 'packed',
	'near-misses': 'near misses',
	grouping: 'grouped',
	'double-check': 'double-check',
	'bot-threads': 'bot threads',
	finished: 'done',
	'late-finished': 'late done',
}

/**
 * The Console tab of the Run drawer (issue #299): Review's actions as commands, Warp-style, with each command and what
 * it did kept as a block. It is not a shell, and it never runs the code under review.
 */
export function Console({
	reviewId,
	runs,
	review,
	reviewer,
	askModel,
	actions,
}: {
	reviewId: string
	runs: ReadonlyArray<AiRun>
	review: Review
	reviewer: string | null
	askModel: string | null
	actions: ConsoleActions
}) {
	const [blocks, setBlocksState] = useState<Array<Block>>(() => blocksByReview.get(reviewId) ?? [])
	useEffect(() => setBlocksState(blocksByReview.get(reviewId) ?? []), [reviewId])
	const setBlocks = (f: (b: Array<Block>) => Array<Block>): void =>
		setBlocksState((b) => {
			const next = f(b)
			blocksByReview.set(reviewId, next)
			return next
		})
	const [input, setInput] = useState('')
	const [back, setBack] = useState<number | null>(null) // place in `typed` while stepping with ↑ and ↓
	const hint = suggest(input, askModel)

	// What a review would cost, from the same estimate the run dialog shows.
	const [estimate, setEstimate] = useState<{ scope: string; text: string } | null>(null)
	const parsed = hint ? parseCommand(hint.run) : null
	const reviewScope = parsed?.ok && parsed.command.name === 'review' ? parsed.command.scope : null
	useEffect(() => {
		if (!reviewScope || estimate?.scope === reviewScope) return
		let live = true
		void actions.estimate(reviewScope).then((e) => {
			if (!live || !e) return
			const cost = e.cost && !e.cost.unpriced ? `about ${formatCostRange(e.cost.low, e.cost.high)}` : 'cost unknown'
			setEstimate({ scope: reviewScope, text: `${e.requests} request${e.requests === 1 ? '' : 's'}, ${cost}` })
		})
		return () => {
			live = false
		}
	}, [reviewScope]) // eslint-disable-line react-hooks/exhaustive-deps

	const list = useRef<HTMLDivElement>(null)
	useLayoutEffect(() => {
		if (list.current) list.current.scrollTop = list.current.scrollHeight
	}, [blocks.length])

	const add = (b: NewBlock): number => {
		const id = nextId++
		setBlocks((xs) => [...xs, { ...b, id }])
		return id
	}
	const say = (line: string, text: string, error = false): void => void add({ kind: 'text', line, text, error })

	const execute = async (line: string): Promise<void> => {
		const p = parseCommand(line)
		if (!p) return
		typed.push(line)
		setBack(null)
		setInput('')
		if (!p.ok) return say(line, p.error, true)
		const c = p.command
		switch (c.name) {
			case 'help':
				return void add({ kind: 'help', line })
			case 'clear':
				return setBlocks(() => [])
			case 'findings':
				return void add({ kind: 'findings', line, filter: c.filter })
			case 'runs':
				return void add({ kind: 'runs', line })
			case 'open':
				actions.openFile(c.path, c.line)
				return say(line, `Opened ${c.path}${c.line ? `:${c.line}` : ''}.`)
			case 'stop': {
				const why = actions.stop()
				return say(line, why ?? 'Stopping the run. Answers that already arrived are kept.', !!why)
			}
			case 'submit': {
				const why = actions.submit(c.event)
				return say(line, why ?? 'Opened the submit dialog. Nothing is sent until you submit there.', !!why)
			}
			case 'resolve': {
				const why = actions.resolve()
				return say(line, why ?? 'Opened your threads the run found fixed. Nothing is resolved until you say so there.', !!why)
			}
			case 'review': {
				const r = await actions.review(c.scope)
				if ('error' in r) return say(line, r.error, true)
				return void add({ kind: 'review', line, runId: r.run.id })
			}
			case 'ask':
			case 'conclude': {
				const id = add({ kind: 'answer', line, pending: true, text: null, error: null })
				const r = await actions.conclude(c.name === 'ask' ? c.question : null)
				setBlocks((xs) =>
					xs.map((b) =>
						b.id === id && b.kind === 'answer'
							? { ...b, pending: false, text: 'text' in r ? r.text : null, error: 'error' in r ? r.error : null }
							: b,
					),
				)
			}
		}
	}

	const onKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
		if (e.key === 'Enter') {
			e.preventDefault()
			if (hint) void execute(hint.run.trim())
		} else if (e.key === 'Tab' && !e.shiftKey && hint && hint.run !== input) {
			e.preventDefault()
			setInput(hint.run)
		} else if (e.key === 'ArrowUp' && typed.length) {
			e.preventDefault()
			const i = back === null ? typed.length - 1 : Math.max(0, back - 1)
			setBack(i)
			setInput(typed[i])
		} else if (e.key === 'ArrowDown' && back !== null) {
			e.preventDefault()
			const i = back + 1
			setBack(i < typed.length ? i : null)
			setInput(i < typed.length ? typed[i] : '')
		} else if (e.key === 'Escape' && input) {
			e.preventDefault()
			setInput('')
		}
	}

	const ghost = hint && hint.run.startsWith(input) && hint.run !== input ? hint.run.slice(input.length) : ''
	// A review says who reviews and what it would cost before you press Enter.
	const hintText = reviewScope
		? `${reviewScope === 'all' ? 'Review every file' : 'Review the files changed since the last run'}${reviewer ? ` with ${reviewer}` : ''}${estimate?.scope === reviewScope ? ` · ${estimate.text}` : ''}`
		: (hint?.hint ?? '')
	return (
		<div className="console">
			<div className="console-blocks" ref={list} aria-live="polite">
				{!blocks.length && (
					<p className="muted console-empty">Type a command, or “help”. Plain words become a question about the change.</p>
				)}
				{blocks.map((b) => (
					<section key={b.id} className="console-block">
						<div className="console-line mono">
							<span className="console-prompt" aria-hidden>
								❯
							</span>{' '}
							{b.line}
						</div>
						<BlockBody block={b} runs={runs} review={review} actions={actions} />
					</section>
				))}
			</div>
			<div className="console-input">
				<span className="console-prompt mono" aria-hidden>
					❯
				</span>
				<span className="console-field mono">
					<span className="console-ghost" aria-hidden>
						<span className="console-typed">{input}</span>
						{ghost}
					</span>
					<input
						value={input}
						onChange={(e) => {
							setInput(e.target.value)
							setBack(null)
						}}
						onKeyDown={onKey}
						spellCheck={false}
						autoComplete="off"
						aria-label="Command"
						aria-describedby="console-hint"
						placeholder={input ? undefined : 'review, findings, ask …'}
					/>
				</span>
			</div>
			<div id="console-hint" className={`console-hint${hint?.ai ? ' ai' : ''}`}>
				{hint ? (
					<>
						<kbd>↵</kbd> <span className="mono">{hint.run.trim()}</span> · {hintText}
						{ghost && (
							<>
								{' '}
								· <kbd>Tab</kbd> to fill in
							</>
						)}
					</>
				) : (
					' '
				)}
			</div>
		</div>
	)
}

function BlockBody({
	block,
	runs,
	review,
	actions,
}: {
	block: Block
	runs: ReadonlyArray<AiRun>
	review: Review
	actions: ConsoleActions
}) {
	switch (block.kind) {
		case 'text':
			return <p className={`console-out${block.error ? ' error' : ''}`}>{block.text}</p>
		case 'help':
			return (
				<table className="console-out console-help">
					<tbody>
						{COMMANDS.map((c) => (
							<tr key={c.name}>
								<td className="mono">{c.usage}</td>
								<td>
									{c.about}
									{c.ai ? ' · asks a model' : ''}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)
		case 'runs':
			return runs.length ? (
				<ul className="console-out console-list">
					{[...runs].reverse().map((r) => (
						<li key={r.id}>
							<button className="link" onClick={() => actions.showRun(r.id)}>
								{new Date(r.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
							</button>{' '}
							{r.providerLabel} · {r.status} · {r.findings.filter((f) => !f.mergedInto && !f.heldBack).length} findings
							{r.cost ? ` · ${formatCost(r.cost)}` : ''}
						</li>
					))}
				</ul>
			) : (
				<p className="console-out muted">No AI runs on this snapshot yet. “review” starts one.</p>
			)
		case 'findings':
			return <FindingsOut filter={block.filter} runs={runs} review={review} onOpen={actions.openFinding} />
		case 'review': {
			const run = runs.find((r) => r.id === block.runId)
			return run ? <MiniTrail run={run} onShow={() => actions.showRun(run.id)} /> : <p className="console-out muted">Starting…</p>
		}
		case 'answer':
			return block.pending ? (
				<p className="console-out muted">
					<BlockMark activity="reasoning" size={12} /> Reading the change…
				</p>
			) : block.error ? (
				<p className="console-out error">{block.error}</p>
			) : (
				<div className="console-out">
					<Markdown text={block.text ?? ''} />
				</div>
			)
	}
}

function FindingsOut({
	filter,
	runs,
	review,
	onOpen,
}: {
	filter: Extract<Command, { name: 'findings' }>['filter']
	runs: ReadonlyArray<AiRun>
	review: Review
	onOpen: (f: Finding) => void
}) {
	const run = [...runs].reverse().find((r) => r.status !== 'running') ?? runs.at(-1)
	const all = useMemo(() => [...runs], [runs])
	const roots = useMemo(() => findingRoots(all), [all])
	const byId = useMemo(() => new Map(all.flatMap((r) => r.findings.map((f) => [f.id, f] as const))), [all])
	if (!run) return <p className="console-out muted">No AI run yet. “review” starts one.</p>
	const rows = run.findings
		.filter((f) => !f.mergedInto && !f.heldBack)
		.map((f) => ({ f, state: findingState(review, roots, f, byId) }))
		.filter(({ f, state }) => (filter === 'all' ? true : filter === 'open' ? state === 'open' : f.severity === filter))
	if (!rows.length) return <p className="console-out muted">{filter === 'open' ? 'No open findings.' : 'No findings like that.'}</p>
	return (
		<ul className="console-out console-list">
			{rows.map(({ f, state }) => (
				<li key={f.id}>
					<span title={LEVEL_META[f.severity].label}>{LEVEL_META[f.severity].emoji}</span>{' '}
					<button className="link" onClick={() => onOpen(f)}>
						{f.title}
					</button>{' '}
					<span className="mono muted">
						{(f.anchor.side === 'old' ? f.anchor.oldPath : f.anchor.newPath) ?? f.anchor.fileKey}
						{f.anchor.startLine ? `:${f.anchor.startLine}` : ''}
					</span>
					{state !== 'open' && <span className="muted"> · {state}</span>}
				</li>
			))}
		</ul>
	)
}

/** A run started from the Console, as it goes: the stages it has passed, and how its findings stand. */
function MiniTrail({ run, onShow }: { run: AiRun; onShow: () => void }) {
	const beats = run.journey ?? []
	const stages = beats.flatMap((b) => (b.kind === 'stage' ? [b.stage] : []))
	const tally = journeyTally(beats)
	return (
		<div className="console-out console-trail">
			{run.status === 'running' && <BlockMark activity="working" size={12} label="Running" />}
			<span className="console-stages">
				{stages.map((s, i) => (
					<span key={i}>
						{i > 0 && <span className="console-dash" aria-hidden />}
						<span className="console-stage">{STAGE_LABEL[s]}</span>
					</span>
				))}
				{run.status === 'running' && <span className="console-dash pending" aria-hidden />}
			</span>
			{(['confirmed', 'concern', 'cleared', 'pending', 'unsettled'] as const)
				.filter((t) => tally[t])
				.map((t) => (
					<span key={t} className={`console-tone tone-${t}`} title={TONE_LABEL[t]}>
						{TONE_GLYPH[t]} {tally[t]}
					</span>
				))}
			<span className="muted">{run.status === 'running' ? `${run.providerLabel} reviewing` : `${run.providerLabel} · ${run.status}`}</span>
			<button className="link" onClick={onShow}>
				Show in Run
			</button>
		</div>
	)
}
