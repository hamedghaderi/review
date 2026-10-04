import type { DiscussionComment, DiscussionReview, Side } from '../shared/types.ts'

/**
 * A pull request's existing review activity as GitHub reports it, before it is placed on a snapshot. Everything in
 * here is third-party text written by anyone who can comment on the PR: it is shown, never acted on.
 */
export interface Activity {
	headSha: string
	baseSha: string
	threads: Array<RawThread>
	reviews: Array<DiscussionReview>
	conversation: Array<DiscussionComment>
	omitted: { threads: number; comments: number; reviews: number; conversation: number }
	partial: string | null // why the read is incomplete, e.g. no token so resolved state is unknown
}

export interface RawThread {
	id: string
	path: string
	subject: 'line' | 'file'
	side: Side | null
	line: number | null // current position on the PR head; null once GitHub can't place it
	startLine: number | null
	originalLine: number | null
	originalStartLine: number | null
	originalCommit: string | null
	resolved: boolean | null
	resolvedBy: string | null
	outdated: boolean
	diffHunk: string | null
	comments: Array<DiscussionComment>
	commentsOmitted: number
	url: string | null
}

export const BODY_LIMIT = 20_000
export const THREAD_PAGES = 10 // 50 threads each
export const COMMENTS_PER_THREAD = 30
export const LIST_LIMIT = 100 // reviews and conversation comments

export function body(text: string | null | undefined): { body: string; bodyTruncated: boolean } {
	const t = text ?? ''
	return t.length > BODY_LIMIT ? { body: t.slice(0, BODY_LIMIT), bodyTruncated: true } : { body: t, bodyTruncated: false }
}

/** Links are shown only when they point at github.com, so a crafted comment can't hand the viewer another site. */
export function safeUrl(u: string | null | undefined): string | null {
	return typeof u === 'string' && u.startsWith('https://github.com/') ? u : null
}

const side = (s: string | null | undefined): Side | null => (s === 'LEFT' ? 'old' : s === 'RIGHT' ? 'new' : null)

// Reviews that hold nothing to read: the viewer's unsubmitted one, and "commented" reviews whose only content is
// inline comments (those appear as threads).
function keepReview(state: string, text: string): boolean {
	return state !== 'PENDING' && !(state === 'COMMENTED' && !text.trim())
}

// ─── GraphQL (with a token): the only API that reports resolved and outdated ─────────────────────────────────

