import type { AiRun, Discussion, DiscussionThread, FixedThread, GoneFinding, Review } from '../shared/types.ts'

/**
 * Your GitHub threads that a newer run found fixed (issue #193). A finding the run marked "probably fixed" (its lines
 * changed and it wasn't raised again) is a candidate when the comment made from it was posted and started a thread that
 * is still open and yours. Only threads from findings: a hand-written thread has no finding to tell it's gone.
 */

export const MAX_FIXED_CHECKS = 10 // double-checks started after one run; the rest stay "unchecked"

export interface FixedCandidate {
	gone: GoneFinding
	thread: DiscussionThread
}

export function fixedThreadCandidates(
	run: Pick<AiRun, 'history'>,
	review: Pick<Review, 'comments' | 'publication'>,
	discussion: Pick<Discussion, 'threads' | 'viewer'>,
): Array<FixedCandidate> {
	const viewer = discussion.viewer
	if (!viewer || !run.history) return []
	const out: Array<FixedCandidate> = []
	for (const gone of run.history.gone) {
		if (gone.state !== 'fixed' || !gone.comment) continue
		// The comment made from it came along to this snapshot as a plain comment, keeping where it was published.
		const c = review.comments.find((x) => (x.carried?.originId ?? x.id) === gone.comment)
		if (!c) continue
		const own = new Set<string>()
		const pub = review.publication?.comments[c.id]
		if (pub) own.add(pub.githubId).add(pub.url)
		if (c.carried?.published) own.add(c.carried.published.url)
		const thread = discussion.threads.find((t) => {
			const first = t.comments[0]
			return !!first && (own.has(first.id) || (first.url !== null && own.has(first.url)))
		})
		// Open, as far as GitHub says (null: read without a token, which can't resolve anyway), and started by you.
		if (!thread || thread.resolved !== false || thread.comments[0].author !== viewer) continue
		out.push({ gone, thread })
	}
	return out
}

/** The row shown for a candidate: confirmed only when the double-check, run without error, says it's no longer there. */
export function fixedThread(runId: string, { gone, thread }: FixedCandidate, commit: string): FixedThread {
	const a = gone.at ?? gone.finding.anchor
	const path = (a.side === 'old' ? a.oldPath : a.newPath) ?? a.newPath ?? a.oldPath ?? a.fileKey
	const check = gone.check ?? null
	return {
		runId,
		findingId: gone.finding.id,
		title: gone.finding.title,
		place: a.startLine === null ? path : `${path}:${a.startLine}`,
		threadId: thread.id,
		url: thread.url,
		state: !check ? 'unchecked' : !check.error && check.verdict === 'wrong' ? 'confirmed' : 'not-confirmed',
		reason: check ? check.reason : null,
		commit,
	}
}
