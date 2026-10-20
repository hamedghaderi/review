import { fileRefs } from '../../shared/refs.ts'
import type { Finding, FindingVerification } from '../../shared/types.ts'
import type { ContextBatch, ContextExcerpt } from './context.ts'
import { PROJECT_CONTEXT_PATH } from './facts.ts'
import type { SeenLines } from './lookup.ts'

/**
 * Whether the `path:line` claims in a finding were read: each reference in its text is checked against the lines the
 * request that raised it had (excerpts, related code, the project context, and what its lookups showed). A reference
 * to lines it never had is a guess written as a fact, so it is shown as such. Deterministic; no extra request.
 */

export const NEAR = 3 // lines of slack around what was seen: a model that read 80–100 and cites 102 is taken at its word

/** What one request had in front of it, by path. Head and base lines count alike: a reference rarely says which. */
export class Seen {
	private ranges = new Map<string, Array<[number, number]>>()

	add(path: string | null, start: number, end: number): this {
		if (path) (this.ranges.get(path) ?? this.ranges.set(path, []).get(path)!).push([start, end])
		return this
	}

	lines(lines: Array<SeenLines>): this {
		for (const l of lines) this.add(l.path, l.start, l.end)
		return this
	}

	excerpt(e: ContextExcerpt): this {
		for (const l of e.lines) {
			if (l.newNo !== null) this.add(e.file.newPath, l.newNo, l.newNo)
			if (l.oldNo !== null) this.add(e.file.oldPath, l.oldNo, l.oldNo)
		}
		return this
	}

	/** Seen paths that a reference to `path` can mean: the same path, or one ending in it (`cart.ts` for `src/cart.ts`). */
	private files(path: string): Array<Array<[number, number]>> {
		return [...this.ranges].filter(([p]) => p === path || p.endsWith(`/${path}`)).map(([, r]) => r)
	}

	/** A reference without a line is read when any of the file was; with lines, when each is within NEAR of a seen one. */
	has(path: string, line: number | null, endLine: number | null): boolean {
		const files = this.files(path)
		if (line === null) return files.length > 0
		const end = Math.min(endLine ?? line, line + 2000)
		for (let n = line; n <= end; n++) if (!files.some((r) => r.some(([s, e]) => n >= s - NEAR && n <= e + NEAR))) return false
		return true
	}
}

/** What a review request had: its excerpts, the related code sent with it, the project context, and its lookups. */
export function seenInBatch(batch: ContextBatch, lookups: Array<SeenLines>): Seen {
	const seen = new Seen().lines(lookups)
	for (const e of batch.excerpts) seen.excerpt(e)
	for (const r of batch.references) seen.add(r.path, r.start, r.end)
	if (batch.facts.some((f) => f.kind === 'project')) seen.add(PROJECT_CONTEXT_PATH, 1, Number.MAX_SAFE_INTEGER)
	return seen
}

/** The references in `texts` to lines `seen` doesn't have, as written, each once. */
export function unreadRefs(texts: Array<string | null | undefined>, seen: Seen): Array<string> {
	const out: Array<string> = []
	for (const t of texts) {
		if (!t) continue
		for (const r of fileRefs(t)) {
			const text = t.slice(r.start, r.end)
			if (!seen.has(r.path, r.line, r.endLine) && !out.includes(text)) out.push(text)
		}
	}
	return out
}

/** The text a finding's claims are in: everything the model wrote about it except the quoted evidence. */
export function findingTexts(f: Finding): Array<string | null | undefined> {
	return [f.body, f.reasoning, f.disproof, f.background, f.problem, f.consequence, f.suggestion]
}

/** The double-check's answer: its reason and the places it says it read. */
export function verificationTexts(v: Pick<FindingVerification, 'reason' | 'checked'>): Array<string> {
	return [v.reason, ...v.checked]
}

/** `x` with its unread references, or as it was when there are none. */
export function withUnread<T extends { unread?: Array<string> }>(x: T, unread: Array<string>): T {
	return unread.length ? { ...x, unread } : x
}
