import type { AgentSetup } from './types.ts'

/** A shell word: single-quoted when it has anything the shell would read. */
const sh = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/** The one command that adds Review's read-only MCP server to Claude Code for all your projects (issue #200). */
export function claudeCommand(a: AgentSetup): string {
	const env = Object.entries(a.env).flatMap(([k, v]) => ['-e', sh(`${k}=${v}`)])
	return ['claude', 'mcp', 'add', '--scope', 'user', a.name, ...env, '--', sh(a.command), ...a.args.map(sh)].join(' ')
}

/**
 * Extracts an AppImage once into `parent/name` (issue #200): its contents land in squashfs-root, which is then renamed.
 * `mv -T` refuses to move it into an existing folder of that name, so an old copy is never half replaced.
 */
export function extractCommand(appImage: string, parent: string, name: string): string {
	return `mkdir -p ${sh(parent)} && cd ${sh(parent)} && ${sh(appImage)} --appimage-extract >/dev/null && mv -T squashfs-root ${sh(name)}`
}

/** The same server as an `mcpServers` entry, for agents configured with JSON. */
export function mcpJson(a: AgentSetup): string {
	return JSON.stringify({ mcpServers: { [a.name]: { command: a.command, args: a.args, env: a.env } } }, null, 2)
}
