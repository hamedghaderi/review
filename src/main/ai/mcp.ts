import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpImportCandidate, McpServerInput, McpServerView, McpSettingsView, McpToolView, McpTransport } from '../../shared/types.ts'
import { AppFail, env as baseEnv } from '../git.ts'
import { JsonStore } from '../store.ts'
import type { CredentialService } from './credentials.ts'
import type { ExternalTools, ToolDefinition, ToolResult } from './lookup.ts'
import { redactSecrets } from './provider.ts'

/**
 * MCP servers whose tools the AI reviewers may call while they review, next to the built-in read-only lookups.
 * Server settings live in mcp-servers.json; environment variables and headers can hold tokens, so their values are
 * kept by the CredentialService (OS keychain) and never sent to the renderer.
 *
 * Tools can have side effects, so only tools that look read-only are offered unless the user picks others: the
 * server's readOnlyHint, or a name like get_/list_/search_ when the server does not say.
 */

interface StoredTool {
	name: string
	description: string
	readOnly: boolean | null
	destructive: boolean | null
}

interface StoredServer {
	id: string
	name: string
	transport: McpTransport
	command: string
	args: Array<string>
	url: string
	envKeys: Array<string>
	headerKeys: Array<string>
	enabled: boolean
	tools: Array<StoredTool> | null
	allowed: Array<string> | null // null: the read-only default
	lastTest: { ok: boolean; at: string; message: string } | null
	origin: string | null
	createdAt: string
}

interface McpFile {
	version: 1
	servers: Array<StoredServer>
}

interface Secrets {
	env: Record<string, string>
	headers: Record<string, string>
}

const CONNECT_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 60_000
const MAX_SERVERS = 20
const MAX_TOOLS_PER_SERVER = 60
const DESCRIPTION_MAX = 1000

const READ_VERB =
	/(^|[_\-.])(get|list|search|read|fetch|find|query|describe|view|show|lookup|retrieve|browse|count|check|status|info)([_\-.]|$)/i
const WRITE_VERB =
	/(^|[_\-.])(create|update|delete|remove|write|post|send|set|add|edit|merge|close|reopen|comment|assign|transition|move|upload|run|exec|execute|apply|approve|publish|push|start|stop|cancel|archive|rename|invite|reply)([_\-.]|$)/i

/** Whether a tool is offered when the user has not picked tools for its server. */
export function looksReadOnly(t: Pick<StoredTool, 'name' | 'readOnly' | 'destructive'>): boolean {
	if (t.readOnly === true) return true
	if (t.readOnly === false || t.destructive === true) return false
	return READ_VERB.test(t.name) && !WRITE_VERB.test(t.name)
}

function emptyFile(): McpFile {
	return { version: 1, servers: [] }
}

function migrate(raw: unknown): McpFile {
	const f = raw as Partial<McpFile> | null
	return { version: 1, servers: Array.isArray(f?.servers) ? f.servers : [] }
}

export class McpService {
	private file: JsonStore<McpFile>
	private credentials: CredentialService
	private listeners = new Set<(v: McpSettingsView) => void>()

	constructor(dir: string, credentials: CredentialService) {
		this.file = new JsonStore<McpFile>(join(dir, 'mcp-servers.json'), emptyFile, migrate)
		this.credentials = credentials
	}

	load(): Promise<void> {
		return this.file.load()
	}

