import { git } from '../git.ts'
import type { AiLookups, RiskLevel } from '../../shared/types.ts'

/**
 * Read-only lookups the reviewer can make while it reviews one request: read a file, search the repository, list a
 * folder. They read the two commits under review from Git's object database, never the working tree, so uncommitted
 * files and anything outside the repository are out of reach. Every request gets its own budget of calls and
 * characters; once it is used up the provider asks for the final answer without tools.
 */
export interface ToolDefinition {
	name: string
	description: string
	parameters: Record<string, unknown> // JSON Schema; every property required and no extras, as strict modes need
	strict?: boolean // false for schemas the app does not control (MCP tools), which strict modes would reject
}

/**
 * Tools from MCP servers, offered next to the built-in lookups for one run. Calls go through the same per-request budget
 * and result clipping as the lookups.
 */
export interface ExternalTools {
	definitions: Array<ToolDefinition>
	has(name: string): boolean
	call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>
	label(name: string): string // "server: tool", for the run's record
	servers: Array<{ name: string; tools: Array<{ name: string; description: string }> }>
	failures: Array<string>
	close(): Promise<void>
}

export interface ToolResult {
	text: string
	error: boolean
}

export interface ReviewTools {
	definitions: Array<ToolDefinition>
	call(name: string, args: unknown, signal: AbortSignal): Promise<ToolResult>
	/** True once the calls or characters for this request are used up. */
	exhausted(): boolean
	log: LookupLog
}

export interface LookupLog {
	calls: number
	chars: number
	refused: number // calls made after the budget was used up, or with invalid arguments
	paths: Array<string> // files read and folders listed, in order, without repeats
	searches: Array<string>
	external: Array<string> // MCP tools called, as "server: tool", without repeats
}

export interface LookupBudget {
	maxCalls: number
	maxChars: number
}

export const LOOKUP_DEFAULTS = { maxCalls: 12, maxChars: 60_000 }
// A request's lookups follow the riskiest file it carries: the full budget for high risk, less for the rest.
export const LOOKUPS_BY_RISK: Record<RiskLevel, LookupBudget> = {
	high: LOOKUP_DEFAULTS,
	medium: { maxCalls: 8, maxChars: 40_000 },
	low: { maxCalls: 4, maxChars: 20_000 },
}
// Share of a request's input kept free for lookups when the model's context window is what limits the request size.
export const LOOKUP_RESERVE = 0.3

const RESULT_MAX_CHARS = 16_000
const READ_MAX_LINES = 400
const SEARCH_MAX_HITS = 60
const LIST_MAX_ENTRIES = 300
const FILE_LIMIT = 4 * 1024 * 1024
const GREP_LIMIT = 4 * 1024 * 1024

export const TOOL_DEFINITIONS: Array<ToolDefinition> = [
	{
		name: 'read_file',
		description:
			'Read lines of a file from the repository at the head commit (the change applied) or the base commit (before the change). Returns numbered lines. Use it to see the rest of a function an excerpt cuts off, code the change calls, or tests for the changed code.',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Path from the repository root, e.g. "src/app/cart.ts".' },
				version: { type: 'string', enum: ['head', 'base'], description: '"head" for the version with the change, "base" for before it.' },
				start_line: { type: ['integer', 'null'], description: 'First line to read (1-based), or null for the start of the file.' },
				end_line: {
					type: ['integer', 'null'],
					description: `Last line to read, or null. At most ${READ_MAX_LINES} lines are returned per call.`,
				},
			},
			required: ['path', 'version', 'start_line', 'end_line'],
			additionalProperties: false,
		},
	},
	{
		name: 'search_code',
		description:
			'Search the repository at the head commit for an exact piece of text (not a regular expression, case-sensitive). Returns matching lines as "path:line: text". Use it to find where a name is defined or used. A match can be a different thing with the same name.',
		parameters: {
			type: 'object',
			properties: {
				text: { type: 'string', description: 'The exact text to find, e.g. a function name.' },
				path_prefix: {
					type: ['string', 'null'],
					description: 'Only search under this folder, e.g. "src/billing/", or null for everywhere.',
				},
			},
			required: ['text', 'path_prefix'],
			additionalProperties: false,
		},
	},
	{
		name: 'list_files',
		description: 'List the files and folders directly inside a folder of the repository at the head commit. Folders end with "/".',
		parameters: {
			type: 'object',
			properties: { directory: { type: 'string', description: 'Folder path from the repository root, or "" for the root.' } },
			required: ['directory'],
			additionalProperties: false,
		},
	},
]

