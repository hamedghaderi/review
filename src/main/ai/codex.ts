import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import semver from 'semver'
import type { AiUsage } from '../../shared/types.ts'
import { MODEL_CATALOG } from './catalog.ts'
import { runCli, type CliOutput } from './cliProcess.ts'
import {
	clip,
	parseJson,
	ProviderError,
	type DiscoveredModel,
	type ModelLimits,
	type ProviderAccount,
	type ProviderRequest,
	type ProviderResponse,
	type ReviewProvider,
} from './provider.ts'
import { REVIEW_JSON_SCHEMA } from './schema.ts'
import { startToolServer, TOOL_SERVER_NAME, type ToolServer } from './toolServer.ts'

export interface CodexOptions {
	command: string // "codex", found on the login shell's PATH, or a full path
	timeoutMs: number
}

const LABEL = 'Codex'

/** Older versions can't use the current models with a ChatGPT login, and lack the switches that keep Codex isolated. */
export const MIN_CODEX = '0.163.0'

// Everything that would let Codex run commands, read or change files, browse, spawn agents or load the user's plugins,
// hooks and skills. Its models reach tools only through code mode, so the code-mode host stays on: its runtime has no
// file, process or network access, and the read-only sandbox refuses apply_patch.
const DISABLE = [
	'shell_tool',
	'unified_exec',
	'unified_exec_tty',
	'shell_snapshot',
	'apps',
	'browser_use',
	'browser_use_external',
	'browser_use_full_cdp_access',
	'computer_use',
	'in_app_browser',
	'in_app_local_automation',
	'image_generation',
	'view_image',
	'multi_agent',
	'collaboration_modes',
	'plugins',
	'remote_plugin',
	'hooks',
	'tool_suggest',
	'skill_search',
	'skill_mcp_dependency_install',
	'workspace_dependencies',
	'goals',
	'sleep_tool',
	'worktrees',
]
// Without these off, Codex could run commands; a version that doesn't list them is not run at all.
const REQUIRED_OFF = ['shell_tool', 'unified_exec']

const ISOLATION = [
	'--json',
	'--ephemeral',
	'--skip-git-repo-check',
	'--ignore-user-config', // the user's MCP servers, model and settings
	'--ignore-rules',
	'--sandbox',
	'read-only',
	'-c',
	'project_doc_max_bytes=0', // no AGENTS.md from the working directory
	'-c',
	'agents.enabled=false',
	'-c',
	'history.persistence="none"',
	'-c',
	'web_search="disabled"',
]

/** Checks Codex is new enough and signed in with ChatGPT, then offers the models a ChatGPT plan includes. */
export function createCodexAccount(o: CodexOptions): ProviderAccount {
	return {
		async listModels(signal): Promise<Array<DiscoveredModel>> {
			const version = /(\d+\.\d+\.\d+)/.exec((await run(o, ['--version'], '', signal)).stdout)?.[1]
			if (!version || semver.lt(version, MIN_CODEX))
				throw new ProviderError(
					'unsupported',
					`${LABEL} ${version ?? '(unknown version)'} is too old: Review needs ${MIN_CODEX} or later. Update it (npm install -g @openai/codex), then test again.`,
				)
			await features(o, signal) // fails here, not in a review, if the isolation switches are missing
			const status = await run(o, ['login', 'status'], '', signal)
			const text = `${status.stdout}\n${status.stderr}`
			if (!/logged in using chatgpt/i.test(text)) {
				// An API key bills per token, which Review would show as free.
				if (/api key/i.test(text))
					throw new ProviderError(
						'auth',
						`${LABEL} is signed in with an API key, not a ChatGPT plan. Use the OpenAI connection for API keys, or run “codex login” with your ChatGPT account.`,
					)
				throw new ProviderError('auth', `${LABEL} is not signed in. Run “codex login” in a terminal, then test again.`)
			}
			return (MODEL_CATALOG.codex ?? []).map((m) => ({
				id: m.id,
				label: m.label,
				contextWindow: m.contextWindow,
				maxOutputTokens: m.maxOutputTokens,
				structuredOutput: 'yes',
			}))
		},
	}
}

