import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { safeEnv, shellEnv } from './mcp.ts'
import { clip, ProviderError } from './provider.ts'

export interface CliProgram {
	label: string // "Claude Code", for messages
	command: string // a name found on the login shell's PATH, or a full path
	timeoutMs: number
	/** Variables the CLI needs beyond the usual few, from the login shell (its config folder) or set by the caller. */
	env?: (shell: Record<string, string>) => Record<string, string>
}

export interface CliOutput {
	stdout: string
	stderr: string
	code: number | null
}

/**
 * Runs a CLI once with `input` on stdin, from an empty working directory so nothing of the reviewed repository is there
 * for it to pick up. It gets the login shell's PATH (an app opened from the Dock has a bare one) and only the variables
 * a program needs to find itself and its config: no provider API keys, which would bill the key instead of the plan.
 */
export async function runCli(p: CliProgram, args: Array<string>, input: string, signal: AbortSignal): Promise<CliOutput> {
	const vars = await shellEnv()
	const env = { ...safeEnv(vars), ...(p.env?.(vars) ?? {}) }
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(new ProviderError('cancelled', 'Request cancelled'))
		const child = spawn(p.command, args, { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
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
			finish(() => reject(new ProviderError('timeout', `${p.label} did not respond before the timeout`)))
		}, p.timeoutMs)
		signal.addEventListener('abort', abort, { once: true })
		child.stdout.on('data', (b: Buffer) => out.push(b))
		child.stderr.on('data', (b: Buffer) => err.push(b))
		child.on('error', (e: NodeJS.ErrnoException) =>
			finish(() =>
				reject(
					e.code === 'ENOENT'
						? new ProviderError(
								'unsupported',
								`${p.label} was not found (“${p.command}”). Install it, or set the full path to it in Settings → AI review → Providers.`,
							)
						: new ProviderError('network', `Could not start ${p.label}: ${clip(e.message)}`),
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
