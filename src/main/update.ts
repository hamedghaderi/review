import { createHash } from 'node:crypto'
import { open, rename, rm } from 'node:fs/promises'
import semver from 'semver'
import type { ReleaseNote } from '../shared/types.ts'

export const RELEASES_URL = 'https://github.com/hamedghaderi/review/releases/latest'
const LATEST_API = 'https://api.github.com/repos/hamedghaderi/review/releases/latest'
const DOWNLOAD_PREFIX = 'https://github.com/hamedghaderi/review/releases/download/'

export interface ReleaseAsset {
	name: string
	url: string
	size: number
	sha256: string | null // GitHub's digest of the file, when the release has one
}

export interface Release {
	version: string
	asset: ReleaseAsset | null // the installer for this system, if the release has it
}

const RELEASES_API = 'https://api.github.com/repos/hamedghaderi/review/releases?per_page=30'
const RELEASE_PREFIX = 'https://github.com/hamedghaderi/review/releases/'

/**
 * The notes of recent published releases, newest first, rendered by GitHub. Drafts and pre-releases are left out.
 * Throws when GitHub can't be reached, so the window can say so and link to the releases page.
 */
export async function releaseNotes(fetcher: typeof fetch = fetch): Promise<Array<ReleaseNote>> {
	const res = await fetcher(RELEASES_API, { headers: { Accept: 'application/vnd.github.html+json' }, signal: AbortSignal.timeout(10_000) })
	if (!res.ok) throw new Error(`GitHub answered ${res.status}.`)
	const list = (await res.json()) as unknown
	if (!Array.isArray(list)) throw new Error('GitHub sent something unexpected.')
	const out: Array<ReleaseNote> = []
	for (const r of list as Array<Record<string, unknown>>) {
		const version = semver.clean(String(r?.tag_name ?? ''))
		if (!version || r.draft === true || r.prerelease === true || semver.prerelease(version)) continue
		const url = typeof r.html_url === 'string' && r.html_url.startsWith(RELEASE_PREFIX) ? r.html_url : RELEASES_URL
		out.push({
			version,
			html: typeof r.body_html === 'string' ? r.body_html : '',
			url,
			date: typeof r.published_at === 'string' ? r.published_at : null,
		})
	}
	return out.sort((a, b) => semver.rcompare(a.version, b.version))
}

/** The installer built for a system, as named by electron-builder.yml's artifactName. */
export function assetName(platform: string, arch: string): string | null {
	if (platform === 'darwin') return `Review-mac-${arch === 'arm64' ? 'arm64' : 'x64'}.dmg`
	if (platform === 'win32') return 'Review-windows-setup.exe'
	if (platform === 'linux' && arch === 'x64') return 'Review-linux-x86_64.AppImage'
	return null
}

/** The newest published release when it is newer than `current`, else null. Network problems count as no update. */
export async function newerRelease(
	current: string,
	platform: string,
	arch: string,
	fetcher: typeof fetch = fetch,
): Promise<Release | null> {
	try {
		const res = await fetcher(LATEST_API, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10_000) })
		if (!res.ok) return null
		const body = (await res.json()) as { tag_name?: unknown; assets?: unknown }
		const version = semver.clean(String(body.tag_name ?? ''))
		if (!version || !semver.gt(version, current)) return null
		const name = assetName(platform, arch)
		const a = (Array.isArray(body.assets) ? body.assets : []).find((x) => x?.name === name) as
			{ browser_download_url?: unknown; size?: unknown; digest?: unknown } | undefined
		const url = a?.browser_download_url
		const size = a?.size
		const asset =
			name && typeof url === 'string' && url.startsWith(DOWNLOAD_PREFIX) && Number.isSafeInteger(size) && (size as number) > 0
				? {
						name,
						url,
						size: size as number,
						sha256: typeof a!.digest === 'string' && a!.digest.startsWith('sha256:') ? a!.digest.slice(7) : null,
					}
				: null
		return { version, asset }
	} catch {
		return null
	}
}

/**
 * Downloads a release file to `file` (through `file.part`, so a failed download never leaves a half file in place) and
 * checks its size and digest. `onProgress` gets the fraction done, at most once per percent.
 */
export async function download(
	asset: ReleaseAsset,
	file: string,
	onProgress: (fraction: number) => void,
	fetcher: typeof fetch = fetch,
): Promise<void> {
	const res = await fetcher(asset.url, { signal: AbortSignal.timeout(15 * 60_000) })
	if (!res.ok || !res.body) throw new Error(`The download failed (HTTP ${res.status}).`)
	const part = `${file}.part`
	const hash = createHash('sha256')
	let received = 0
	let percent = -1
	const fh = await open(part, 'w', 0o755)
	try {
		for await (const chunk of res.body) {
			received += chunk.length
			if (received > asset.size) throw new Error('The download is larger than the release says. Try again later.')
			hash.update(chunk)
			await fh.write(chunk)
			const p = Math.floor((received / asset.size) * 100)
			if (p !== percent) onProgress((percent = p) / 100)
		}
		if (received !== asset.size) throw new Error('The download was cut off. Try again.')
		if (asset.sha256 && hash.digest('hex') !== asset.sha256)
			throw new Error('The download is damaged (its checksum does not match). Try again.')
	} catch (e) {
		await fh.close()
		await rm(part, { force: true })
		throw e
	}
	await fh.close()
	await rename(part, file)
}
