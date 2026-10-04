import { useEffect, useState } from 'react'
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
