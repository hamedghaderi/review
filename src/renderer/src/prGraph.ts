import { useEffect, useState } from 'react'
import type { MyReview } from '../../shared/prStack.ts'
import type { PrGraph } from '../../shared/types.ts'

/**
 * The repository's open pull requests and their branches, for connecting stacks. The main process caches it for two
 * minutes, so asking again when `refresh` changes (e.g. after a list refresh) is cheap.
 */
export function usePrGraph(repoId: string | null, enabled: boolean, refresh?: unknown): PrGraph | null {
	const [graph, setGraph] = useState<{ repoId: string; value: PrGraph | null } | null>(null)
	useEffect(() => {
		if (!repoId || !enabled) return
		let live = true
		void window.review.prGraph(repoId).then((r) => live && r.ok && setGraph({ repoId, value: r.value }))
		return () => {
			live = false
		}
	}, [repoId, enabled, refresh])
	return graph && graph.repoId === repoId ? graph.value : null
}

/**
 * Where you stand on each open PR that involves you (needs you, or what your review said), for marking stacks and picking the PR
 * to review next. Cached in the main process like the graph, and re-read when `refresh` changes or review requests do.
 */
export function useMyReviews(repoId: string | null, enabled: boolean, refresh?: unknown): ReadonlyMap<number, MyReview> | null {
	const [state, setState] = useState<{ repoId: string; value: ReadonlyMap<number, MyReview> | null } | null>(null)
	const [tick, setTick] = useState(0)
	useEffect(() => window.review.onInboxChanged(() => setTick((t) => t + 1)), [])
	useEffect(() => {
		if (!repoId || !enabled) return
		let live = true
		void window.review.myReviews(repoId).then((r) => {
			if (live && r.ok) setState({ repoId, value: r.value && new Map(Object.entries(r.value).map(([n, v]) => [Number(n), v])) })
		})
		return () => {
			live = false
		}
	}, [repoId, enabled, refresh, tick])
	return state && state.repoId === repoId ? state.value : null
}
