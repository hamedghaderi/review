import { findingLink, findingState, levelLine } from '../../shared/findings.ts'
import type { AiRun, Anchor, CommentDraft, DismissReason, Finding, FindingLevel, Review, ReviewComment } from '../../shared/types.ts'

function now(): string {
	return new Date().toISOString()
}

export function sameAnchor(a: Anchor, b: Anchor): boolean {
	return a.fileKey === b.fileKey && a.side === b.side && a.startLine === b.startLine && a.endLine === b.endLine
}

/** Empty new-comment drafts are UI-only. Drafts created from a finding are kept even if emptied. */
export function isBlank(d: CommentDraft): boolean {
	return d.commentId === null && d.findingId === null && d.body.trim() === ''
}

/** Opens a draft at `anchor`, reusing an unfinished draft already there. An empty previously-active draft is dropped. */
export function startDraft(r: Review, anchor: Anchor, prevActive: string | null): { review: Review; id: string } {
	let drafts = r.drafts.filter((d) => !(d.id === prevActive && isBlank(d)))
	const existing = drafts.find((d) => d.commentId === null && sameAnchor(d.anchor, anchor))
	if (existing) return { review: { ...r, drafts }, id: existing.id }
	const d: CommentDraft = { id: crypto.randomUUID(), anchor, body: '', commentId: null, findingId: null, updatedAt: now() }
	drafts = [...drafts, d]
	return { review: { ...r, drafts }, id: d.id }
}

export function updateDraft(r: Review, id: string, patch: Partial<Pick<CommentDraft, 'body' | 'anchor'>>): Review {
	return { ...r, drafts: r.drafts.map((d) => (d.id === id ? { ...d, ...patch, updatedAt: now() } : d)) }
}

export function discardDraft(r: Review, id: string): Review {
	return { ...r, drafts: r.drafts.filter((d) => d.id !== id) }
}

export function submitDraft(r: Review, id: string): Review {
	const d = r.drafts.find((x) => x.id === id)
	if (!d || !d.body.trim()) return r
	const drafts = r.drafts.filter((x) => x.id !== id)
	const t = now()
	if (d.commentId && r.comments.some((c) => c.id === d.commentId)) {
		return {
			...r,
			drafts,
			comments: r.comments.map((c) => (c.id === d.commentId ? { ...c, body: d.body, anchor: d.anchor, updatedAt: t } : c)),
		}
	}
	const c: ReviewComment = { id: crypto.randomUUID(), anchor: d.anchor, body: d.body, createdAt: t, updatedAt: t, findingId: d.findingId }
	return { ...r, drafts, comments: [...r.comments, c] }
}

export function editComment(r: Review, commentId: string): { review: Review; id: string } {
	const existing = r.drafts.find((d) => d.commentId === commentId)
	if (existing) return { review: r, id: existing.id }
	const c = r.comments.find((x) => x.id === commentId)
	if (!c) return { review: r, id: '' }
	const d: CommentDraft = { id: crypto.randomUUID(), anchor: c.anchor, body: c.body, commentId, findingId: c.findingId, updatedAt: now() }
	return { review: { ...r, drafts: [...r.drafts, d] }, id: d.id }
}

export function deleteComment(r: Review, commentId: string): Review {
	return { ...r, comments: r.comments.filter((c) => c.id !== commentId), drafts: r.drafts.filter((d) => d.commentId !== commentId) }
}

export function setViewed(r: Review, fileKey: string, viewed: boolean): Review {
	const set = new Set(r.viewed)
	if (viewed) set.add(fileKey)
	else set.delete(fileKey)
	return { ...r, viewed: [...set] }
}

/** What gets persisted: empty new-comment drafts are UI-only. */
export function forSave(r: Review): Review {
	return { ...r, drafts: r.drafts.filter((d) => !isBlank(d)) }
}

/**
 * The comment text for an accepted finding: a level label line, the body as written (result first), then the
 * disproof for blocking findings and a collapsed background, which is what a reviewer would post. "Why flagged"
 * stays in the app.
 */