export function createCodexProvider(o: CodexOptions & { model: string; limits: ModelLimits }): ReviewProvider {
	return {
		id: 'codex',
		label: LABEL,
		protocol: 'codex-cli',
		model: o.model,
		fixture: false,
		limits: o.limits,
		async review(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse> {
			// The runner sends the request again without them, once per reviewer, and says so.
			if (request.images?.length) throw new ProviderError('unsupported', `${LABEL} connections don't send images yet`)
			const off = await features(o, signal)
			// Codex has no system-prompt flag: the instructions replace its own, from a file, as does the schema.
			const dir = await mkdtemp(join(tmpdir(), 'review-codex-'))
			let server: ToolServer | null = null
			try {
				const instructions = join(dir, 'instructions.md')
				const schema = join(dir, 'schema.json')
				await writeFile(instructions, request.instructions, { mode: 0o600 })
				await writeFile(schema, JSON.stringify(request.schema?.json ?? REVIEW_JSON_SCHEMA), { mode: 0o600 })
				if (request.tools) server = await startToolServer(request.tools, signal)
				const mcp = server
					? [
							['url', JSON.stringify(server.url)],
							['bearer_token_env_var', '"REVIEW_MCP_TOKEN"'],
							['enabled_tools', JSON.stringify(server.names)],
							['required', 'true'],
						].flatMap(([k, v]) => ['-c', `mcp_servers.${TOOL_SERVER_NAME}.${k}=${v}`])
					: []
				const args = [
					'exec',
					...ISOLATION,
					...off.flatMap((f) => ['--disable', f]),
					'-c',
					`model_instructions_file=${JSON.stringify(instructions)}`,
					...mcp,
					'--model',
					o.model,
					'--output-schema',
					schema,
					'-', // the prompt, from stdin
				]
				const token = server?.token
				const out = await run(o, args, request.input, signal, token ? { REVIEW_MCP_TOKEN: token } : {})
				return interpretEvents(out, o.model)
			} finally {
				await server?.close()
				await rm(dir, { recursive: true, force: true })
			}
		},
	}
}

interface CodexEvent {
	type?: string
	message?: string
	error?: { message?: string }
	item?: { type?: string; text?: string; message?: string }
	usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number }
}

/** Reads `codex exec --json`: one event per line; the answer is the last agent message of a completed turn. */
export function interpretEvents(out: CliOutput, model: string): ProviderResponse {
	const events = out.stdout.split('\n').flatMap((l): Array<CodexEvent> => {
		try {
			const e = JSON.parse(l)
			return e && typeof e === 'object' ? [e] : []
		} catch {
			return []
		}
	})
	const failed = events.findLast((e) => e.type === 'turn.failed')
	const done = events.findLast((e) => e.type === 'turn.completed')
	if (failed || !done) {
		// Codex reports settings it ignored as "error" events too; the one that ended the turn is the last.
		const why =
			failed?.error?.message ?? events.findLast((e) => e.type === 'error')?.message ?? (out.stderr.trim() || `exited with code ${out.code}`)
		throw classify(why, model)
	}
	const answer = events.findLast((e) => e.type === 'item.completed' && e.item?.type === 'agent_message')?.item?.text
	const u = done.usage
	const usage: AiUsage | null = u
		? {
				inputTokens: u.input_tokens ?? 0,
				cachedInputTokens: u.cached_input_tokens ?? 0,
				outputTokens: u.output_tokens ?? 0,
				reasoningTokens: u.reasoning_output_tokens ?? 0,
				totalTokens: 0,
			}
		: null
	if (!answer?.trim()) throw new ProviderError('invalid-output', 'The response contained no output text')
	return { output: parseJson(answer), usage }
}

