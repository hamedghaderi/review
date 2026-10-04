import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseGitHubRemote } from '../shared/prQuery.ts'
import type { AppError, BranchRef, ChangedFile, Comparison, ErrorCode, FileStatus, RemoteInfo, RepoInfo } from '../shared/types.ts'

export class AppFail extends Error {
	code: ErrorCode
	constructor(code: ErrorCode, message: string) {
		super(message)
		this.code = code
	}
	toError(): AppError {
		return { code: this.code, message: this.message }
	}
}

interface GitOutput {
	code: number
	stdout: Buffer
	stderr: string
	truncated: boolean
}

// Read-only, non-interactive invocation. Pathspecs are literal so file names are never treated as globs.
const GLOBAL_ARGS = ['--no-pager', '--literal-pathspecs', '-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', '-c', 'color.ui=false']

const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

// Git needs the user's environment (HOME, SSH agent, config) but never AI provider credentials.
export const env: NodeJS.ProcessEnv = {
	...Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !/^(OPENAI|ANTHROPIC|GEMINI|GOOGLE_API|GOOGLE_GENAI|OPENROUTER)_/.test(k)),
	),
	PATH: [process.env.PATH, ...EXTRA_PATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
	GIT_TERMINAL_PROMPT: '0',
	GIT_OPTIONAL_LOCKS: '0',
	GIT_PAGER: 'cat',
	LC_ALL: 'C',
	LANG: 'C',
}

