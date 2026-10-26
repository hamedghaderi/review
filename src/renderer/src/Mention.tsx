import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { insertMention, mentionAt, rankMentions } from '../../shared/mention.ts'
import type { MentionUser } from '../../shared/types.ts'
import { Floating } from './GifPicker.tsx'

/** Who can be suggested after "@" in the open review: people on the pull request, and GitHub's search when there is one. */
export interface Mentions {
	people: ReadonlyArray<MentionUser> // on this pull request, most relevant first
	me: string | null // your login, never suggested
	search: ((query: string) => Promise<Array<MentionUser>>) | null // null outside PR reviews or without a token
}

const MentionContext = createContext<Mentions | null>(null)
export const MentionProvider = MentionContext.Provider

/** GitHub's matches for the query, a moment after typing stops; the newest query wins. Nothing for a bare "@". */
function useMentionSearch(search: Mentions['search'], active: boolean, query: string): { users: Array<MentionUser>; loading: boolean } {
	const [s, setS] = useState<{ query: string; users: Array<MentionUser>; loading: boolean }>({ query: '', users: [], loading: false })
	const generation = useRef(0)
	useEffect(() => {
		if (!active || !search || !query) return
		const gen = ++generation.current
		setS((x) => ({ ...x, loading: true }))
		const t = window.setTimeout(async () => {
			const users = await search(query).catch(() => [])
			if (gen === generation.current) setS({ query, users, loading: false })
		}, 200)
		return () => {
			generation.current++
			window.clearTimeout(t)
		}
	}, [search, active, query])
	// Results for an older query still show while the newer one loads; they're filtered by it again anyway.
	return { users: active && query ? s.users : [], loading: active && !!query && !!search && (s.loading || s.query !== query) }
}

/**
 * "@" typed in a text box suggests people to mention, like GitHub: people on this pull request first, then GitHub's
 * matches. Arrows move, Enter or Tab picks, Esc closes it until "@" is typed again. Outside a review it does nothing.
 * `onKeyDown` returns true when it handled the key, so the box skips its own shortcuts.
 */
export function useMentionCommand(
	text: string,
	ref: RefObject<HTMLTextAreaElement | null>,
	apply: (next: string, cursor: number) => void,
	prefer: 'above' | 'below' = 'below',
): { panel: ReactNode; onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean } {
	const ctx = useContext(MentionContext)
	const cursor = ref.current?.selectionEnd ?? text.length
	const cmd = ctx ? mentionAt(text, cursor) : null
	const [dismissed, setDismissed] = useState<number | null>(null)
	const [selected, setSelected] = useState(0)
	const active = !!cmd && dismissed !== cmd.start
	const remote = useMentionSearch(ctx?.search ?? null, active, cmd?.query ?? '')
	const users = active && ctx ? rankMentions(cmd.query, ctx.people, remote.users, ctx.me) : []

	useEffect(() => {
		if (!cmd && dismissed !== null) setDismissed(null)
	}, [cmd, dismissed])
	useEffect(() => setSelected(0), [cmd?.query])

	const pick = (u: MentionUser): void => {
		if (!cmd) return
		const r = insertMention(text, cmd.start, cmd.end, u.login)
		apply(r.text, r.cursor)
		requestAnimationFrame(() => {
			ref.current?.focus()
			ref.current?.setSelectionRange(r.cursor, r.cursor)
		})
	}

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
		if (!active || !cmd) return false
		const n = users.length
		if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && n) {
			e.preventDefault()
			setSelected((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
			return true
		}
		if ((e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey)) && n) {
			e.preventDefault()
			pick(users[Math.min(selected, n - 1)])
			return true
		}
		if (e.key === 'Escape') {
			e.preventDefault()
			e.stopPropagation()
			setDismissed(cmd.start)
			return true
		}
		return false
	}

	const panel =
		active && (users.length > 0 || remote.loading) ? (
			<Floating anchor={ref} prefer={prefer} className="slash-menu mention-menu" label="Mention someone">
				<div role="listbox" aria-label="People">
					{users.map((u, i) => (
						<button
							key={u.login}
							type="button"
							role="option"
							aria-selected={i === selected}
							className={`slash-item ${i === selected ? 'on' : ''}`}
							// Keeps the focus (and cursor) in the comment box.
							onMouseDown={(e) => e.preventDefault()}
							onMouseEnter={() => setSelected(i)}
							onClick={() => pick(u)}
						>
							<span className="mention-login">@{u.login}</span>
							{u.name && <span className="muted ellipsis">{u.name}</span>}
						</button>
					))}
				</div>
				{remote.loading && <div className="muted small mention-foot">Searching GitHub…</div>}
			</Floating>
		) : null
	return { panel, onKeyDown }
}