/** Codex wraps API errors as JSON in the message: `{"type":"error","status":400,"error":{"message":"…"}}`. */
function classify(raw: string, model: string): ProviderError {
	let status: number | null = null
	let message = raw
	try {
		const j = JSON.parse(raw) as { status?: number; error?: { message?: string } }
		status = typeof j.status === 'number' ? j.status : null
		message = j.error?.message ?? raw
	} catch {
		// plain text
	}
	const m = clip(message.replace(/\s+/g, ' '))
	const quota = planLimit(m)
	if (quota) return quota
	if (status === 401 || /not logged in|unauthori[sz]ed|refresh token|sign in again/i.test(m))
		return new ProviderError('auth', `${LABEL} is not signed in. Run “codex login” in a terminal, then test again.`)
	if (/model/i.test(m) && /not supported|not found|does not exist|not available/i.test(m))
		return new ProviderError('model-unavailable', `Model "${model}" is not available in ${LABEL}: ${m}`)
	if (/context window|too many tokens|maximum context|too long/i.test(m)) return new ProviderError('context-exceeded', `${LABEL}: ${m}`)
	if (status === 429 || /rate limit|overloaded|server_overloaded/i.test(m)) return new ProviderError('rate-limit', `${LABEL}: ${m}`)
	if (status === 403) return new ProviderError('permission', `${LABEL} was denied access: ${m}`)
	if (status !== null && status >= 400 && status < 500)
		return new ProviderError('bad-request', `${LABEL} rejected the request (${status}): ${m}`)
	return new ProviderError('server', `${LABEL} failed: ${m}`)
}

/**
 * The ChatGPT plan's usage limit, as Codex words it ("You've hit your usage limit. … try again at 6:05 PM."), or a
 * workspace out of credits or over its spend cap. The time is quoted as Codex wrote it; the wait isn't guessed.
 */
export function planLimit(message: string): ProviderError | null {
	if (!/usage limit|usage_limit_reached|quota_exceeded|out of credits|credits_depleted|spend cap/i.test(message)) return null
	const at = /try again (at|in) ([^.]+?)\s*(?:\.|$)/i.exec(message)
	const when = at ? `; try again ${at[1]} ${at[2]}` : ''
	return new ProviderError('quota', `Your ChatGPT plan’s usage limit is reached${when}. Requests to ${LABEL} stop until then.`)
}

// The features to switch off, by program: only those this version knows, since unknown names are an error.
const known = new Map<string, Promise<Array<string>>>()

function features(o: CodexOptions, signal: AbortSignal): Promise<Array<string>> {
	let p = known.get(o.command)
	if (!p) {
		p = run(o, ['features', 'list'], '', signal).then((out) => {
			const listed = new Set(
				out.stdout
					.split('\n')
					.map((l) => l.trim().split(/\s+/))
					.filter((cols) => cols.length >= 2 && !/removed/.test(cols.slice(1).join(' ')))
					.map((cols) => cols[0]),
			)
			if (!REQUIRED_OFF.every((f) => listed.has(f)))
				throw new ProviderError(
					'unsupported',
					`This ${LABEL} version doesn't let Review switch off its shell (${REQUIRED_OFF.join(', ')}), so it isn't run.`,
				)
			return DISABLE.filter((f) => listed.has(f))
		})
		known.set(o.command, p)
		p.catch(() => known.delete(o.command)) // a failure (not installed yet, say) is asked again next time
	}
	return p
}

function run(
	o: CodexOptions,
	args: Array<string>,
	input: string,
	signal: AbortSignal,
	extra: Record<string, string> = {},
): Promise<CliOutput> {
	// CODEX_HOME holds its sign-in; without it Codex uses ~/.codex.
	const env = (vars: Record<string, string>): Record<string, string> => ({
		...(vars.CODEX_HOME ? { CODEX_HOME: vars.CODEX_HOME } : {}),
		...extra,
	})
	return runCli({ label: LABEL, command: o.command, timeoutMs: o.timeoutMs, env }, args, input, signal)
}
