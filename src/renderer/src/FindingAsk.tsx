import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Finding, FindingMessage } from '../../shared/types.ts'
import { LEVEL_META } from '../../shared/findings.ts'
import { BlockMark } from './BlockMark.tsx'
import { scrollBehavior } from './motion.ts'
import { speakable, speaker, useAnnounceNew, useAnnounceWait } from './announce.ts'
import { AnswerText } from './CodeText.tsx'
import { SpeakerHeading } from './SpeakerHeading.tsx'
import { tabKey } from './tabKey.ts'

// Questions about an AI finding: the conversation so far and the box to ask the next one. Shown on the finding in the
// Findings tab, and inside a comment made from it.

const VERDICT_TEXT: Record<'holds' | 'wrong' | 'unsure', { label: string; hint: string }> = {
	holds: { label: 'Still holds', hint: 'The model still thinks the finding is right' },
	wrong: { label: 'Finding is wrong', hint: 'The model agrees it is not a problem. You can dismiss it, or delete its comment.' },
	unsure: { label: 'Unsure', hint: 'The supplied code was not enough to settle it' },
}

export function FindingThread({ messages, pending, path }: { messages: Array<FindingMessage>; pending: boolean; path: string | null }) {
	useAnnounceWait(pending, 'Reading the code…')
	useAnnounceNew(
		messages,
		(m) => m.id,
		(m) =>
			m.role === 'you'
				? null
				: m.error
					? `The AI couldn’t answer: ${m.text}`
					: `${m.model ?? 'The AI'} answered${m.verdict ? `, ${VERDICT_TEXT[m.verdict].label.toLowerCase()}` : ''}: ${speakable(m.text)}`,
	)
	return (
		<div className="finding-thread">
			{messages.map((m) => (
				<article key={m.id} className={`thread-msg ${m.role}${m.error ? ' error' : ''}`}>
					<SpeakerHeading>
						{speaker(
							m,
							[
								m.verdict && VERDICT_TEXT[m.verdict].label.toLowerCase(),
								m.verdict !== 'wrong' && m.level && LEVEL_META[m.level].label.toLowerCase(),
							]
								.filter(Boolean)
								.join(', '),
						)}
					</SpeakerHeading>
					{m.role === 'ai' && (
						<div className="thread-meta" aria-hidden>
							<span>{m.model ?? 'AI'}</span>
							{m.verdict && (
								<span className={`verdict ${m.verdict}`} title={VERDICT_TEXT[m.verdict].hint}>
									{VERDICT_TEXT[m.verdict].label}
								</span>
							)}
							{m.verdict !== 'wrong' && m.level && (
								<span title="The level the model would give the finding now">
									{LEVEL_META[m.level].emoji} {LEVEL_META[m.level].label}
								</span>
							)}
						</div>
					)}
					<AnswerText text={m.text} path={path} />
				</article>
			))}
			{pending && messages[messages.length - 1]?.role !== 'you' && <div className="thread-msg you muted">Sending…</div>}
			{pending && (
				<div className="thread-msg ai muted">
					<BlockMark activity="reasoning" size={14} /> Reading the code…
				</div>
			)}
		</div>
	)
}

interface AskProps {
	focus: number | null
	disabled: string | null
	onBusy(busy: boolean): void
	onAsk(question: string): Promise<string | null>
	modelPicker: ReactNode
	onEscape?(): void // Esc in an empty box; without it the box folds back to its button
}

