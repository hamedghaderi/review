import type { AgentSetup } from './types.ts'

/** A shell word: single-quoted when it has anything the shell would read. */
const sh = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/** The one command that adds Review's read-only MCP server to Claude Code for all your projects (issue #200). */
export function claudeCommand(a: AgentSetup): string {
	const env = Object.entries(a.env).flatMap(([k, v]) => ['-e', sh(`${k}=${v}`)])
	return ['claude', 'mcp', 'add', '--scope', 'user', a.name, ...env, '--', sh(a.command), ...a.args.map(sh)].join(' ')
}

/** The same server as an `mcpServers` entry, for agents configured with JSON. */
export function mcpJson(a: AgentSetup): string {
	return JSON.stringify({ mcpServers: { [a.name]: { command: a.command, args: a.args, env: a.env } } }, null, 2)
}