	onChange(listener: (v: McpSettingsView) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	view(): McpSettingsView {
		return {
			servers: this.file.read().servers.map((s) => this.serverView(s)),
			secureStorage: this.credentials.storageInfo().secure,
		}
	}

	private serverView(s: StoredServer): McpServerView {
		const peek = s.envKeys.length || s.headerKeys.length ? this.credentials.peek(secretId(s.id), endpointOf(s)) : 'none'
		return {
			id: s.id,
			name: s.name,
			transport: s.transport,
			command: s.command,
			args: s.args,
			url: s.url,
			envKeys: s.envKeys,
			headerKeys: s.headerKeys,
			enabled: s.enabled,
			tools:
				s.tools?.map((t): McpToolView => ({ name: t.name, description: t.description, readOnly: t.readOnly, allowed: isAllowed(s, t) })) ??
				null,
			customTools: s.allowed !== null,
			lastTest: s.lastTest,
			secretsState: peek === 'endpoint-changed' ? 'unreadable' : peek,
			origin: s.origin,
		}
	}

	private changed(): void {
		const v = this.view()
		for (const l of this.listeners) l(v)
	}

	async save(id: string | null, input: McpServerInput, origin: string | null = null): Promise<string> {
		const servers = this.file.read().servers
		const name = input.name.trim()
		if (servers.some((s) => s.id !== id && s.name.toLowerCase() === name.toLowerCase()))
			throw new AppFail('invalid-input', `There is already an MCP server named "${name}".`)
		const prev = id ? servers.find((s) => s.id === id) : null
		if (id && !prev) throw new AppFail('not-found', 'That MCP server no longer exists.')
		if (!prev && servers.length >= MAX_SERVERS) throw new AppFail('invalid-input', `At most ${MAX_SERVERS} MCP servers can be added.`)
		const next: StoredServer = {
			id: prev?.id ?? randomUUID(),
			name,
			transport: input.transport,
			command: input.transport === 'stdio' ? input.command.trim() : '',
			args: input.transport === 'stdio' ? input.args : [],
			url: input.transport === 'stdio' ? '' : input.url.trim(),
			envKeys: prev?.envKeys ?? [],
			headerKeys: prev?.headerKeys ?? [],
			enabled: input.enabled,
			tools: prev?.tools ?? null,
			allowed: prev?.allowed ?? null,
			lastTest: prev?.lastTest ?? null,
			origin: prev?.origin ?? origin,
			createdAt: prev?.createdAt ?? new Date().toISOString(),
		}
		// Secrets are bound to the command or URL they were entered for; carry them over when only that changes.
		let secrets: Secrets | null =
			input.env === null && input.headers === null ? null : { env: input.env ?? {}, headers: input.headers ?? {} }
		if (prev && (input.env === null || input.headers === null)) {
			const old = await this.readSecrets(prev)
			if (old) secrets = { env: input.env ?? old.env, headers: input.headers ?? old.headers }
		}
		if (secrets) {
			next.envKeys = Object.keys(secrets.env)
			next.headerKeys = Object.keys(secrets.headers)
			if (next.envKeys.length || next.headerKeys.length)
				await this.credentials.save(secretId(next.id), JSON.stringify(secrets), endpointOf(next), this.credentials.storageInfo().secure)
			else await this.credentials.remove(secretId(next.id))
		}
		if (prev && endpointOf(prev) !== endpointOf(next)) next.lastTest = null
		await this.file.update((d) => {
			const i = d.servers.findIndex((s) => s.id === next.id)
			if (i >= 0) d.servers[i] = next
			else d.servers.push(next)
		})
		this.changed()
		return next.id
	}

	async remove(id: string): Promise<void> {
		await this.credentials.remove(secretId(id))
		await this.file.update((d) => {
			d.servers = d.servers.filter((s) => s.id !== id)
		})
		this.changed()
	}

	/** Picks which tools of a server reviewers may call. `null` goes back to the read-only default. */
	async setTools(id: string, allowed: Array<string> | null): Promise<void> {
		await this.file.update((d) => {
			const s = d.servers.find((x) => x.id === id)
			if (!s) throw new AppFail('not-found', 'That MCP server no longer exists.')
			s.allowed = allowed
		})
		this.changed()
	}

	/** Connects, lists the tools and disconnects. The tool list is kept so tools can be picked without connecting again. */
	async test(id: string, cwd: string | null): Promise<void> {
		const s = this.server(id)
		const at = new Date().toISOString()
		let lastTest: StoredServer['lastTest']
		let tools: Array<StoredTool> | null = null
		try {
			const conn = await this.connect(s, cwd, AbortSignal.timeout(CONNECT_TIMEOUT_MS))
			try {
				tools = conn.tools
			} finally {
				await conn.close()
			}
			const offered = tools.filter((t) => isAllowed(s, t)).length
			lastTest = { ok: true, at, message: `${tools.length} tool${tools.length === 1 ? '' : 's'}, ${offered} offered to reviewers` }
		} catch (e) {
			lastTest = { ok: false, at, message: errorText(e) }
		}
		await this.file.update((d) => {
			const x = d.servers.find((y) => y.id === id)
			if (!x) return
			x.lastTest = lastTest
			if (tools) x.tools = tools
		})
		this.changed()
	}

	/** Servers configured for Claude Code: user scope, this repository's local scope, and the repository's .mcp.json. */
	async claudeCandidates(repoRoot: string | null): Promise<Array<McpImportCandidate>> {
		const found = await readClaudeConfig(repoRoot)
		const names = new Set(this.file.read().servers.map((s) => s.name.toLowerCase()))
		return found.map((c) => ({
			key: c.key,
			name: c.name,
			scope: c.scope,
			transport: c.transport,
			command: c.command,
			args: c.args,
			url: c.url,
			envKeys: Object.keys(c.env),
			headerKeys: Object.keys(c.headers),
			imported: names.has(c.name.toLowerCase()),
		}))
	}

	async importClaude(repoRoot: string | null, keys: Array<string>): Promise<void> {
		const found = await readClaudeConfig(repoRoot)
		for (const c of found) {
			if (!keys.includes(c.key)) continue
			if (this.file.read().servers.some((s) => s.name.toLowerCase() === c.name.toLowerCase())) continue
			await this.save(
				null,
				{
					name: c.name,
					transport: c.transport,
					command: c.command,
					args: c.args,
					url: c.url,
					env: c.env,
					headers: c.headers,
					enabled: true,
				},
				`Claude Code (${c.scope})`,
			)
		}
	}

	/**
	 * Connects every enabled server for one run and returns its allowed tools. Servers that fail are listed in
	 * `failures` and left out; the run goes on with the rest. Returns null when no server is enabled.
	 */
	async open(cwd: string | null, signal: AbortSignal): Promise<ExternalTools | null> {
		const enabled = this.file.read().servers.filter((s) => s.enabled)
		if (!enabled.length) return null
		const results = await Promise.all(
			enabled.map(async (s) => {
				try {
					const conn = await this.connect(s, cwd, AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]))
					return { s, conn, error: null }
				} catch (e) {
					return { s, conn: null, error: errorText(e) }
				}
			}),
		)
		const byName = new Map<string, { conn: Connection; tool: string; server: string }>()
		const definitions: Array<ToolDefinition> = []
		const servers: ExternalTools['servers'] = []
		const failures: Array<string> = []
		const open: Array<Connection> = []
		for (const { s, conn, error } of results) {
			if (!conn) {
				failures.push(`${s.name}: ${error}`)
				continue
			}
			open.push(conn)
			const allowed = conn.tools.filter((t) => isAllowed(s, t)).slice(0, MAX_TOOLS_PER_SERVER)
			if (!allowed.length) {
				failures.push(`${s.name}: no tools are allowed for reviewers (pick them in Settings)`)
				continue
			}
			servers.push({ name: s.name, tools: allowed.map((t) => ({ name: t.name, description: clip(t.description, 200) })) })
			for (const t of allowed) {
				const name = uniqueName(`mcp__${slug(s.name)}__${slug(t.name)}`, byName)
				byName.set(name, { conn, tool: t.name, server: s.name })
				definitions.push({
					name,
					description: clip(`[${s.name} MCP] ${t.description || t.name}`, DESCRIPTION_MAX),
					parameters: conn.schemas.get(t.name) ?? { type: 'object', properties: {} },
					strict: false,
				})
			}
		}
		if (!definitions.length) {
			await Promise.all(open.map((c) => c.close()))
			return {
				definitions: [],
				has: () => false,
				call: async () => ({ text: '', error: true }),
				label: (n) => n,
				servers: [],
				failures,
				close: async () => {},
			}
		}
		return {
			definitions,
			servers,
			failures,
			has: (name) => byName.has(name),
			label: (name) => {
				const t = byName.get(name)
				return t ? `${t.server}: ${t.tool}` : name
			},
			async call(name, args, sig): Promise<ToolResult> {
				const t = byName.get(name)
				if (!t) return { text: `There is no tool named "${name}".`, error: true }
				try {
					const r = await t.conn.client.callTool({ name: t.tool, arguments: args }, undefined, { signal: sig, timeout: CALL_TIMEOUT_MS })
					return toolText(r)
				} catch (e) {
					return { text: `The ${t.server} tool "${t.tool}" failed: ${errorText(e)}`, error: true }
				}
			},
			close: async () => {
				await Promise.all(open.map((c) => c.close()))
			},
		}
	}

	private server(id: string): StoredServer {
		const s = this.file.read().servers.find((x) => x.id === id)
		if (!s) throw new AppFail('not-found', 'That MCP server no longer exists.')
		return s
	}

	private async readSecrets(s: StoredServer): Promise<Secrets | null> {
		if (!s.envKeys.length && !s.headerKeys.length) return { env: {}, headers: {} }
		const r = await this.credentials.read(secretId(s.id), endpointOf(s))
		if (r.state !== 'saved' && r.state !== 'session') return null
		try {
			const v = JSON.parse(r.secret) as Partial<Secrets>
			return { env: v.env ?? {}, headers: v.headers ?? {} }
		} catch {
			return null
		}
	}

	private async connect(s: StoredServer, cwd: string | null, signal: AbortSignal): Promise<Connection> {
		const secrets = await this.readSecrets(s)
		if (!secrets) throw new Error('Its saved environment variables or headers could not be read. Enter them again in Settings.')
		const vars = await shellEnv()
		const x = (v: string) => expand(v, { ...vars, ...secrets.env })
		let transport: Transport
		let stderr = ''
		if (s.transport === 'stdio') {
			if (!s.command) throw new Error('No command is set.')
			const t = new StdioClientTransport({
				command: x(s.command),
				args: s.args.map(x),
				env: { ...safeEnv(vars), ...Object.fromEntries(Object.entries(secrets.env).map(([k, v]) => [k, x(v)])) },
				cwd: cwd ?? homedir(),
				stderr: 'pipe',
			})
			t.stderr?.on('data', (d: Buffer) => {
				stderr = (stderr + d.toString('utf8')).slice(-2000)
			})
			transport = t
		} else {
			let url: URL
			try {
				url = new URL(x(s.url))
			} catch {
				throw new Error(`"${s.url}" is not a valid URL.`)
			}
			if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The URL must start with https:// or http://.')
			const headers = Object.fromEntries(Object.entries(secrets.headers).map(([k, v]) => [k, x(v)]))
			transport =
				s.transport === 'sse'
					? new SSEClientTransport(url, {
							requestInit: { headers },
							eventSourceInit: {
								fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string>), ...headers } }),
							},
						})
					: new StreamableHTTPClientTransport(url, { requestInit: { headers } })
		}
		const client = new Client({ name: 'review', version: '1.0.0' })
		try {
			await client.connect(transport, { signal, timeout: CONNECT_TIMEOUT_MS })
			const tools: Array<StoredTool> = []
			const schemas = new Map<string, Record<string, unknown>>()
			let cursor: string | undefined
			do {
				const page = await client.listTools(cursor ? { cursor } : undefined, { signal, timeout: CONNECT_TIMEOUT_MS })
				for (const t of page.tools) {
					tools.push({
						name: t.name,
						description: clip(t.description ?? '', DESCRIPTION_MAX),
						readOnly: t.annotations?.readOnlyHint ?? null,
						destructive: t.annotations?.destructiveHint ?? null,
					})
					// "$schema" is not part of what Gemini accepts in a function declaration; the schema itself is passed on as is.
					const { $schema: _, ...schema } = t.inputSchema as Record<string, unknown>
					schemas.set(t.name, { ...schema, type: 'object' })
				}
				cursor = page.nextCursor
			} while (cursor && tools.length < 500)
			return { client, tools, schemas, close: () => client.close().catch(() => {}) }
		} catch (e) {
			await client.close().catch(() => {})
			const why = errorText(e)
			const tail = stderr.trim().split('\n').slice(-3).join(' ').trim()
			throw new Error(tail ? `${why} (${redactSecrets(clip(tail, 300))})` : why)
		}
	}
}