export function createReviewTools(
	repo: { root: string; baseSha: string; headSha: string },
	budget: LookupBudget,
	external: ExternalTools | null = null,
): ReviewTools {
	const log: LookupLog = { calls: 0, chars: 0, refused: 0, paths: [], searches: [], external: [] }
	let full = false // a result was cut to fit the request's characters
	const exhausted = (): boolean => full || log.calls >= budget.maxCalls || log.chars >= budget.maxChars
	const seen = (list: Array<string>, item: string): void => {
		if (!list.includes(item)) list.push(item)
	}
	const refuse = (text: string): ToolResult => {
		log.refused++
		return { text, error: true }
	}

	async function run(name: string, a: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
		switch (name) {
			case 'read_file': {
				const path = cleanPath(a.path)
				if (path === null || !path) return refuse('"path" must be a file path from the repository root, without ".." parts.')
				const sha = a.version === 'base' ? repo.baseSha : repo.headSha
				const r = await git(repo.root, ['cat-file', 'blob', `${sha}:${path}`], FILE_LIMIT, { signal })
				if (r.code !== 0) return refuse(`No file "${path}" at the ${a.version === 'base' ? 'base' : 'head'} commit.`)
				if (r.truncated) return refuse(`"${path}" is larger than ${FILE_LIMIT / 1024 / 1024} MB and cannot be read.`)
				if (r.stdout.subarray(0, 8000).includes(0)) return refuse(`"${path}" is a binary file.`)
				seen(log.paths, path)
				const lines = r.stdout.toString('utf8').split('\n')
				if (lines.at(-1) === '') lines.pop()
				const from = Math.max(1, int(a.start_line) ?? 1)
				const to = Math.min(lines.length, int(a.end_line) ?? lines.length, from + READ_MAX_LINES - 1)
				if (from > lines.length) return { text: `"${path}" has ${lines.length} lines.`, error: false }
				const width = String(to).length
				const body = lines
					.slice(from - 1, to)
					.map((l, i) => `${String(from + i).padStart(width)} | ${l.endsWith('\r') ? l.slice(0, -1) : l}`)
					.join('\n')
				const more = to < lines.length ? `\n(lines ${to + 1}-${lines.length} not shown)` : ''
				return {
					text: `${path} (${a.version === 'base' ? 'base' : 'head'}), lines ${from}-${to} of ${lines.length}:\n${body}${more}`,
					error: false,
				}
			}
			case 'search_code': {
				const text = typeof a.text === 'string' ? a.text : ''
				if (text.trim().length < 2 || text.length > 200 || text.includes('\n'))
					return refuse('"text" must be 2 to 200 characters on one line.')
				const prefix = a.path_prefix === null || a.path_prefix === undefined ? '' : cleanPath(a.path_prefix)
				if (prefix === null) return refuse('"path_prefix" must be a folder path from the repository root, without ".." parts.')
				seen(log.searches, prefix ? `${text} (in ${prefix})` : text)
				const r = await git(
					repo.root,
					['grep', '-n', '-I', '-F', '-z', '--no-color', '-e', text, repo.headSha, '--', ...(prefix ? [prefix] : [])],
					GREP_LIMIT,
					{ signal, timeoutMs: 20_000 },
				)
				if (r.code > 1 && !r.truncated) return refuse(`The search failed: ${r.stderr.trim().slice(0, 200)}`)
				const at = `${repo.headSha}:`
				const hits = r.stdout
					.toString('utf8')
					.split('\n')
					.flatMap((rec) => {
						const [loc, no, line] = rec.split('\0')
						return loc?.startsWith(at) && line !== undefined ? [`${loc.slice(at.length)}:${no}: ${clip(line.trim(), 200)}`] : []
					})
				if (!hits.length) return { text: `No matches for "${text}"${prefix ? ` under ${prefix}` : ''}.`, error: false }
				const shown = hits.slice(0, SEARCH_MAX_HITS)
				const more = hits.length > shown.length || r.truncated ? `\n(more matches not shown; narrow the search with path_prefix)` : ''
				return { text: `${hits.length}${r.truncated ? '+' : ''} matches for "${text}":\n${shown.join('\n')}${more}`, error: false }
			}
			case 'list_files': {
				const dir = cleanPath(a.directory ?? '')
				if (dir === null) return refuse('"directory" must be a folder path from the repository root, without ".." parts.')
				const r = await git(repo.root, ['ls-tree', '-z', `${repo.headSha}:${dir}`], 1024 * 1024, { signal })
				if (r.code !== 0) return refuse(`No folder "${dir}" at the head commit.`)
				seen(log.paths, `${dir || '.'}/`)
				const entries = r.stdout
					.toString('utf8')
					.split('\0')
					.flatMap((rec) => {
						const m = /^\d+ (\w+) [0-9a-f]+\t(.*)$/s.exec(rec)
						return m ? [m[1] === 'tree' ? `${m[2]}/` : m[2]] : []
					})
				const shown = entries.slice(0, LIST_MAX_ENTRIES)
				const more = entries.length > shown.length ? `\n(${entries.length - shown.length} more not shown)` : ''
				return { text: `${dir || '(root)'}:\n${shown.join('\n')}${more}`, error: false }
			}
			default:
				if (external?.has(name)) {
					seen(log.external, external.label(name))
					return external.call(name, a, signal)
				}
				return refuse(`There is no tool named "${name}". Use read_file, search_code or list_files.`)
		}
	}

	return {
		definitions: external ? [...TOOL_DEFINITIONS, ...external.definitions] : TOOL_DEFINITIONS,
		log,
		exhausted,
		async call(name, args, signal) {
			if (exhausted()) return refuse('The lookup limit for this request is used up. Answer with what you have.')
			log.calls++
			const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
			const result = await run(name, a, signal)
			const left = budget.maxChars - log.chars
			const room = Math.max(0, Math.min(RESULT_MAX_CHARS, left))
			let text = result.text
			if (text.length > room) {
				full = room === left
				const why = full ? 'the lookup limit for this request was reached' : 'read a smaller range or narrow the search'
				text = `${text.slice(0, Math.max(0, room - 80))}\n… (cut: ${why})`
			}
			log.chars += text.length
			return { text, error: result.error }
		},
	}
}

/** Adds one request's lookups to the run's totals. */
export function addLookups(total: AiLookups, log: LookupLog): void {
	total.requests++
	total.calls += log.calls
	total.chars += log.chars
	total.refused += log.refused
	for (const p of log.paths) if (!total.paths.includes(p) && total.paths.length < 40) total.paths.push(p)
	for (const s of log.searches) if (!total.searches.includes(s) && total.searches.length < 40) total.searches.push(s)
	if (log.external.length) {
		total.external ??= []
		for (const e of log.external) if (!total.external.includes(e) && total.external.length < 40) total.external.push(e)
	}
}

export function emptyLookups(): AiLookups {
	return { requests: 0, calls: 0, chars: 0, refused: 0, paths: [], searches: [], unavailable: null }
}

/** A repository-relative path, or null when it is not one (absolute, "..", or not a string). Trailing slashes are dropped. */
function cleanPath(v: unknown): string | null {
	if (typeof v !== 'string' || v.length > 500 || v.includes('\0')) return null
	const p = v.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
	if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').some((s) => s === '..')) return null
	return p === '.' ? '' : p
}

function int(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : null
}

function clip(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s
}
