import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ChangedFile, Side } from '../../shared/types.ts'
import { fileRefs } from '../../shared/refs.ts'

/** Where a file reference in a finding's text goes: a changed file's diff, or a file the change doesn't touch. */
export interface RefTarget {
	path: string
	fileKey: string | null
	side: Side
}

interface RefLinks {
	target(path: string): RefTarget | null
	open(t: RefTarget, line: number | null): void
}

const RefContext = createContext<RefLinks | null>(null)
export const RefLinksProvider = RefContext.Provider

/**
 * Resolves the references in `texts`. A changed file is matched by its path, or by its file name when only one
 * changed file has it; any other path links only once the head commit is known to have that file.
 */
export function useRefLinks(
	comparisonId: string | null,
	files: Array<ChangedFile>,
	texts: Array<string>,
	open: (t: RefTarget, line: number | null) => void,
): RefLinks {
	const [atHead, setAtHead] = useState<{ id: string | null; paths: Map<string, boolean> }>({ id: null, paths: new Map() })
	const known = atHead.id === comparisonId ? atHead.paths : new Map<string, boolean>()
	const changed = useMemo(() => {
		const byPath = new Map<string, RefTarget>()
		const byName = new Map<string, Array<RefTarget>>()
		for (const f of files) {
			// A deleted file, or the old path of a renamed one, is read on the base side.
			const sides: Array<[string | null, Side]> = [
				[f.newPath, 'new'],
				[f.oldPath !== f.newPath ? f.oldPath : null, 'old'],
			]
			for (const [path, side] of sides) {
				if (!path) continue
				const t = { path, fileKey: f.key, side }
				byPath.set(path, t)
				const name = path.slice(path.lastIndexOf('/') + 1)
				byName.set(name, [...(byName.get(name) ?? []), t])
			}
		}
		return { byPath, byName }
	}, [files])
	const target = (path: string): RefTarget | null => {
		const hit = changed.byPath.get(path)
		if (hit) return hit
		if (!path.includes('/')) {
			const named = changed.byName.get(path)
			return named?.length === 1 ? named[0] : null
		}
		return known.get(path) ? { path, fileKey: null, side: 'new' } : null
	}
	const wanted = [...new Set(texts.flatMap((t) => fileRefs(t).map((r) => r.path)))]
		.filter((p) => p.includes('/') && !changed.byPath.has(p) && !known.has(p))
		.sort()
	const ask = wanted.slice(0, 200).join('\n')
	useEffect(() => {
		if (!comparisonId || !ask) return
		let live = true
		const paths = ask.split('\n')
		void window.review.filesAtHead(comparisonId, paths).then((r) => {
			if (!live) return
			const found = new Set(r.ok ? r.value : [])
			setAtHead((cur) => {
				const next = new Map(cur.id === comparisonId ? cur.paths : [])
				for (const p of paths) next.set(p, found.has(p))
				return { id: comparisonId, paths: next }
			})
		})
		return () => {
			live = false
		}
	}, [comparisonId, ask])
	return { target, open }
}

/** Text with its file references as links; plain text when nothing provides the links. */
export function RefText({ text }: { text: string }) {
	const links = useContext(RefContext)
	if (!links) return <>{text}</>
	const parts: Array<React.ReactNode> = []
	let at = 0
	for (const r of fileRefs(text)) {
		const t = links.target(r.path)
		if (!t) continue
		parts.push(text.slice(at, r.start))
		parts.push(
			<button
				key={r.start}
				className="link ref-link mono"
				title={t.fileKey ? 'Show in the diff' : 'Open read-only at the head commit; this file is not changed'}
				onClick={(e) => {
					e.stopPropagation()
					links.open(t, r.line)
				}}
			>
				{text.slice(r.start, r.end)}
			</button>,
		)
		at = r.end
	}
	parts.push(text.slice(at))
	return <>{parts}</>
}
