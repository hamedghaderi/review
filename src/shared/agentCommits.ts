/**
 * Which of a pull request's commits a coding agent wrote (issue #272), from what the commits say: a Co-authored-by
 * trailer naming an agent, or an agent's own account as the author. A hint about where to look harder, never a judgement.
 *
 * Only agents on this list count. Dependency bots (Dependabot, Renovate…) are bots, but not agents writing code, so they
 * are left off. A stale list misses a new agent; it never labels a person's commit.
 */
interface Agent {
	name: string
	emails?: ReadonlyArray<string> // exact, as an author or in a Co-authored-by trailer
	logins?: ReadonlyArray<string> // GitHub accounts: the author name, or their users.noreply.github.com address
	nameSuffix?: string // appended to the author's name
}

export const AGENTS: ReadonlyArray<Agent> = [
	{ name: 'Claude', emails: ['noreply@anthropic.com'], logins: ['claude[bot]'] },
	{ name: 'Cursor', emails: ['cursoragent@cursor.com'], logins: ['cursor[bot]'] },
	{ name: 'Copilot', logins: ['copilot', 'copilot-swe-agent[bot]'] },
	{ name: 'Codex', emails: ['codex@openai.com', 'noreply@openai.com'], logins: ['chatgpt-codex-connector[bot]'] },
	{ name: 'Devin', logins: ['devin-ai-integration[bot]'] },
	{ name: 'Jules', logins: ['google-labs-jules[bot]'] },
	{ name: 'Aider', emails: ['aider@aider.chat'], nameSuffix: '(aider)' },
	{ name: 'Amp', emails: ['amp@ampcode.com'] },
	{ name: 'OpenHands', emails: ['openhands@all-hands.dev'] },
]

export interface AgentCommit {
	sha: string
	name: string // the author's
	email: string
	message: string // the full message, for its trailers
}

/** How many of the commits an agent wrote; null when none did. Agents in the order they first appear. */
export interface AgentShare {
	agentCommits: number // commits with at least one agent
	commits: number // all the commits counted (merges left out)
	byAgent: Array<{ agent: string; commits: number }>
}

const TRAILER = /^[ \t]*co-authored-by:[ \t]*([^<\n]*?)[ \t]*<([^>\n]+)>/gim
const NOREPLY = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/

function agentFor(name: string, email: string): string | null {
	const n = name.trim().toLowerCase()
	const e = email.trim().toLowerCase()
	const login = NOREPLY.exec(e)?.[1]
	for (const a of AGENTS) {
		if (a.emails?.includes(e)) return a.name
		if (a.logins?.some((l) => l === login || (l.endsWith('[bot]') && l === n))) return a.name
		if (a.nameSuffix && n.endsWith(a.nameSuffix)) return a.name
	}
	return null
}

/** The agents a commit names: its author, then its Co-authored-by trailers. */
export function commitAgents(c: AgentCommit): Array<string> {
	const out: Array<string> = []
	const add = (a: string | null) => void (a && !out.includes(a) && out.push(a))
	add(agentFor(c.name, c.email))
	for (const m of c.message.matchAll(TRAILER)) add(agentFor(m[1], m[2]))
	return out
}

export function agentShare(commits: ReadonlyArray<AgentCommit>): AgentShare | null {
	const by = new Map<string, number>()
	let agentCommits = 0
	for (const c of commits) {
		const agents = commitAgents(c)
		if (!agents.length) continue
		agentCommits++
		for (const a of agents) by.set(a, (by.get(a) ?? 0) + 1)
	}
	if (!agentCommits) return null
	return { agentCommits, commits: commits.length, byAgent: [...by].map(([agent, commits]) => ({ agent, commits })) }
}

/** "Claude 7, Cursor 2" */
export function agentShareDetail(s: AgentShare): string {
	return s.byAgent.map((a) => `${a.agent} ${a.commits}`).join(', ')
}
