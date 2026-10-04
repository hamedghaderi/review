import type { AiRun, CommentDraft, Finding, FindingCategory, Review, ReviewComment, Severity, TestPattern } from './types.ts'

export type FindingState = 'open' | 'accepted' | 'dismissed'

/** Maps every finding id to the id of the earliest equivalent finding (following `repeatOf`). */
export function findingRoots(runs: Array<AiRun>): Map<string, string> {
	const byId = new Map<string, Finding>()
	for (const run of runs) for (const f of run.findings) byId.set(f.id, f)
	const roots = new Map<string, string>()
	for (const f of byId.values()) {
		let cur = f
		const seen = new Set<string>()
		while (cur.repeatOf && byId.has(cur.repeatOf) && !seen.has(cur.id)) {
			seen.add(cur.id)
			cur = byId.get(cur.repeatOf) as Finding
		}
		roots.set(f.id, cur.id)
	}
	return roots
}

export interface FindingLink {
	comment: ReviewComment | null
	draft: CommentDraft | null
}

/** The comment or new draft created from this finding (or an equivalent one from another run). */
export function findingLink(review: Review, roots: Map<string, string>, findingId: string): FindingLink | null {
	const root = roots.get(findingId) ?? findingId
	const sameRoot = (id: string | null): boolean => id !== null && (roots.get(id) ?? id) === root
	const comment = review.comments.find((c) => sameRoot(c.findingId)) ?? null
	const draft = review.drafts.find((d) => d.commentId === null && sameRoot(d.findingId)) ?? null
	return comment || draft ? { comment, draft } : null
}

/**
 * Accepted = a linked comment/draft exists. Otherwise the most specific decision wins: this finding's own, then
 * the one recorded on the finding it repeats.
 */
export function findingState(review: Review, roots: Map<string, string>, finding: Finding, byId: Map<string, Finding>): FindingState {
	if (findingLink(review, roots, finding.id)) return 'accepted'
	let cur: Finding | undefined = finding
	const seen = new Set<string>()
	while (cur && !seen.has(cur.id)) {
		seen.add(cur.id)
		const d = review.findingDecisions[cur.id]
		if (d?.status === 'dismissed') return 'dismissed'
		if (d?.status === 'open') return 'open'
		cur = cur.repeatOf ? byId.get(cur.repeatOf) : undefined
	}
	return 'open'
}

/** How each level is shown in the app and in posted comments. */
export const LEVEL_META: Record<Severity, { label: string; emoji: string; hint: string }> = {
	blocking: { label: 'Blocking', emoji: '🔴', hint: 'A real problem with a check that would prove it wrong. Should not merge as is.' },
	should_fix: { label: 'Should fix', emoji: '🟠', hint: 'A real problem that cannot be settled with one check.' },
	question: { label: 'Question', emoji: '❓', hint: 'Only a problem if an assumption holds; asks the author one question.' },
	suggestion: { label: 'Suggestion', emoji: '💡', hint: 'Not a defect: a simpler or safer way the author may ignore.' },
	nit: { label: 'Nit', emoji: '🟢', hint: 'Small and cheap to fix, no effect on behavior. Never holds up a merge.' },
	fyi: { label: 'FYI', emoji: 'ℹ️', hint: 'No change needed: context the author should know.' },
	pre_existing: { label: 'Pre-existing', emoji: '🟣', hint: 'An existing problem the change exposes.' },
	high: { label: 'High', emoji: '🔴', hint: 'Older run' },
	medium: { label: 'Medium', emoji: '🟠', hint: 'Older run' },
	low: { label: 'Low', emoji: '🟣', hint: 'Older run' },
}

export const SEVERITY_ORDER: Record<Severity, number> = {
	blocking: 0,
	high: 0,
	should_fix: 1,
	medium: 1,
	question: 2,
	suggestion: 3,
	nit: 4,
	fyi: 5,
	pre_existing: 6,
	low: 6,
}

export const CATEGORY_LABEL: Record<FindingCategory, string> = {
	bug: 'Bug',
	security: 'Security',
	'error-handling': 'Error handling',
	'breaking-change': 'Breaking change',
	'file-split': 'File structure',
	'over-engineered': 'Over-engineered',
	convention: 'Convention',
	'test-value': 'Test value',
	residue: 'Residue',
}

export const TEST_PATTERN_LABEL: Record<TestPattern, string> = {
	'no-assertion': 'Checks nothing',
	'self-computed-expectation': 'Expected value from the code under test',
	'mock-does-the-work': 'Mock does the work',
	'test-only-seam': 'Code only tests use',
	duplicate: 'Duplicate test',
	'misses-the-change': 'Misses the change',
	'wrong-reason-negative': 'Fails for another reason',
	'misleading-name': 'Name promises more',
	'implementation-coupled': 'Tests the implementation',
}

export const RESIDUE_LABEL = [
	'',
	'Comment repeats the code',
	'Docstring repeats the signature',
	'Guard that cannot fire',
	'Unused addition',
	'Text addressed to a chat reader',
	'Re-implements an existing helper',
	'Test that cannot fail',
]

/** The label line on a posted comment: `🟠 <kbd>SHOULD FIX</kbd> <kbd>error handling</kbd>`. */
export function levelLine(f: Pick<Finding, 'severity' | 'category' | 'signature' | 'testPattern'>): string {
	const meta = LEVEL_META[f.severity]
	const topic =
		f.category === 'residue' && f.signature
			? RESIDUE_LABEL[f.signature]
			: f.category === 'test-value' && f.testPattern
				? TEST_PATTERN_LABEL[f.testPattern]
				: f.category
					? CATEGORY_LABEL[f.category]
					: null
	return [`${meta.emoji} <kbd>${meta.label.toUpperCase()}</kbd>`, topic ? `<kbd>${topic.toLowerCase()}</kbd>` : null]
		.filter(Boolean)
		.join(' ')
}

/** Where the blocking findings of a review stand, for the decision to approve or request changes. */
export interface BlockingSummary {
	added: number // added to the review as comments
	open: number // not decided yet
	openHolds: number // of those, the double-check says it holds
	openWrong: number // of those, the double-check says it is likely wrong
	dismissed: number
}

/**
 * Counts each blocking finding once, across runs (an equivalent finding from a later run is the same one, and its
 * newest version decides the double-check). Held-back and folded findings are not counted on their own.
 */
export function blockingSummary(review: Review, runs: Array<AiRun>, roots: Map<string, string>): BlockingSummary {
	const byId = new Map(runs.flatMap((r) => r.findings.map((f) => [f.id, f] as const)))
	const out: BlockingSummary = { added: 0, open: 0, openHolds: 0, openWrong: 0, dismissed: 0 }
	const seen = new Set<string>()
	for (const run of [...runs].reverse()) {
		for (const f of run.findings) {
			if (f.severity !== 'blocking' || f.heldBack || f.mergedInto) continue
			const root = roots.get(f.id) ?? f.id
			if (seen.has(root)) continue
			seen.add(root)
			const state = findingState(review, roots, f, byId)
			if (state === 'accepted') out.added++
			else if (state === 'dismissed') out.dismissed++
			else {
				out.open++
				if (f.verification && !f.verification.error) {
					if (f.verification.verdict === 'holds') out.openHolds++
					if (f.verification.verdict === 'wrong') out.openWrong++
				}
			}
		}
	}
	return out
}
