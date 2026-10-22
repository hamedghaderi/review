import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import type { AiUsage } from '../../shared/types.ts'
import { MODEL_CATALOG } from './catalog.ts'
import { safeEnv, shellEnv } from './mcp.ts'
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

export interface ClaudeCodeOptions {
	command: string // "claude", found on the login shell's PATH, or a full path
	timeoutMs: number
}

const LABEL = 'Claude Code'

// Claude Code as a plain model: no built-in tools (it must not read or change the repository), none of the user's MCP
// servers, hooks, CLAUDE.md, skills or plugins, and no saved session.
const ISOLATION = ['--tools', '', '--strict-mcp-config', '--safe-mode', '--disable-slash-commands', '--no-session-persistence']

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
			const args = [
				'-p',
				'--output-format',
				'json',
				'--model',
				o.model,
				...ISOLATION,
				'--system-prompt',
				request.instructions,
				'--json-schema',
				JSON.stringify(request.schema?.json ?? REVIEW_JSON_SCHEMA),
			]
			const { stdout, stderr, code } = await run(o, args, request.input, signal)
			const response = interpretResult(stdout, stderr, code, o.model)
			// Lookups need Review's tools served to Claude Code over MCP, which comes later (#103).
			return request.tools ? { ...response, toolsRejected: `${LABEL} connections don't offer lookups yet` } : response
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
	if (status === 429 || status === 529 || /usage limit|rate limit|overloaded/i.test(m))
		return new ProviderError('rate-limit', `${LABEL}: ${m}`)
	if (/prompt is too long|context window|too many tokens/i.test(m)) return new ProviderError('context-exceeded', `${LABEL}: ${m}`)
	if (status === 404 || (/model/i.test(m) && /not found|invalid|not available|does not exist/i.test(m)))
		return new ProviderError('model-unavailable', `Model "${model}" is not available in ${LABEL}: ${m}`)
	if (status !== null && status >= 500) return new ProviderError('server', `${LABEL} server error (${status})`)
	if (status !== null && status >= 400) return new ProviderError('bad-request', `${LABEL} rejected the request (${status}): ${m}`)
	return new ProviderError('server', `${LABEL} failed: ${m}`)
}

/**
 * Runs the CLI with the login shell's PATH (an app opened from the Dock has a bare one) and only the variables a
 * program needs to find itself and its config: no ANTHROPIC_API_KEY, which would bill the key instead of the plan.
 */
async function run(
	o: ClaudeCodeOptions,
	args: Array<string>,
	input: string,
	signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	const vars = await shellEnv()
	const env = { ...safeEnv(vars), ...(vars.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: vars.CLAUDE_CONFIG_DIR } : {}) }
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(new ProviderError('cancelled', 'Request cancelled'))
		// An empty working directory: nothing of the reviewed repository for Claude Code to pick up.
		const child = spawn(o.command, args, { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
		const out: Array<Buffer> = []
		const err: Array<Buffer> = []
		let settled = false
		const finish = (fn: () => void): void => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			signal.removeEventListener('abort', abort)
			fn()
		}
		const abort = (): void => {
			child.kill()
			finish(() => reject(new ProviderError('cancelled', 'Request cancelled')))
		}
		const timer = setTimeout(() => {
			child.kill()
			finish(() => reject(new ProviderError('timeout', `${LABEL} did not respond before the timeout`)))
		}, o.timeoutMs)
		signal.addEventListener('abort', abort, { once: true })
		child.stdout.on('data', (b: Buffer) => out.push(b))
		child.stderr.on('data', (b: Buffer) => err.push(b))
		child.on('error', (e: NodeJS.ErrnoException) =>
			finish(() =>
				reject(
					e.code === 'ENOENT'
						? new ProviderError(
								'unsupported',
								`${LABEL} was not found (“${o.command}”). Install it, or set the full path to “claude” in Settings → AI providers.`,
							)
						: new ProviderError('network', `Could not start ${LABEL}: ${clip(e.message)}`),
				),
			),
		)
		child.on('close', (code) =>
			finish(() => resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code })),
		)
		// A closed pipe (the CLI exited early) surfaces through "close" with the CLI's own message.
		child.stdin.on('error', () => {})
		child.stdin.end(input)
	})
}