export function findingCommentBody(f: Finding): string {
	if (f.body === undefined)
		return [`**${f.title}** (${f.severity})`, '', f.problem, '', `Consequence: ${f.consequence}`, '', `Suggestion: ${f.suggestion}`].join(
			'\n',
		)
	const parts = [levelLine(f), f.body]
	if (f.alsoAt?.length)
		parts.push(`**The same problem is also at:** ${f.alsoAt.map((x) => `\`${x.path}${x.line === null ? '' : `:${x.line}`}\``).join(', ')}`)
	if (f.disproof) parts.push(`**How to check this is wrong:** ${f.disproof}`)
	if (f.background) parts.push(`<details><summary>Background</summary>\n\n${f.background}\n\n</details>`)
	return parts.join('\n\n')
}

/**
 * Adds a finding to the review as an editable draft. Returns the existing draft or comment instead when the finding
 * (or an equivalent finding from another run) was already added.
 */
export function acceptFinding(
	r: Review,
	f: Finding,
	roots: Map<string, string>,
): { review: Review; draftId: string | null; commentId: string | null; created: boolean } {
	const link = findingLink(r, roots, f.id)
	if (link) return { review: r, draftId: link.draft?.id ?? null, commentId: link.comment?.id ?? null, created: false }
	const d: CommentDraft = {
		id: crypto.randomUUID(),
		anchor: f.anchor,
		body: findingCommentBody(f),
		commentId: null,
		findingId: f.id,
		updatedAt: now(),
	}
	const findingDecisions = { ...r.findingDecisions }
	delete findingDecisions[f.id]
	return { review: { ...r, drafts: [...r.drafts, d], findingDecisions }, draftId: d.id, commentId: null, created: true }
}

/**
 * Adds a finished run's open findings at the chosen levels as comments, so they show in the code without accepting
 * them one by one. They stay local until published, and can be edited or deleted like any comment. Dismissed,
 * held-back and already added findings (also from earlier runs) are skipped, and so are findings folded under another
 * as the same problem and findings the double-check showed to be likely wrong.
 */
export function autoAddFindings(
	r: Review,
	run: AiRun,
	runs: Array<AiRun>,
	roots: Map<string, string>,
	levels: ReadonlyArray<FindingLevel>,
): { review: Review; added: number } {
	const byId = new Map(runs.flatMap((x) => x.findings.map((f) => [f.id, f] as const)))
	let review = r
	let added = 0
	for (const f of run.findings) {
		if (f.heldBack || !(levels as ReadonlyArray<string>).includes(f.severity)) continue
		// Folded under another finding as the same problem: that one carries it.
		if (f.mergedInto) continue
		// The double-check showed it is likely wrong: leave it for a person to decide.
		if (f.verification?.verdict === 'wrong' && !f.verification.error) continue
		if (findingState(review, roots, f, byId) !== 'open') continue
		const res = acceptFinding(review, f, roots)
		if (res.created && res.draftId) {
			review = submitDraft(res.review, res.draftId)
			added++
		}
	}
	return { review, added }
}

export function setFindingDecision(
	r: Review,
	findingId: string,
	status: 'dismissed' | 'open',
	why: { reason?: DismissReason | null; note?: string | null } = {},
): Review {
	const d = { status, decidedAt: now(), ...(status === 'dismissed' ? { reason: why.reason ?? null, note: why.note ?? null } : {}) }
	return { ...r, findingDecisions: { ...r.findingDecisions, [findingId]: d } }
}

/** Adds or changes the note on a dismissal, keeping its reason and date. */
export function setDismissNote(r: Review, findingId: string, note: string): Review {
	const d = r.findingDecisions[findingId]
	if (d?.status !== 'dismissed') return r
	return { ...r, findingDecisions: { ...r.findingDecisions, [findingId]: { ...d, note: note.trim() || null } } }
}