interface Connection {
	client: Client
	tools: Array<StoredTool>
	schemas: Map<string, Record<string, unknown>>
	close(): Promise<void>
}

function isAllowed(s: StoredServer, t: StoredTool): boolean {
	return s.allowed ? s.allowed.includes(t.name) : looksReadOnly(t)
}

function secretId(id: string): string {
	return `mcp:${id}`
}

function endpointOf(s: Pick<StoredServer, 'transport' | 'command' | 'url'>): string {
	return s.transport === 'stdio' ? `stdio:${s.command}` : `${s.transport}:${s.url}`
}

/** Tool names must match ^[a-zA-Z0-9_-]{1,64}$ for every provider. */
function slug(s: string): string {
	return s.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool'
}

function uniqueName(base: string, taken: Map<string, unknown>): string {
	let name = base.slice(0, 64)
	for (let i = 2; taken.has(name); i++) name = `${base.slice(0, 60)}_${i}`
	return name
}

function clip(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function errorText(e: unknown): string {
	const m = e instanceof Error ? e.message : String(e)
	if (/ENOENT/.test(m)) return 'The command was not found. Check that it is installed and on your PATH.'
	if (/abort|timed? ?out/i.test(m)) return 'It did not answer in time.'
	return redactSecrets(clip(m, 400))
}

/** MCP tool results as text for the model. Images and binary resources are named, not sent. */
function toolText(r: Awaited<ReturnType<Client['callTool']>>): ToolResult {
	const content = Array.isArray(r.content) ? (r.content as Array<Record<string, unknown>>) : []
	const parts = content.map((c) => {
		if (c.type === 'text' && typeof c.text === 'string') return c.text
		if (c.type === 'resource' && c.resource && typeof (c.resource as { text?: unknown }).text === 'string')
			return (c.resource as { text: string }).text
		if (c.type === 'resource_link' && typeof c.uri === 'string') return `[link: ${c.uri}]`
		return `[${String(c.type)} omitted]`
	})
	if (!parts.length && r.structuredContent) parts.push(JSON.stringify(r.structuredContent))
	return { text: parts.join('\n') || '(empty result)', error: r.isError === true }
}

/** `${VAR}` and `${VAR:-default}`, as Claude Code expands them in .mcp.json. */
export function expand(v: string, vars: Record<string, string | undefined>): string {
	return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, k: string, d: string | undefined) => vars[k] ?? d ?? '')
}

