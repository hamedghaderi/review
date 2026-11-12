import type { PrDetail, Takeover, TakeoverOriginal } from '../shared/types.ts'
import type { Activity } from './activity.ts'
import { issueRefs } from './ai/background.ts'

/** At most this many pull requests the description only mentions are compared by commits. */
const MAX_MENTIONED = 3

const REF = String.raw`(?:([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)#|https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/pull\/|#)(\d+)\b`
// "replaces #12", "takes over PR #12", "continuation of https://github.com/o/n/pull/12"…
const WORDS = new RegExp(
	String.raw`\b(?:replaces|replacing|supersedes|superseding|continues|continuing|continuation of|takes over|taking over|takeover of|picks up|picking up|revives|reviving|carries on|carrying on)\s+(?:from\s+)?(?:(?:the\s+)?(?:pr|pull request)\s+)?${REF}`,
	'gi',
)
const PULL_LINK = /https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/pull\/(\d+)\b/g

/**
 * Numbers in `repo` a pull request description names: `words`, after takeover words ("supersedes #12"), in order;
 * `mentioned`, every other one (#12, owner/name#12, an issue or pull request link). Other repositories, the pull
 * request itself and code spans are left out.
 */
export function takeoverRefs(body: string, repo: string, self: number): { words: Array<number>; mentioned: Array<number> } {
	const text = body.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ')
	const here = (r: string | undefined) => !r || r.toLowerCase() === repo.toLowerCase()
	const ok = (n: number) => Number.isSafeInteger(n) && n > 0 && n !== self
	const words: Array<number> = []
	for (const m of text.matchAll(WORDS)) {
		const n = Number(m[3])
		if (here(m[1] ?? m[2]) && ok(n) && !words.includes(n)) words.push(n)
	}
	const mentioned: Array<number> = []
	const add = (n: number) => {
		if (ok(n) && !words.includes(n) && !mentioned.includes(n)) mentioned.push(n)
	}
	for (const r of issueRefs(text, repo, self)) if (here(r.repo)) add(r.number)
	for (const m of text.matchAll(PULL_LINK)) if (here(m[1])) add(Number(m[2]))
	return { words, mentioned }
}

export interface TakeoverDeps {
	detail(number: number): Promise<PrDetail>
	isIssue(number: number): Promise<boolean> // an issue, not a pull request; false when it can't be told
	activity(number: number): Promise<Activity>
	shared(original: PrDetail): Promise<number | null> // see sharedCommits; null: couldn't be compared
}

/**
 * The pull request this one takes over, or null. Takeover words name it outright: the first one named is read, and
 * when it can't be read that is said, so the reviewer isn't left to assume there was no original. Without such words,
 * a pull request the description only mentions counts when some of its commits are in this one. Only one original is
 * read; one it took over in turn is not followed.
 */
export async function findTakeover(pr: { repo: string; number: number; body: string }, deps: TakeoverDeps): Promise<Takeover | null> {
	const refs = takeoverRefs(pr.body, pr.repo, pr.number)
	for (const n of refs.words) {
		let d: PrDetail
		try {
			d = await deps.detail(n)
		} catch (e) {
			// "Replaces #12" can name an issue; that's a linked issue, not a takeover.
			if (await deps.isIssue(n).catch(() => false)) continue
			return { status: 'unreadable', repo: pr.repo, number: n, how: 'words', reason: messageOf(e) }
		}
		const shared = await deps.shared(d).catch(() => null)
		return { status: 'read', original: await readOriginal(d, 'words', shared, deps) }
	}
	for (const n of refs.mentioned.slice(0, MAX_MENTIONED)) {
		const d = await deps.detail(n).catch(() => null) // an issue, or a pull request that can't be read: nothing to compare
		if (!d) continue
		const shared = await deps.shared(d).catch(() => null)
		if (shared) return { status: 'read', original: await readOriginal(d, 'commits', shared, deps) }
	}
	return null
}

async function readOriginal(
	d: PrDetail,
	how: TakeoverOriginal['how'],
	shared: number | null,
	deps: TakeoverDeps,
): Promise<TakeoverOriginal> {
	const base = {
		repo: d.repo,
		number: d.number,
		url: d.url,
		title: d.title,
		state: d.state,
		body: d.body ?? '',
		author: d.author,
		association: d.authorAssociation ?? null,
		how,
		shared,
	}
	try {
		const a = await deps.activity(d.number)
		const threads = a.threads
			.filter((t) => !t.outdated && t.resolved !== true && t.comments.some((c) => !c.pending && c.body.trim()))
			.map((t) => ({
				path: t.path,
				line: t.originalLine ?? t.line,
				url: t.url,
				resolved: t.resolved,
				comments: t.comments.filter((c) => !c.pending && c.body.trim()),
			}))
		return { ...base, threads, threadsLeft: a.omitted.threads, partial: a.partial }
	} catch (e) {
		return { ...base, threads: [], threadsLeft: 0, partial: `Its review threads couldn't be read: ${messageOf(e)}` }
	}
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
