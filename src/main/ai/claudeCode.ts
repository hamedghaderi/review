import type { AiUsage } from '../../shared/types.ts'
import { MODEL_CATALOG } from './catalog.ts'
import { runCli, type CliOutput } from './cliProcess.ts'
import {
	clip,
	maxRounds,
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
import { startToolServer, type ToolServer } from './toolServer.ts'

export interface ClaudeCodeOptions {
	command: string // "claude", found on the login shell's PATH, or a full path
	timeoutMs: number
}

const LABEL = 'Claude Code'

// Claude Code as a plain model: no built-in tools (it must not read or change the repository), none of the user's MCP
// servers, and no saved session. No settings files either, which leaves out the user's hooks, plugins and CLAUDE.md.
// Not --safe-mode, which does the same but also drops the --mcp-config server the lookups come from.
const ISOLATION = ['--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence']

/** Checks Claude Code is installed and signed in with a Claude plan, then offers the models a plan includes. */
export function createClaudeCodeAccount(o: ClaudeCodeOptions): ProviderAccount {
	return {
		async listModels(signal): Promise<Array<DiscoveredModel>> {
			const { stdout } = await run(o, ['auth', 'status', '--json'], '', signal)
			let status: { loggedIn?: unknown; authMethod?: unknown; apiProvider?: unknown }
			try {
				status = JSON.parse(stdout)
			} catch {
				throw new ProviderError('unsupported', `${LABEL} did not report its sign-in status. Update Claude Code and test again.`)
			}
			if (status.loggedIn !== true)
				throw new ProviderError('auth', `${LABEL} is not signed in. Run “claude auth login” in a terminal, then test again.`)
			// Only a plan is free to Review; an API key or a cloud provider bills per token, which Review would not count.
			if (/api.?key|console/i.test(String(status.authMethod ?? '')) || (status.apiProvider && status.apiProvider !== 'firstParty'))
				throw new ProviderError(
					'auth',
					`${LABEL} is signed in with an API key or a cloud provider, not a Claude plan. Use the Anthropic connection for API keys, or run “claude auth login” with your Claude account.`,
				)
			return (MODEL_CATALOG['claude-code'] ?? []).map((m) => ({
				id: m.id,
				label: m.label,
				contextWindow: m.contextWindow,
				maxOutputTokens: m.maxOutputTokens,
				structuredOutput: 'yes',
			}))
		},
	}
}

export function createClaudeCodeProvider(o: ClaudeCodeOptions & { model: string; limits: ModelLimits }): ReviewProvider {
	return {
		id: 'claude-code',
		label: LABEL,
		protocol: 'claude-cli',
		model: o.model,
		fixture: false,
		limits: o.limits,
		async review(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse> {
			// The runner sends the request again without them, once per reviewer, and says so.
			if (request.images?.length) throw new ProviderError('unsupported', `${LABEL} connections don't send images yet`)
			// Lookups are served to Claude Code over MCP for this request only, and are the only tools it is allowed.
			let server: ToolServer | null = null
			try {
				if (request.tools) server = await startToolServer(request.tools, signal)
				const args = [
					'-p',
					'--output-format',
					'json',
					'--model',
					o.model,
					...ISOLATION,
					...(server
						? [
								'--mcp-config',
								server.configPath,
								'--allowedTools',
								server.toolNames.join(','),
								'--max-turns',
								String(maxRounds(request.tools) + 2),
							]
						: []),
					'--system-prompt',
					request.instructions,
					'--json-schema',
					JSON.stringify(request.schema?.json ?? REVIEW_JSON_SCHEMA),
				]
				const { stdout, stderr, code } = await run(o, args, request.input, signal)
				return interpretResult(stdout, stderr, code, o.model)
			} finally {
				await server?.close()
			}
		},
	}
}

interface CliResult {
	type?: string
	subtype?: string
	is_error?: boolean
	api_error_status?: number | null
	result?: string
	structured_output?: unknown
	usage?: {
		input_tokens?: number
		cache_read_input_tokens?: number
		cache_creation_input_tokens?: number
		output_tokens?: number
		output_tokens_details?: { thinking_tokens?: number }
	}
}

/** Reads `claude -p --output-format json`: one result object, or an error in it, on stderr, or in the exit code. */
export function interpretResult(stdout: string, stderr: string, code: number | null, model: string): ProviderResponse {
	let r: CliResult | null = null
	try {
		r = JSON.parse(stdout) as CliResult
	} catch {
		// Errors before the session starts (bad flags, unknown model) are printed as text.
	}
	if (!r || r.type !== 'result') {
		const text = (stderr.trim() || stdout.trim() || `exited with code ${code}`).replace(/\s+/g, ' ')
		throw classify(text, null, model)
	}
	if (r.subtype === 'error_max_turns') throw new ProviderError('incomplete', `${LABEL} used up its turns before answering`)
	if (r.is_error || r.subtype !== 'success') throw classify(r.result ?? r.subtype ?? 'unknown error', r.api_error_status ?? null, model)
	const usage = usageOf(r)
	if (r.structured_output !== undefined && r.structured_output !== null) return { output: r.structured_output, usage }
	if (!r.result?.trim()) throw new ProviderError('invalid-output', 'The response contained no output text')
	return { output: parseJson(r.result), usage }
}

function usageOf(r: CliResult): AiUsage | null {
	const u = r.usage
	if (!u) return null
	return {
		inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
		cachedInputTokens: u.cache_read_input_tokens ?? 0,
		cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
		outputTokens: u.output_tokens ?? 0,
		reasoningTokens: u.output_tokens_details?.thinking_tokens ?? 0,
		totalTokens: 0,
	}
}

function classify(message: string, status: number | null, model: string): ProviderError {
	const m = clip(message)
	if (status === 401 || /not (signed|logged) in|\/login|invalid api key|authenticat/i.test(m))
		return new ProviderError('auth', `${LABEL} is not signed in. Run “claude auth login” in a terminal, then test again.`)
	if (status === 403) return new ProviderError('permission', `${LABEL} was denied access: ${m}`)
	const quota = planLimit(message)
	if (quota) return quota
	if (status === 429 || status === 529 || /rate limit|overloaded/i.test(m)) return new ProviderError('rate-limit', `${LABEL}: ${m}`)
	if (/prompt is too long|context window|too many tokens/i.test(m)) return new ProviderError('context-exceeded', `${LABEL}: ${m}`)
	if (status === 404 || (/model/i.test(m) && /not found|invalid|not available|does not exist/i.test(m)))
		return new ProviderError('model-unavailable', `Model "${model}" is not available in ${LABEL}: ${m}`)
	if (status !== null && status >= 500) return new ProviderError('server', `${LABEL} server error (${status})`)
	if (status !== null && status >= 400) return new ProviderError('bad-request', `${LABEL} rejected the request (${status}): ${m}`)
	return new ProviderError('server', `${LABEL} failed: ${m}`)
}

/**
 * The plan's usage limit, as Claude Code words it ("You've hit your limit · resets 6pm (Europe/Amsterdam)", "Claude AI
 * usage limit reached|1761152400", "Out of usage credits"). Null for anything else, such as a brief rate limit, which a
 * retry gets past. The reset time is quoted as Claude Code wrote it; only the epoch form gives the exact wait.
 */
export function planLimit(message: string, now = Date.now()): ProviderError | null {
	if (!/hit your .{0,20}limit|usage limit|limit reached|out of usage credits/i.test(message)) return null
	const epoch = /\|(\d{9,11})\b/.exec(message)
	if (epoch) {
		const at = new Date(Number(epoch[1]) * 1000)
		const day = at.toDateString() === new Date(now).toDateString() ? '' : ` on ${at.toLocaleDateString([], { weekday: 'long' })}`
		const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
		return new ProviderError('quota', quotaMessage(`at ${time}${day}`), Math.max(0, at.getTime() - now))
	}
	const resets = /resets\s+((?:at|in)\s+)?([^·∙\n]+?)\s*(?:[·∙]|$)/i.exec(message)
	return new ProviderError('quota', quotaMessage(resets ? `${resets[1] ?? ''}${resets[2]}`.trim() : null))
}

function quotaMessage(resets: string | null): string {
	return `Your Claude plan’s usage limit is reached${resets ? `; it resets ${resets}` : ''}. Requests to ${LABEL} stop until then.`
}

function run(o: ClaudeCodeOptions, args: Array<string>, input: string, signal: AbortSignal): Promise<CliOutput> {
	const env = (vars: Record<string, string>): Record<string, string> =>
		vars.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: vars.CLAUDE_CONFIG_DIR } : {}
	return runCli({ label: LABEL, command: o.command, timeoutMs: o.timeoutMs, env }, args, input, signal)
}
