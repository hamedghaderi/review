import type { PrGraph, PrGraphNode, PrSummary } from './types.ts'

/**
 * Stacked pull requests: a PR is stacked on another when its base branch is that PR's head branch. Only heads in this
 * repository count; a fork's branch cannot be the base of a PR here.
 */

export interface StackRow {
	pr: PrSummary
	depth: number // 0 for the bottom of a stack (or a PR that is not stacked)
	context: boolean // not in the results: shown only to connect a result to the PR it is stacked on
}

export interface StackPosition {
	base: string | null // the branch the bottom of the stack targets, e.g. "main"
	parents: Array<PrGraphNode> // bottom of the stack first, ending with the PR this one is stacked on
	children: Array<{ node: PrGraphNode; above: number }> // PRs stacked directly on this one, with how many sit on each
}

function headIndex(graph: PrGraph): Map<string, PrGraphNode> {
	const byHead = new Map<string, PrGraphNode>()
	for (const n of graph.nodes) if (!n.crossRepo && !byHead.has(n.headRef)) byHead.set(n.headRef, n)
	return byHead
}

export function graphSummary(n: PrGraphNode): PrSummary {
	return {
		number: n.number,
		title: n.title,
		author: n.author,
		state: n.draft ? 'draft' : 'open',
		headRef: n.headRef,
		headOwner: null,
		baseRef: n.baseRef,
		crossRepo: n.crossRepo,
		updatedAt: n.updatedAt,
		url: n.url,
		reviewRequested: null,
		reviewers: [],
		review: null,
	}
}

/**
 * Search results arranged as stacks: each result under the PR it is stacked on, adding that PR (and the ones below it)
 * as context rows when the search did not return them. Stacks keep the order of their first result; PRs stacked on the
 * same parent are in number order. Without a graph the results are returned flat.
 */
export function stackRows(items: Array<PrSummary>, graph: PrGraph | null): Array<StackRow> {
	if (!graph) return items.map((pr) => ({ pr, depth: 0, context: false }))
	const byHead = headIndex(graph)
	const rows = new Map<number, { pr: PrSummary; context: boolean; order: number }>()
	items.forEach((pr, order) => rows.set(pr.number, { pr, context: false, order }))
	const parent = new Map<number, number>()
	for (const pr of items) {
		let cur: { number: number; baseRef: string | null } = pr
		const seen = new Set([pr.number])
		while (cur.baseRef && !parent.has(cur.number)) {
			const up = byHead.get(cur.baseRef)
			if (!up || seen.has(up.number)) break
			seen.add(up.number)
			parent.set(cur.number, up.number)
			if (!rows.has(up.number)) rows.set(up.number, { pr: graphSummary(up), context: true, order: Infinity })
			cur = up
		}
	}
	const children = new Map<number, Array<number>>()
	for (const [child, p] of parent) children.set(p, [...(children.get(p) ?? []), child])
	for (const list of children.values()) list.sort((a, b) => a - b)
	const first = new Map<number, number>()
	const firstOf = (n: number, path = new Set<number>()): number => {
		const known = first.get(n)
		if (known !== undefined) return known
		path.add(n)
		let best = rows.get(n)!.order
		for (const c of children.get(n) ?? []) if (!path.has(c)) best = Math.min(best, firstOf(c, path))
		first.set(n, best)
		return best
	}
	const out: Array<StackRow> = []
	const done = new Set<number>()
	const emit = (n: number, depth: number): void => {
		if (done.has(n)) return
		done.add(n)
		const r = rows.get(n)!
		out.push({ pr: r.pr, depth, context: r.context })
		for (const c of children.get(n) ?? []) emit(c, depth + 1)
	}
	const roots = [...rows.keys()].filter((n) => !parent.has(n))
	for (const n of roots.sort((a, b) => firstOf(a) - firstOf(b))) emit(n, 0)
	// Branches that target each other form a loop with no bottom; list them flat rather than lose them.
	for (const n of [...rows.keys()].sort((a, b) => firstOf(a) - firstOf(b))) emit(n, 0)
	return out
}

/** Where a pull request sits in its stack. Null when it is not stacked on, or under, any open PR. */
export function stackOf(
	graph: PrGraph,
	pr: { number: number; headRef: string | null; baseRef: string | null; crossRepo: boolean | null },
): StackPosition | null {
	const byHead = headIndex(graph)
	const parents: Array<PrGraphNode> = []
	const seen = new Set([pr.number])
	let base = pr.baseRef
	for (let up = base ? byHead.get(base) : undefined; up && !seen.has(up.number); up = byHead.get(up.baseRef)) {
		seen.add(up.number)
		parents.unshift(up)
		base = up.baseRef
	}
	const on = (head: string | null, crossRepo: boolean | null) =>
		head && !crossRepo ? graph.nodes.filter((n) => n.baseRef === head).sort((a, b) => a.number - b.number) : []
	const above = (n: PrGraphNode, path: Set<number>): number => {
		let count = 0
		for (const c of on(n.headRef, n.crossRepo)) {
			if (path.has(c.number)) continue
			path.add(c.number)
			count += 1 + above(c, path)
		}
		return count
	}
	const children = on(pr.headRef, pr.crossRepo)
		.filter((n) => n.number !== pr.number)
		.map((node) => ({ node, above: above(node, new Set([pr.number, node.number])) }))
	if (!parents.length && !children.length) return null
	return { base, parents, children }
}
