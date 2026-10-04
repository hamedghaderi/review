import { useEffect, useRef, useState } from 'react'

/**
 * A fixed, built-in set: picking one inserts plain Unicode text, so nothing is loaded from the network and no markup
 * reaches the text. GitHub renders the characters as is.
 */
const EMOJIS: Array<[string, string]> = [
	['👍', 'thumbs up approve yes'],
	['👎', 'thumbs down no'],
	['✅', 'check done ok approved'],
	['❌', 'cross no wrong'],
	['⚠️', 'warning caution'],
	['🚫', 'blocked stop forbidden'],
	['🔴', 'red blocking'],
	['🟠', 'orange should fix'],
	['🟢', 'green nit fine'],
	['🟣', 'purple pre-existing'],
	['❓', 'question'],
	['💡', 'idea suggestion'],
	['ℹ️', 'info fyi'],
	['🐛', 'bug'],
	['🔒', 'security lock'],
	['🧪', 'test'],
	['📝', 'note docs'],
	['🧹', 'cleanup'],
	['♻️', 'refactor recycle'],
	['⚡', 'performance fast'],
	['🚀', 'ship rocket launch'],
	['🎉', 'party celebrate'],
	['🙌', 'praise hands'],
	['👏', 'clap applause'],
	['💯', 'hundred perfect'],
	['❤️', 'heart love'],
	['🔥', 'fire great'],
	['✨', 'sparkles nice'],
	['👀', 'eyes look'],
	['🤔', 'thinking hmm'],
	['🙏', 'thanks please'],
	['😊', 'smile happy'],
	['😅', 'sweat smile'],
	['😄', 'grin laugh'],
	['🙂', 'slight smile'],
	['😬', 'grimace'],
	['🤝', 'handshake agree'],
	['💬', 'comment discuss'],
	['📌', 'pin important'],
	['🔁', 'repeat again'],
	['⏳', 'wait later pending'],
	['🏁', 'finish done'],
]

interface Props {
	disabled?: boolean
	onPick(emoji: string): void
}

export function EmojiPicker({ disabled, onPick }: Props) {
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState('')
	const root = useRef<HTMLDivElement>(null)

	useEffect(() => {
		if (!open) return
		const close = (e: MouseEvent): void => {
			if (!root.current?.contains(e.target as Node)) setOpen(false)
		}
		document.addEventListener('mousedown', close)
		return () => document.removeEventListener('mousedown', close)
	}, [open])

	const q = query.trim().toLowerCase()
	const shown = q ? EMOJIS.filter(([, name]) => name.includes(q)) : EMOJIS

	return (
		<div className="emoji-picker" ref={root}>
			<button
				type="button"
				className="btn small ghost"
				disabled={disabled}
				aria-haspopup="dialog"
				aria-expanded={open}
				title="Insert an emoji"
				onClick={() => setOpen((x) => !x)}
			>
				😊 Emoji
			</button>
			{open && (
				<div
					className="emoji-pop"
					role="dialog"
					aria-label="Emoji"
					onKeyDown={(e) => {
						if (e.key === 'Escape') {
							e.stopPropagation()
							setOpen(false)
						}
					}}
				>
					<input autoFocus placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search emoji" />
					<div className="emoji-grid">
						{shown.map(([emoji, name]) => (
							<button
								key={emoji}
								type="button"
								title={name.split(' ')[0]}
								aria-label={name.split(' ')[0]}
								onClick={() => {
									onPick(emoji)
									setOpen(false)
									setQuery('')
								}}
							>
								{emoji}
							</button>
						))}
						{!shown.length && <span className="muted small">No match</span>}
					</div>
				</div>
			)}
		</div>
	)
}