export function git(
	cwd: string,
	args: Array<string>,
	maxBytes = 256 * 1024 * 1024,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<GitOutput> {
	return new Promise((resolve, reject) => {
		const child = spawn('git', [...GLOBAL_ARGS, ...args], {
			cwd,
			env,
			shell: false,
			windowsHide: true,
			signal: options.signal,
			timeout: options.timeoutMs,
		})
		const out: Array<Buffer> = []
		const err: Array<Buffer> = []
		let size = 0
		let truncated = false
		child.stdout.on('data', (chunk: Buffer) => {
			if (truncated) return
			size += chunk.length
			if (size > maxBytes) {
				truncated = true
				child.kill()
				return
			}
			out.push(chunk)
		})
		child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
		child.on('error', (e: NodeJS.ErrnoException) => {
			if (e.name === 'AbortError') reject(new AppFail('cancelled', 'Cancelled.'))
			else if (e.code === 'ENOENT')
				reject(new AppFail('git-missing', 'Git was not found. Install Git and make sure it is available on your PATH.'))
			else reject(new AppFail('git-failed', `Could not run Git: ${e.message}`))
		})
		child.on('close', (code) => {
			resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8'), truncated })
		})
	})
}

async function gitText(cwd: string, args: Array<string>): Promise<string> {
	const r = await git(cwd, args)
	if (r.code !== 0) throw new AppFail('git-failed', `git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`)
	return r.stdout.toString('utf8')
}

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/

export function isSha(s: unknown): s is string {
	return typeof s === 'string' && SHA_RE.test(s)
}

export async function resolveCommit(cwd: string, rev: string): Promise<string | null> {
	const r = await git(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`])
	const sha = r.stdout.toString('utf8').trim()
	return r.code === 0 && isSha(sha) ? sha : null
}

export async function findRoot(dir: string): Promise<string> {
	const r = await git(dir, ['rev-parse', '--show-toplevel'])
	if (r.code !== 0) {
		const msg = r.stderr
		if (/dubious ownership/i.test(msg)) {
			throw new AppFail(
				'dubious-ownership',
				`Git refuses to read this repository because it is owned by another user. If you trust it, run: git config --global --add safe.directory "${dir}"`,
			)
		}
		if (/must be run in a work tree/i.test(msg)) {
			throw new AppFail('bare-repo', 'This is a bare repository or a .git directory. Open the repository’s working tree instead.')
		}
		throw new AppFail('not-a-repo', 'The selected folder is not inside a Git repository.')
	}
	return realpath(r.stdout.toString('utf8').trim())
}

const REF_FORMAT = [
	'%(refname)',
	'%(symref)',
	'%(objectname)',
	'%(committerdate:iso-strict)',
	'%(upstream)',
	'%(upstream:track,nobracket)',
	'%(HEAD)',
	'%(contents:subject)',
].join('%00')

export async function readRepo(root: string): Promise<RepoInfo> {
	const [headSha, branchOut, refsOut, remotesOut, shallowOut, statusOut] = await Promise.all([
		resolveCommit(root, 'HEAD'),
		git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
		gitText(root, ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes']),
		git(root, ['config', '--null', '--get-regexp', '^remote\\..*\\.url$']),
		git(root, ['rev-parse', '--is-shallow-repository']),
		git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']),
	])
	const branch = branchOut.code === 0 ? branchOut.stdout.toString('utf8').trim() : null
	const remotes = parseRemotes(remotesOut.code === 0 ? remotesOut.stdout.toString('utf8') : '')
	const { branches, remoteHeads } = parseRefs(refsOut, remotes)
	const baseCandidates = rankBases(branches, remoteHeads)
	return {
		id: root,
		root,
		name: basename(root),
		branch,
		headSha,
		branches,
		remotes,
		defaultBase: baseCandidates.find((c) => c !== (branch ? `refs/heads/${branch}` : null)) ?? baseCandidates[0] ?? null,
		baseCandidates,
		shallow: shallowOut.stdout.toString('utf8').trim() === 'true',
		uncommitted: statusOut.code === 0 ? countStatusEntries(statusOut.stdout.toString('utf8')) : 0,
	}
}

/** `git config --null --get-regexp` output: "remote.<name>.url\n<value>\0". Remote names may contain dots and slashes. */
export function parseRemotes(z: string): Array<RemoteInfo> {
	const out: Array<RemoteInfo> = []
	for (const entry of z.split('\0')) {
		const nl = entry.indexOf('\n')
		if (nl < 0) continue
		const key = entry.slice(0, nl)
		const name = key.slice('remote.'.length, -'.url'.length)
		if (!name || out.some((r) => r.name === name)) continue
		out.push({ name, github: parseGitHubRemote(entry.slice(nl + 1)) })
	}
	return out
}

export function parseRefs(text: string, remotes: Array<RemoteInfo>): { branches: Array<BranchRef>; remoteHeads: Map<string, string> } {
	// Longest remote name first, so "team/a" wins over "team" for refs/remotes/team/a/x.
	const names = remotes.map((r) => r.name).sort((a, b) => b.length - a.length)
	const branches: Array<BranchRef> = []
	const remoteHeads = new Map<string, string>()
	for (const line of text.split('\n')) {
		const [ref, symref, sha, date, upstream, track, head, subject] = line.split('\0')
		if (!ref || !isSha(sha)) continue
		const isRemote = ref.startsWith('refs/remotes/')
		const rest = ref.slice(isRemote ? 'refs/remotes/'.length : 'refs/heads/'.length)
		const remote = isRemote ? (names.find((n) => rest.startsWith(`${n}/`)) ?? rest.split('/')[0]) : null
		const short = remote ? rest.slice(remote.length + 1) : rest
		if (symref) {
			// refs/remotes/<remote>/HEAD is an alias for the remote's default branch, not a branch of its own.
			if (remote && short === 'HEAD') remoteHeads.set(remote, symref)
			continue
		}
		if (!short) continue
		const m = /(?:ahead (\d+))?(?:, )?(?:behind (\d+))?/.exec(track ?? '')
		const gone = track === 'gone'
		branches.push({
			ref,
			name: remote ? `${remote}/${short}` : short,
			kind: remote ? 'remote' : 'local',
			remote,
			short,
			sha,
			date: date ?? '',
			subject: subject ?? '',
			upstream: upstream || null,
			ahead: upstream && !gone ? Number(m?.[1] ?? 0) : null,
			behind: upstream && !gone ? Number(m?.[2] ?? 0) : null,
			upstreamGone: gone,
			current: head === '*',
		})
	}
	return { branches, remoteHeads }
}

const CONVENTIONAL = ['main', 'master', 'develop', 'trunk']

/**
 * Likely base branches, best first: each remote's default branch (from its HEAD alias; upstream before origin
 * because forks usually track upstream), the local branches of the same name, then conventional names.
 */
export function rankBases(branches: Array<BranchRef>, remoteHeads: Map<string, string>): Array<string> {
	const known = new Set(branches.map((b) => b.ref))
	const order = [...remoteHeads.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
	const out: Array<string> = []
	const add = (ref: string): void => {
		if (known.has(ref) && !out.includes(ref)) out.push(ref)
	}
	for (const r of order) add(remoteHeads.get(r)!)
	for (const r of order) add(`refs/heads/${remoteHeads.get(r)!.slice(`refs/remotes/${r}/`.length)}`)
	for (const n of CONVENTIONAL) add(`refs/heads/${n}`)
	for (const r of ['upstream', 'origin']) for (const n of CONVENTIONAL) add(`refs/remotes/${r}/${n}`)
	return out
}

function rank(remote: string): number {
	return remote === 'upstream' ? 0 : remote === 'origin' ? 1 : 2
}

export function countStatusEntries(z: string): number {
	const parts = z.split('\0')
	let n = 0
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i]
		if (p.length < 3) continue
		n++
		if (p[0] === 'R' || p[0] === 'C') i++ // rename/copy entries carry the original path as a separate field
	}
	return n
}

export interface ComparisonData {
	root: string
	comparison: Comparison
	blobs: Map<string, { oldBlob: string | null; newBlob: string | null }>
}

function branchName(repo: RepoInfo, ref: string): string {
	if (ref === 'HEAD') return repo.branch ?? 'HEAD'
	return repo.branches.find((b) => b.ref === ref)?.name ?? shortRef(ref)
}

/** Resolves a branch target to SHAs without touching the working tree: merge-base(base, head)..head. */
export async function resolveBranchTarget(
	repo: RepoInfo,
	headRef: string,
	baseRef: string,
): Promise<{ headSha: string; baseTipSha: string; baseSha: string }> {
	for (const [ref, what] of [
		[headRef, 'Branch'],
		[baseRef, 'Base branch'],
	] as const) {
		if (ref === 'HEAD' && what === 'Branch') continue
		if (!repo.branches.some((b) => b.ref === ref))
			throw new AppFail('not-found', `${what} ${shortRef(ref)} no longer exists. Refresh the branch list and choose again.`)
	}
	const [headSha, baseTipSha] = await Promise.all([resolveCommit(repo.root, headRef), resolveCommit(repo.root, baseRef)])
	if (!headSha)
		throw new AppFail(
			headRef === 'HEAD' ? 'no-commits' : 'not-found',
			headRef === 'HEAD' ? 'This repository has no commits yet.' : `${shortRef(headRef)} could not be resolved.`,
		)
	if (!baseTipSha) throw new AppFail('not-found', `Base branch ${shortRef(baseRef)} could not be resolved.`)
	const baseSha = await mergeBase(repo.root, baseTipSha, headSha, branchName(repo, headRef), branchName(repo, baseRef))
	return { headSha, baseTipSha, baseSha }
}

/** Compares a branch (or HEAD) with a base branch. */
export async function compareBranches(repo: RepoInfo, headRef: string, baseRef: string): Promise<ComparisonData> {
	const s = await resolveBranchTarget(repo, headRef, baseRef)
	return buildComparison(repo.root, {
		repoId: repo.id,
		baseRef,
		headRef: branchName(repo, headRef),
		...s,
		target: { kind: 'branch', headRef, baseRef },
		pr: null,
	})
}

/** A commit is reachable when it and its tree can be read; `merge-base` distinguishes shallow from unrelated history. */
export async function mergeBase(root: string, a: string, b: string, headLabel: string, baseLabel: string): Promise<string> {
	const mb = await git(root, ['merge-base', a, b])
	const sha = mb.stdout.toString('utf8').trim()
	if (mb.code === 0 && isSha(sha)) return sha
	if (mb.code === 1) {
		const shallow = (await git(root, ['rev-parse', '--is-shallow-repository'])).stdout.toString('utf8').trim() === 'true'
		if (shallow)
			throw new AppFail(
				'shallow-history',
				`No merge base between ${headLabel} and ${baseLabel} was found, but this is a shallow clone, so their common history may simply not be downloaded. Run "git fetch --unshallow" (or fetch with more depth) and try again.`,
			)
		throw new AppFail(
			'unrelated-histories',
			`${headLabel} and ${baseLabel} have no common history, so there is no merge base to compare against.`,
		)
	}
	throw new AppFail('git-failed', `git merge-base failed: ${mb.stderr.trim()}`)
}

/** Rebuilds a stored comparison from its pinned SHAs. */
export async function compareSnapshot(root: string, s: Omit<Comparison, 'id' | 'files'>): Promise<ComparisonData> {
	const [b, h] = await Promise.all([resolveCommit(root, s.baseSha), resolveCommit(root, s.headSha)])
	if (b !== s.baseSha || h !== s.headSha) {
		throw new AppFail(
			'missing-commits',
			'The commits this review was pinned to are no longer in the repository (for example after a rebase and garbage collection).',
		)
	}
	return buildComparison(root, s)
}

export function shortRef(ref: string): string {
	return ref.replace(/^refs\/(heads|remotes)\//, '')
}

export const KEEP_PREFIX = 'refs/review/keep/'

/**
 * Makes sure `shas` exist locally and pins each under refs/review/keep/<sha> so garbage collection keeps them.
 * Objects already present are pinned without network access. Missing ones are fetched by exact SHA, which never
 * touches branches, remote-tracking refs, FETCH_HEAD, the index or the working tree. Returns the SHAs fetched.
 */
export async function ensureCommits(
	root: string,
	remote: string,
	shas: Array<string>,
	signal?: AbortSignal,
): Promise<{ fetched: Array<string> }> {
	if (shas.some((s) => !isSha(s))) throw new AppFail('invalid-input', 'Invalid commit id.')
	if (remote.startsWith('-')) throw new AppFail('invalid-input', 'Invalid remote.')
	const present = await Promise.all(shas.map((s) => resolveCommit(root, s)))
	const missing = shas.filter((s, i) => present[i] !== s)
	if (missing.length) {
		const r = await git(
			root,
			[
				'-c',
				'gc.auto=0',
				'-c',
				'maintenance.auto=false',
				'-c',
				'fetch.writeCommitGraph=false',
				'fetch',
				'--quiet',
				'--no-tags',
				'--no-prune',
				'--no-write-fetch-head',
				'--no-recurse-submodules',
				'--refmap=', // ignore remote.<name>.fetch, so no remote-tracking ref is updated opportunistically
				'--end-of-options',
				remote,
				...missing.map((s) => `+${s}:${KEEP_PREFIX}${s}`),
			],
			1024 * 1024,
			{ signal, timeoutMs: 180_000 },
		)
		if (r.code !== 0) throw fetchError(remote, r.stderr)
	}
	for (const s of shas) {
		if (missing.includes(s)) continue
		const u = await git(root, ['update-ref', '--no-deref', `${KEEP_PREFIX}${s}`, s])
		if (u.code !== 0) throw new AppFail('git-failed', `Could not pin commit ${s.slice(0, 7)}: ${u.stderr.trim()}`)
	}
	for (const s of shas) {
		if ((await resolveCommit(root, `${KEEP_PREFIX}${s}`)) !== s)
			throw new AppFail('fetch-failed', `Fetched objects do not match the requested commit ${s.slice(0, 7)}.`)
	}
	return { fetched: missing }
}

export class ObjectUnavailable extends AppFail {}

function fetchError(remote: string, stderr: string): AppFail {
	const msg = stderr.trim().split('\n').slice(-3).join(' ')
	if (/not our ref|couldn't find remote ref|no such remote ref|unadvertised object|did not send all necessary objects/i.test(stderr))
		return new ObjectUnavailable('pr-unavailable', `The remote no longer has a commit this review needs (${msg}).`)
	if (/could not resolve host|network is unreachable|connection timed out|operation timed out|connection refused/i.test(stderr))
		return new AppFail('offline', `Git could not reach ${remote}: ${msg}`)
	if (/authentication failed|permission denied|could not read username|repository not found|access denied|403/i.test(stderr))
		return new AppFail(
			'fetch-failed',
			`Git could not fetch from ${remote} with your Git credentials: ${msg}. Fetching uses Git's own authentication (SSH keys or a credential helper), not the GitHub API token.`,
		)
	return new AppFail('fetch-failed', `git fetch from ${remote} failed: ${msg}`)
}

/** Counts commits only on `head` and only on `base`. */
export async function aheadBehind(root: string, base: string, head: string): Promise<{ ahead: number; behind: number } | null> {
	const r = await git(root, ['rev-list', '--left-right', '--count', `${base}...${head}`], 4096, { timeoutMs: 15_000 })
	const m = /^(\d+)\s+(\d+)/.exec(r.stdout.toString('utf8'))
	return r.code === 0 && m ? { behind: Number(m[1]), ahead: Number(m[2]) } : null
}

const DIFF_FLAGS = ['-r', '-M', '--no-ext-diff', '--no-textconv', '--no-relative', '--no-color']

async function buildComparison(root: string, s: Omit<Comparison, 'id' | 'files'>): Promise<ComparisonData> {
	const [raw, numstat] = await Promise.all([
		gitText(root, ['diff-tree', ...DIFF_FLAGS, '-z', '--raw', '--no-abbrev', s.baseSha, s.headSha]),
		gitText(root, ['diff-tree', ...DIFF_FLAGS, '-z', '--numstat', s.baseSha, s.headSha]),
	])
	const { files, blobs } = parseChanges(raw, numstat)
	return { root, blobs, comparison: { ...s, id: `${s.baseSha}..${s.headSha}`, files } }
}

const ZERO = /^0+$/

export function parseChanges(raw: string, numstat: string): Pick<ComparisonData, 'blobs'> & { files: Array<ChangedFile> } {
	const files: Array<ChangedFile> = []
	const blobs: ComparisonData['blobs'] = new Map()
	const r = raw.split('\0')
	for (let i = 0; i < r.length; i++) {
		const meta = r[i]
		if (!meta.startsWith(':')) continue
		const [, , oldBlob, newBlob, statusField] = meta.slice(1).split(' ')
		const letter = statusField[0]
		const score = statusField.length > 1 ? Number(statusField.slice(1)) : null
		let oldPath: string | null = r[++i]
		let newPath: string | null = oldPath
		if (letter === 'R' || letter === 'C') newPath = r[++i]
		const status = STATUS[letter] ?? 'modified'
		if (status === 'added') oldPath = null
		if (status === 'deleted') newPath = null
		const key = (newPath ?? oldPath) as string
		files.push({ key, status, oldPath, newPath, additions: null, deletions: null, binary: false, similarity: score })
		blobs.set(key, { oldBlob: ZERO.test(oldBlob) ? null : oldBlob, newBlob: ZERO.test(newBlob) ? null : newBlob })
	}
	// numstat -z: "a\td\tpath\0" or, for renames, "a\td\t\0old\0new\0". Same order as --raw.
	const n = numstat.split('\0')
	let fi = 0
	for (let i = 0; i < n.length && fi < files.length; i++) {
		const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(n[i])
		if (!m) continue
		if (m[3] === '') i += 2
		const f = files[fi++]
		if (m[1] === '-') f.binary = true
		else {
			f.additions = Number(m[1])
			f.deletions = Number(m[2])
		}
	}
	return { files, blobs }
}

const STATUS: Record<string, FileStatus> = { A: 'added', D: 'deleted', M: 'modified', R: 'renamed', C: 'copied', T: 'type-changed' }

export async function readPatch(data: ComparisonData, file: ChangedFile, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
	const { baseSha, headSha } = data.comparison
	const paths = [...new Set([file.oldPath, file.newPath].filter((p): p is string => !!p))]
	const r = await git(
		data.root,
		['diff-tree', ...DIFF_FLAGS, '-p', '-U3', '--src-prefix=a/', '--dst-prefix=b/', baseSha, headSha, '--', ...paths],
		maxBytes,
	)
	if (!r.truncated && r.code !== 0) throw new AppFail('git-failed', `git diff-tree failed: ${r.stderr.trim()}`)
	return { text: r.stdout.toString('utf8'), truncated: r.truncated }
}

export async function readBlob(root: string, blob: string, maxBytes: number): Promise<{ buf: Buffer; truncated: boolean }> {
	if (!isSha(blob)) throw new AppFail('invalid-input', 'Invalid blob id.')
	const r = await git(root, ['cat-file', 'blob', blob], maxBytes)
	if (!r.truncated && r.code !== 0) throw new AppFail('git-failed', `git cat-file failed: ${r.stderr.trim()}`)
	return { buf: r.stdout, truncated: r.truncated }
}
