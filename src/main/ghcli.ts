import { execFile } from 'node:child_process'
import { env } from './git.ts'

/** Reads the token the GitHub CLI (`gh`) is logged in with. Never stored by this app; asked for on demand. */
export interface CliTokenSource {
	/** Whether `gh` is installed and logged in to github.com, and as whom (best effort). */
	detect(): Promise<{ login: string | null } | null>
	token(): Promise<string | null>
}

function run(args: Array<string>): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(
			'gh',
			args,
			{ env: { ...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }, timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true },
			(err, stdout, stderr) => {
				const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : -1) : 0
				resolve({ code, stdout: String(stdout), stderr: String(stderr) })
			},
		)
	})
}

export const ghCli: CliTokenSource = {
	async detect() {
		const r = await run(['auth', 'status', '--hostname', 'github.com'])
		if (r.code !== 0) return null
		const m = /Logged in to github\.com (?:account|as) (\S+)/.exec(`${r.stdout}\n${r.stderr}`)
		return { login: m?.[1] ?? null }
	},
	async token() {
		const r = await run(['auth', 'token', '--hostname', 'github.com'])
		const t = r.stdout.trim()
		return r.code === 0 && /^[A-Za-z0-9_]{20,512}$/.test(t) ? t : null
	},
}
