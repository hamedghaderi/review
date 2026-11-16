import { useEffect, useRef } from 'react'
import type { AiRun } from '../../shared/types.ts'

/**
 * What screen readers are told about the AI (issue #217): one live region for the whole window, at the end of the page,
 * instead of a live region on every thread and counter. A screen reader user keeps focus in the box they typed into,
 * so this is how they learn an answer arrived. Waiting text is said when it appears; an answer is said once, when it is
 * complete, as plain text (a code block or table becomes its size). The region is rendered by <Announcer />.
 *
 * How much is said is a setting on this computer (Settings › Accessibility): everything, only results, or nothing.
 * Both windows read the same storage, so a change in Settings applies at the next announcement.
 */

export type AnnounceLevel = 'all' | 'results' | 'off'
export type AnnounceKind = 'progress' | 'result'

export const ANNOUNCE_LEVELS: ReadonlyArray<AnnounceLevel> = ['all', 'results', 'off']
export const ANNOUNCE_KEY = 'review.announce'
const MAX_CHARS = 1500 // a longer answer is cut; the rest is on screen
const SETTLE_MS = 150 // announcements this close together are said as one

export function announceLevel(): AnnounceLevel {
	try {
		const v = localStorage.getItem(ANNOUNCE_KEY) as AnnounceLevel | null
		return v && ANNOUNCE_LEVELS.includes(v) ? v : 'all'
	} catch {
		return 'all'
	}
}

export function setAnnounceLevel(level: AnnounceLevel): void {
	try {
		localStorage.setItem(ANNOUNCE_KEY, level)
	} catch {
		// Not remembered; the default applies.
	}
}

let region: HTMLElement | null = null
let queued: Array<string> = []
let timer: ReturnType<typeof setTimeout> | null = null

/** Called by <Announcer /> with its element, and with null when it goes away. */
export function attachRegion(el: HTMLElement | null): void {
	region = el
}

export function announce(text: string, kind: AnnounceKind): void {
	const level = announceLevel()
	const t = text.trim()
	if (!t || level === 'off' || (level === 'results' && kind === 'progress')) return
	queued.push(t)
	if (timer) return
	// Emptied first and filled a moment later, so the same words said twice are still read the second time.
	if (region) region.textContent = ''
	timer = setTimeout(() => {
		timer = null
		const said = queued.join(' ')
		queued = []
		if (region) region.textContent = said
	}, SETTLE_MS)
}

/** Says `text` when `waiting` turns true, including when the component appears already waiting. */
export function useAnnounceWait(waiting: boolean, text: string): void {
	const was = useRef(false)
	useEffect(() => {
		if (waiting && !was.current) announce(text, 'progress')
		was.current = waiting
	}, [waiting, text])
}

/**
 * Says each item added after the component appeared, once: answers that arrive while you're here, not the history.
 * `speak` returns what to say, or null to say nothing for that item (your own messages).
 */
export function useAnnounceNew<T>(items: ReadonlyArray<T>, key: (item: T) => string, speak: (item: T) => string | null): void {
	const seen = useRef<Set<string> | null>(null)
	useEffect(() => {
		if (!seen.current) {
			seen.current = new Set(items.map(key))
			return
		}
		for (const item of items) {
			const k = key(item)
			if (seen.current.has(k)) continue
			seen.current.add(k)
			const s = speak(item)
			if (s) announce(s, 'result')
		}
	}, [items]) // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * The model's Markdown as something to listen to: a code block or table becomes its size, links and images their
 * text, and formatting marks go. Cut at MAX_CHARS, saying the rest is on screen.
 */
export function speakable(markdown: string): string {
	const out: Array<string> = []
	const lines = markdown.replace(/\r\n/g, '\n').split('\n')
	for (let i = 0; i < lines.length; i++) {
		const fence = /^\s*(`{3,}|~{3,})\s*(.*)$/.exec(lines[i])
		if (fence) {
			let n = 0
			let j = i + 1
			while (j < lines.length && !lines[j].trim().startsWith(fence[1])) {
				n++
				j++
			}
			const info = fence[2].trim().split(/\s+/).filter(Boolean)
			const name = info.find((w) => /[./]/.test(w)) ?? info[0]
			out.push(`Code block${name ? `, ${name}` : ''}, ${n} line${n === 1 ? '' : 's'}.`)
			i = j
			continue
		}
		if (/^\s*\|.*\|\s*$/.test(lines[i])) {
			let j = i
			while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) j++
			const rows = lines.slice(i, j).filter((l) => !/^\s*\|[\s:|-]+\|\s*$/.test(l))
			const cols = rows[0]
				? rows[0]
						.trim()
						.replace(/^\||\|$/g, '')
						.split('|').length
				: 0
			const body = Math.max(rows.length - 1, 0)
			out.push(`Table, ${body} row${body === 1 ? '' : 's'} and ${cols} column${cols === 1 ? '' : 's'}.`)
			i = j - 1
			continue
		}
		const line = lines[i]
			.replace(/^\s{0,3}#{1,6}\s+/, '')
			.replace(/^\s*>\s?/, '')
			.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => (alt ? `Image: ${alt}` : 'Image'))
			.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
			.replace(/(\*\*|__)(.+?)\1/g, '$2')
			.replace(/`([^`]+)`/g, '$1')
			.trim()
		if (line) out.push(line)
	}
	const text = out.join(' ').replace(/\s+/g, ' ').trim()
	if (text.length <= MAX_CHARS) return text
	const cut = text.slice(0, MAX_CHARS)
	return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), MAX_CHARS - 200))}… The rest is on screen.`
}

/** What to say when a review run changes: started, double-checking, and how it ended. Null when nothing worth saying. */
export function runAnnouncement(prev: AiRun | undefined, run: AiRun): { text: string; kind: AnnounceKind } | null {
	const what = run.commitOf ? `AI review of commit ${run.commitOf.sha.slice(0, 7)}` : 'AI review'
	if (run.status === 'running') {
		if (!prev) return { text: `${what} started.`, kind: 'progress' }
		const v = run.verification
		if (v?.total && !prev.verification?.total)
			return { text: `Double-checking ${v.total} blocking finding${v.total === 1 ? '' : 's'}.`, kind: 'progress' }
		return null
	}
	if (prev?.status !== 'running') return null
	if (run.status === 'cancelled') return { text: `${what} stopped.`, kind: 'result' }
	if (run.status === 'failed') return { text: `${what} failed${run.errors[0] ? `: ${run.errors[0]}` : '.'}`, kind: 'result' }
	const n = run.findings.length
	const blocking = run.findings.filter((f) => f.severity === 'blocking').length
	const found = n ? `${n} finding${n === 1 ? '' : 's'}${blocking ? `, ${blocking} blocking` : ''}` : 'no findings'
	const partly = run.status === 'partial' ? ' Some files were not reviewed.' : ''
	return { text: `${what} finished: ${found}.${partly}`, kind: 'result' }
}

/** Who said a message, as its hidden heading says it (issue #218): "You asked", "Opus 5.5 answered: still holds"… */
export function speaker(m: { role: 'you' | 'ai'; model?: string | null; error?: boolean }, detail?: string | null): string {
	if (m.role === 'you') return 'You asked'
	if (m.error) return 'The AI couldn’t answer'
	return `${m.model ?? 'The AI'} answered${detail ? `: ${detail}` : ''}`
}