// What a started server inherits from the app: enough to find programs and its own config, nothing else.
const PASS_THROUGH = [
	'HOME',
	'USER',
	'LOGNAME',
	'PATH',
	'SHELL',
	'TERM',
	'TMPDIR',
	'LANG',
	'LC_ALL',
	'SYSTEMROOT',
	'APPDATA',
	'LOCALAPPDATA',
	'USERPROFILE',
	'TEMP',
	'TMP',
]

function safeEnv(vars: Record<string, string>): Record<string, string> {
	return Object.fromEntries(PASS_THROUGH.flatMap((k) => (vars[k] ? [[k, vars[k]]] : [])))
}

let shellVars: Promise<Record<string, string>> | null = null

/**
 * The variables of the user's login shell. Apps started from the Dock or Start menu do not get the PATH a terminal has
 * (nvm, Homebrew, volta), so `npx` and friends would not be found; Claude Code's configs also refer to these variables.
 */
function shellEnv(): Promise<Record<string, string>> {
	shellVars ??= new Promise((resolve) => {
		const fallback = Object.fromEntries(Object.entries(baseEnv).filter((e): e is [string, string] => typeof e[1] === 'string'))
		if (process.platform === 'win32') return resolve(fallback)
		const shell = process.env.SHELL || '/bin/zsh'
		execFile(shell, ['-ilc', 'command env -0'], { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout) => {
			if (err) return resolve(fallback)
			const vars: Record<string, string> = {}
			for (const rec of String(stdout).split('\0')) {
				const i = rec.indexOf('=')
				if (i > 0) vars[rec.slice(0, i)] = rec.slice(i + 1)
			}
			resolve(vars.PATH ? { ...fallback, ...vars } : fallback)
		})
	})
	return shellVars
}

