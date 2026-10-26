import type { MentionUser } from './types.ts'

/**
 * An "@name" being typed at the cursor: "@" at the start of the text or after a space or "(", then the login typed so
 * far (GitHub logins are letters, digits and hyphens). `end` also covers the rest of a login the cursor is inside.
 * Not inside code, where GitHub doesn't turn "@name" into a mention either.
 */
export function mentionAt(text: string, cursor: number): { start: number; end: number; query: string } | null {
	const before = text.slice(0, cursor)
	const m = /(^|[\s(])@([A-Za-z0-9-]{0,39})$/.exec(before)
	if (!m || inCode(before)) return null
	const start = m.index + m[1].length
	const rest = /^[A-Za-z0-9-]*/.exec(text.slice(cursor))![0]
	return { start, end: cursor + rest.length, query: m[2] }
}

/** Inside a fenced code block, or inline code on the current line. */
function inCode(before: string): boolean {
	const fences = before.split('\n').filter((l) => /^\s*(```|~~~)/.test(l)).length
	if (fences % 2) return true
	const line = before.slice(before.lastIndexOf('\n') + 1)
	return (line.match(/`/g)?.length ?? 0) % 2 === 1
}

/** Replaces `text[start, end)` with "@login " and returns where the cursor goes (after the space). */
export function insertMention(text: string, start: number, end: number, login: string): { text: string; cursor: number } {
	const tail = text.slice(end)
	const mention = `@${login}${tail.startsWith(' ') ? '' : ' '}`
	return { text: text.slice(0, start) + mention + tail, cursor: start + login.length + 2 }
}

/**
 * Suggestions for `query`: people on this pull request first, in the order given, then GitHub's matches, without
 * repeats or yourself. A login or any word of a name that starts with the query matches; so does a login containing it.
 */
export function rankMentions(
	query: string,
	local: ReadonlyArray<MentionUser>,
	remote: ReadonlyArray<MentionUser>,
	me: string | null,
	limit = 8,
): Array<MentionUser> {
	const q = query.toLowerCase()
	const score = (u: MentionUser): number => {
		const login = u.login.toLowerCase()
		if (login.startsWith(q)) return 0
		if (
			(u.name ?? '')
				.toLowerCase()
				.split(/\s+/)
				.some((w) => w.startsWith(q))
		)
			return 1
		return login.includes(q) ? 2 : -1
	}
	const seen = new Set(me ? [me.toLowerCase()] : [])
	const out: Array<MentionUser> = []
	const add = (users: ReadonlyArray<MentionUser>, sort: boolean): void => {
		const hits = users.map((u, i) => ({ u, s: score(u), i })).filter((x) => x.s >= 0)
		if (sort) hits.sort((a, b) => a.s - b.s || a.i - b.i)
		for (const { u } of hits) {
			const key = u.login.toLowerCase()
			if (seen.has(key)) continue
			seen.add(key)
			out.push(u)
		}
	}
	add(local, true)
	// Someone on this pull request keeps their place, with the name GitHub knows them by.
	for (const u of remote) {
		const i = out.findIndex((x) => x.login.toLowerCase() === u.login.toLowerCase())
		if (i >= 0 && !out[i].name && u.name) out[i] = { ...out[i], name: u.name }
	}
	add(remote, false) // GitHub already ranked these
	return out.slice(0, limit)
}