export const ACTIVITY_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String, $first: Boolean!) {
  rateLimit { remaining limit resetAt }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid baseRefOid
      reviewThreads(first: 50, after: $after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated resolvedBy { login }
          path line startLine originalLine originalStartLine diffSide subjectType
          comments(first: ${COMMENTS_PER_THREAD}) {
            totalCount
            nodes { id body author { login } authorAssociation createdAt url state diffHunk originalCommit { oid } }
          }
        }
      }
      reviews(first: ${LIST_LIMIT}) @include(if: $first) {
        totalCount
        nodes { id author { login } state body submittedAt url }
      }
      comments(first: ${LIST_LIMIT}) @include(if: $first) {
        totalCount
        nodes { id author { login } authorAssociation body createdAt url }
      }
    }
  }
}`

interface GqlComment {
	id: string
	body: string
	author: { login: string } | null
	authorAssociation?: string | null
	createdAt: string | null
	url: string | null
	state?: string | null
	diffHunk?: string | null
	originalCommit?: { oid: string } | null
}

export interface GqlActivity {
	repository: {
		pullRequest: {
			headRefOid: string
			baseRefOid: string
			reviewThreads: {
				totalCount: number
				pageInfo: { hasNextPage: boolean; endCursor: string | null }
				nodes: Array<{
					id: string
					isResolved: boolean
					isOutdated: boolean
					resolvedBy: { login: string } | null
					path: string
					line: number | null
					startLine: number | null
					originalLine: number | null
					originalStartLine: number | null
					diffSide: string | null
					subjectType: string | null
					comments: { totalCount: number; nodes: Array<GqlComment> }
				}>
			}
			reviews?: {
				totalCount: number
				nodes: Array<{ id: string; author: { login: string } | null; state: string; body: string; submittedAt: string | null; url: string }>
			}
			comments?: { totalCount: number; nodes: Array<GqlComment> }
		} | null
	} | null
}

function gqlComment(c: GqlComment): DiscussionComment {
	return {
		id: c.id,
		author: c.author?.login ?? null,
		association: c.authorAssociation ?? null,
		...body(c.body),
		createdAt: c.createdAt,
		url: safeUrl(c.url),
		pending: c.state === 'PENDING',
	}
}

export function fromGraphql(pages: Array<NonNullable<NonNullable<GqlActivity['repository']>['pullRequest']>>): Activity {
	const [first] = pages
	const threads: Array<RawThread> = []
	let comments = 0
	for (const p of pages)
		for (const t of p.reviewThreads.nodes) {
			const root = t.comments.nodes[0]
			comments += Math.max(0, t.comments.totalCount - t.comments.nodes.length)
			threads.push({
				id: t.id,
				path: t.path,
				subject: t.subjectType === 'FILE' ? 'file' : 'line',
				side: side(t.diffSide),
				line: t.line,
				startLine: t.startLine,
				originalLine: t.originalLine,
				originalStartLine: t.originalStartLine,
				originalCommit: root?.originalCommit?.oid ?? null,
				resolved: t.isResolved,
				resolvedBy: t.resolvedBy?.login ?? null,
				outdated: t.isOutdated,
				diffHunk: root?.diffHunk ?? null,
				comments: t.comments.nodes.map(gqlComment),
				commentsOmitted: Math.max(0, t.comments.totalCount - t.comments.nodes.length),
				url: safeUrl(root?.url),
			})
		}
	const reviews = first.reviews?.nodes ?? []
	const conv = first.comments?.nodes ?? []
	return {
		headSha: first.headRefOid,
		baseSha: first.baseRefOid,
		threads,
		reviews: reviews
			.filter((r) => keepReview(r.state, r.body))
			.map((r) => ({
				id: r.id,
				author: r.author?.login ?? null,
				state: r.state,
				...body(r.body),
				submittedAt: r.submittedAt,
				url: safeUrl(r.url),
			})),
		conversation: conv.map(gqlComment),
		omitted: {
			threads: Math.max(0, first.reviewThreads.totalCount - threads.length),
			comments,
			reviews: Math.max(0, (first.reviews?.totalCount ?? 0) - reviews.length),
			conversation: Math.max(0, (first.comments?.totalCount ?? 0) - conv.length),
		},
		partial: null,
	}
}

// ─── REST (without a token): same comments, but no resolved state ───────────────────────────────────────────

export interface RestReviewComment {
	id: number
	node_id: string
	in_reply_to_id?: number
	path: string
	line: number | null
	start_line: number | null
	original_line: number | null
	original_start_line: number | null
	side: string | null
	subject_type?: string
	diff_hunk: string | null
	original_commit_id: string | null
	user: { login: string } | null
	author_association: string | null
	body: string
	created_at: string | null
	html_url: string | null
}

export interface RestReview {
	node_id: string
	user: { login: string } | null
	state: string
	body: string | null
	submitted_at: string | null
	html_url: string | null
}

export interface RestIssueComment {
	node_id: string
	user: { login: string } | null
	author_association: string | null
	body: string | null
	created_at: string | null
	html_url: string | null
}

export function fromRest(
	pr: { headSha: string; baseSha: string },
	comments: Array<RestReviewComment>,
	commentsCapped: boolean,
	reviews: Array<RestReview>,
	issueComments: Array<RestIssueComment>,
): Activity {
	const roots = new Map<number, RestReviewComment>()
	const replies = new Map<number, Array<RestReviewComment>>()
	for (const c of comments) {
		if (c.in_reply_to_id === undefined) roots.set(c.id, c)
		else replies.set(c.in_reply_to_id, [...(replies.get(c.in_reply_to_id) ?? []), c])
	}
	const restComment = (c: {
		node_id: string
		user: { login: string } | null
		author_association: string | null
		body: string | null
		created_at: string | null
		html_url: string | null
	}): DiscussionComment => ({
		id: c.node_id,
		author: c.user?.login ?? null,
		association: c.author_association,
		...body(c.body),
		createdAt: c.created_at,
		url: safeUrl(c.html_url),
		pending: false,
	})
	const threads: Array<RawThread> = [...roots.values()].map((r) => {
		const all = [r, ...(replies.get(r.id) ?? [])]
		const file = r.subject_type === 'file'
		return {
			id: r.node_id,
			path: r.path,
			subject: file ? 'file' : 'line',
			side: file ? null : side(r.side),
			line: r.line,
			startLine: r.start_line,
			originalLine: r.original_line,
			originalStartLine: r.original_start_line,
			originalCommit: r.original_commit_id,
			resolved: null,
			resolvedBy: null,
			outdated: !file && r.line === null, // REST drops the current line once the thread is outdated
			diffHunk: r.diff_hunk,
			comments: all.slice(0, COMMENTS_PER_THREAD).map(restComment),
			commentsOmitted: Math.max(0, all.length - COMMENTS_PER_THREAD),
			url: safeUrl(r.html_url),
		}
	})
	const kept = reviews.filter((r) => keepReview(r.state, r.body ?? ''))
	return {
		headSha: pr.headSha,
		baseSha: pr.baseSha,
		threads,
		reviews: kept.map((r) => ({
			id: r.node_id,
			author: r.user?.login ?? null,
			state: r.state,
			...body(r.body),
			submittedAt: r.submitted_at,
			url: safeUrl(r.html_url),
		})),
		conversation: issueComments.map(restComment),
		omitted: { threads: 0, comments: 0, reviews: 0, conversation: 0 },
		partial: `Read without a GitHub token, so GitHub doesn't say which threads are resolved.${commentsCapped ? ' Only the first comments were read.' : ''} Connect GitHub to see resolved state.`,
	}
}
