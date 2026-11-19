import { useEffect, useMemo, useState } from 'react'
import type { LineTokens } from './syntax.ts'
import { useSyntaxColours } from './theme.ts'

type Tokens = Array<LineTokens> | null

let worker: Worker | null | undefined // undefined: not started; null: couldn't start, so code stays plain
let nextId = 1
const waiting = new Map<number, (t: Tokens) => void>()

// The last few files' colours, so going back to a file shows them at once. Keyed by path and text.
const cache = new Map<string, Tokens>()
const CACHE_SIZE = 12

function start(): Worker | null {
	if (worker !== undefined) return worker
	try {
		worker = new Worker(new URL('./syntax.worker.ts', import.meta.url), { type: 'module' })
		worker.onmessage = (e: MessageEvent<{ id: number; tokens: Tokens }>) => {
			waiting.get(e.data.id)?.(e.data.tokens)
			waiting.delete(e.data.id)
		}
		worker.onerror = () => {
			worker?.terminate()
			worker = null
			for (const done of waiting.values()) done(null)
			waiting.clear()
		}
	} catch {
		worker = null
	}
	return worker
}

function remember(key: string, tokens: Tokens): void {
	cache.delete(key)
	cache.set(key, tokens)
	if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
}

/**
 * Each line's syntax tokens for `lines` of the file at `path` (issue #237), or null while they're worked out, when the
 * file's language isn't known, or when colouring is off in Settings · Appearance.
 */
export function useSyntax(path: string | null, lines: Array<string> | null): Tokens {
	const on = useSyntaxColours()
	const key = useMemo(() => (on && path && lines?.length ? `${path}\0${lines.join('\n')}` : null), [on, path, lines])
	const [got, setGot] = useState<{ key: string; tokens: Tokens } | null>(null)
	useEffect(() => {
		if (!key || cache.has(key) || !path || !lines) return
		const w = start()
		if (!w) return
		const id = nextId++
		let live = true
		waiting.set(id, (tokens) => {
			remember(key, tokens)
			if (live) setGot({ key, tokens })
		})
		w.postMessage({ id, path, lines })
		return () => {
			live = false
			if (waiting.delete(id)) w.postMessage({ cancel: id })
		}
	}, [key]) // eslint-disable-line react-hooks/exhaustive-deps -- path and lines are in the key
	if (!key) return null
	if (got?.key === key) return got.tokens
	return cache.get(key) ?? null
}
