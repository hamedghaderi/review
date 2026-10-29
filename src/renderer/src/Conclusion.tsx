import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { ChangeConclusion } from '../../shared/types.ts'
import { AiOrb } from './AiOrb.tsx'
import { ago } from './branches.ts'
import { Markdown } from './Markdown.tsx'

interface Props {
	conclusion: ChangeConclusion | null
	busy: 'writing' | 'asking' | null // what the AI is doing for this review; nothing can be sent meanwhile
	asked: string | null // the question being answered, shown until the answer is saved
	error: string | null
	disabled: string | null // why it can't be written now (no model for questions, no finished run…)
	askDisabled: string | null // why nothing can be asked now (no model for questions…)
	stale: boolean // a newer run finished after this conclusion was written
	modelPicker: ReactNode
	paths: ReadonlySet<string> // the changed files' paths, which open from the text
	onOpenPath(path: string): void
	onWrite(): void
	onAsk(question: string): Promise<boolean> // false: not sent, so the box keeps the text
	onHide(): void
}

/**
 * The AI's conclusion on the whole change, shown where the code is, and the conversation about it. Its text is the
 * model's Markdown; it reads the code but can still be wrong.
 */
export function Conclusion({
	conclusion: c,
	busy,
	asked,
	error,
	disabled,
	askDisabled,
	stale,
	modelPicker,
	paths,
	onOpenPath,
	onWrite,
	onAsk,
	onHide,
}: Props) {
	const [text, setText] = useState('')
	const end = useRef<HTMLDivElement>(null)
	const [first, ...rest] = c?.messages ?? []
	const count = rest.length + (asked ? 1 : 0)
	useEffect(() => {
		if (count) end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
	}, [count, busy])
	const send = async (): Promise<void> => {
		const q = text.trim()
		if (!q || busy || askDisabled) return
		setText('')
		if (!(await onAsk(q))) setText(q)
	}
	const write = (): void => {
		if (busy) return
		if (rest.length && !window.confirm('Write the conclusion again? This conversation will be replaced.')) return
		onWrite()
	}
	return (
		<section className="conclusion">
			<div className="conclusion-head">
				<b>Conclusion</b>
				{first && (
					<span className="muted small nowrap" title={new Date(first.at).toLocaleString()}>
						{first.model} · {ago(first.at)}
					</span>
				)}
				<span className="spacer" />
				{c && (
					<button
						className="btn small"
						onClick={write}
						disabled={!!busy || !!disabled}
						title={disabled ?? 'Read the change and the findings again'}
					>
						Write again
					</button>
				)}
				<button className="btn small ghost" onClick={onHide} title="Back to the code">
					Hide
				</button>
			</div>
			<div className="conclusion-scroll">
				<div className="conclusion-body">
					{busy === 'writing' ? (
						<p className="muted conclusion-wait">
							<AiOrb activity="reasoning" size={14} /> Reading the whole change and the findings…
						</p>
					) : first ? (
						<>
							{stale && (
								<p className="small conclusion-note">
									A newer review run has finished since this was written. Write it again to include its findings.
								</p>
							)}
							{first.error ? (
								<p className="error-text selectable">{first.text}</p>
							) : (
								<Markdown text={first.text} paths={paths} onOpenPath={onOpenPath} />
							)}
							{c && c.omitted.length > 0 && (
								<p className="small muted">
									{c.omitted.length} diff{c.omitted.length === 1 ? ' was' : 's were'} too big to send in full; the AI could read{' '}
									{c.omitted.length === 1 ? 'it' : 'them'} with lookups.
								</p>
							)}
						</>
					) : (
						<div className="conclusion-empty">
							<p>
								<b>Step back and look at the whole change.</b>
							</p>
							<p className="muted">
								The AI reads the change and the review’s findings, then says what the change does, whether the approach was a good one, what
								the findings add up to, and what to follow up. You can keep asking about it.
							</p>
							<button className="btn primary" onClick={write} disabled={!!busy || !!disabled} title={disabled ?? undefined}>
								Write the conclusion
							</button>
							{disabled && <p className="small muted">{disabled}</p>}
						</div>
					)}
					{busy !== 'writing' &&
						rest.map((m) =>
							m.role === 'you' ? (
								<div key={m.id} className="conclusion-q selectable">
									{m.text}
								</div>
							) : m.error ? (
								<p key={m.id} className="error-text small selectable">
									{m.text}
								</p>
							) : (
								<div key={m.id} className="conclusion-a">
									<Markdown text={m.text} paths={paths} onOpenPath={onOpenPath} />
									<span className="muted small">{m.model}</span>
								</div>
							),
						)}
					{asked && (
						<>
							<div className="conclusion-q selectable">{asked}</div>
							<p className="muted small conclusion-wait">
								<AiOrb activity="reasoning" size={12} /> Reading the code…
							</p>
						</>
					)}
					{error && <p className="small error-text selectable">{error}</p>}
					<div ref={end} />
				</div>
			</div>
			{first && !first.error && busy !== 'writing' && (
				<div className="ask-box conclusion-ask">
					<textarea
						value={text}
						rows={2}
						placeholder="Ask about the conclusion, e.g. “Would the event approach really be simpler here?”"
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
								e.preventDefault()
								void send()
							}
						}}
					/>
					<div className="ask-actions">
						<span className="muted small">The AI can read any file in the change · ⌘↵ to send</span>
						<span className="spacer" />
						{modelPicker}
						<button
							className="btn small primary"
							onClick={() => void send()}
							disabled={!text.trim() || !!busy || !!askDisabled}
							title={askDisabled ?? undefined}
						>
							{busy === 'asking' ? 'Asking…' : 'Ask'}
						</button>
					</div>
				</div>
			)}
		</section>
	)
}