interface ClaudeServer {
	key: string
	name: string
	scope: 'user' | 'project' | 'local'
	transport: McpTransport
	command: string
	args: Array<string>
	url: string
	env: Record<string, string>
	headers: Record<string, string>
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
	try {
		const v = JSON.parse(await readFile(path, 'utf8')) as unknown
		return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
	} catch {
		return null
	}
}

function strings(v: unknown): Record<string, string> {
	if (!v || typeof v !== 'object') return {}
	return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'))
}

function parseServers(block: unknown, scope: ClaudeServer['scope']): Array<ClaudeServer> {
	if (!block || typeof block !== 'object') return []
	return Object.entries(block as Record<string, Record<string, unknown>>).flatMap(([name, c]) => {
		if (!c || typeof c !== 'object') return []
		const type = c.type === 'http' || c.type === 'sse' ? c.type : typeof c.url === 'string' && !c.command ? 'http' : 'stdio'
		if (type === 'stdio' && typeof c.command !== 'string') return []
		if (type !== 'stdio' && typeof c.url !== 'string') return []
		return [
			{
				key: `${scope}:${name}`,
				name,
				scope,
				transport: type,
				command: type === 'stdio' ? (c.command as string) : '',
				args: type === 'stdio' && Array.isArray(c.args) ? c.args.filter((a): a is string => typeof a === 'string') : [],
				url: type === 'stdio' ? '' : (c.url as string),
				env: strings(c.env),
				headers: strings(c.headers),
			},
		]
	})
}

async function readClaudeConfig(repoRoot: string | null): Promise<Array<ClaudeServer>> {
	const user = await readJson(join(homedir(), '.claude.json'))
	const out = parseServers(user?.mcpServers, 'user')
	if (repoRoot) {
		const projects = user?.projects as Record<string, Record<string, unknown>> | undefined
		out.push(...parseServers(projects?.[repoRoot]?.mcpServers, 'local'))
		const project = await readJson(join(repoRoot, '.mcp.json'))
		out.push(...parseServers(project?.mcpServers, 'project'))
	}
	return out
}