export function AskBox({ focus, disabled, onBusy, onAsk, modelPicker, onEscape }: AskProps) {
	const [open, setOpen] = useState(focus !== null)
	const [text, setText] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const ref = useRef<HTMLTextAreaElement>(null)
	useEffect(() => {
		if (focus === null) return
		setOpen(true)
		requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }))
	}, [focus])
	const send = async (): Promise<void> => {
		const q = text.trim()
		if (!q || busy) return
		setBusy(true)
		onBusy(true)
		setError(null)
		const problem = await onAsk(q)
		setBusy(false)
		onBusy(false)
		if (problem) setError(problem)
		else setText('')
		// The box was disabled while waiting, which drops focus; give it back for the next question (or Esc).
		requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }))
	}
	if (!open)
		return (
			<div className="ask-box">
				<button
					className="btn small ghost"
					onClick={() => setOpen(true)}
					disabled={!!disabled}
					title={disabled ?? 'Ask the model that raised this finding'}
				>
					Ask AI about this finding
				</button>
			</div>
		)
	return (
		<div className="ask-box">
			<textarea
				ref={ref}
				value={text}
				rows={2}
				placeholder="Ask about this finding, e.g. “This component is never unmounted. Does the problem still apply?”"
				disabled={busy}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (tabKey(e)) return
					if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
						e.preventDefault()
						void send()
					} else if (e.key === 'Escape' && !text) {
						e.preventDefault()
						if (onEscape) onEscape()
						else setOpen(false)
					}
				}}
			/>
			{error && <p className="small error-text">{error}</p>}
			<div className="ask-actions">
				<span className="muted small">With the code around it · ⌘↵ to send</span>
				<span className="spacer" />
				{modelPicker}
				<button
					className="btn small primary"
					onClick={() => void send()}
					disabled={!text.trim() || busy || !!disabled}
					title={disabled ?? undefined}
				>
					{busy ? 'Asking…' : 'Ask'}
				</button>
			</div>
		</div>
	)
}

interface SectionProps {
	finding: Finding
	focus: number // changes each time Ask AI is clicked, to focus the box again
	disabled: string | null
	modelPicker: ReactNode
	onAsk(question: string): Promise<string | null>
	onClose(): void
	onShowFinding?(): void
}

/**
 * Ask AI inside a comment made from a finding: the finding's conversation and the question box, under the comment in
 * the same card. It is set apart (dashed, its own heading) because none of it is part of the comment or ever posted.
 */
export function FindingAskSection({ finding: f, focus, disabled, modelPicker, onAsk, onClose, onShowFinding }: SectionProps) {
	const [pending, setPending] = useState(false)
	const ref = useRef<HTMLElement>(null)
	// It opens below the comment and any replies, maybe out of sight: glide to it and let it glow once, so the eye
	// follows. Each click on Ask AI does it again. Reduced motion jumps instead, and the stylesheet drops the glow.
	useEffect(() => {
		const el = ref.current
		if (!el) return
		revealBelow(el)
		el.classList.remove('arrive')
		void el.offsetWidth // restart the animation
		el.classList.add('arrive')
	}, [focus])
	return (
		<section ref={ref} className="ic-ask" aria-label="Ask AI about this finding">
			<div className="ic-head">
				<b className="ic-who ai">Ask AI</b>
				<span className="ic-state" title="Only you see this. It is not part of the comment and is never posted.">
					Private
				</span>
				<span className="muted small">about the finding behind this comment</span>
				<span className="spacer" />
				{onShowFinding && (
					<button className="btn small ghost" onClick={onShowFinding} title="Open the finding in the Findings tab">
						Show finding
					</button>
				)}
				<button className="btn small ghost" onClick={onClose} disabled={pending} title="Close. The conversation is kept on the finding.">
					Close
				</button>
			</div>
			{(!!f.thread?.length || pending) && (
				<FindingThread messages={f.thread ?? []} pending={pending} path={f.anchor.newPath ?? f.anchor.oldPath} />
			)}
			<AskBox key={f.id} focus={focus} disabled={disabled} onBusy={setPending} onAsk={onAsk} modelPicker={modelPicker} onEscape={onClose} />
		</section>
	)
}

/** Scrolls the nearest scrolling ancestor up or down just enough to show `el`; never sideways, so the code stays put. */
function revealBelow(el: HTMLElement): void {
	let box = el.parentElement
	while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement
	if (!box) return
	const r = el.getBoundingClientRect()
	const view = box.getBoundingClientRect()
	const pad = 12
	// Bring the bottom up into view, but never push the top out of it when the section is taller than the view.
	let dy = 0
	if (r.bottom > view.bottom - pad) dy = Math.min(r.bottom - view.bottom + pad, r.top - view.top - pad)
	else if (r.top < view.top + pad) dy = r.top - view.top - pad
	if (dy !== 0) box.scrollBy({ top: dy, behavior: scrollBehavior() })
}
