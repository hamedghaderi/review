import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CONTEXT_IMAGE_TYPES, CONTEXT_LIMITS, type ContextImageType } from '../shared/types.ts'
import { AppFail } from './git.ts'

const EXT: Record<ContextImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
const ID = /^[0-9a-f]{64}$/

/** The image type from its first bytes; the name or the renderer's claim is never trusted. */
export function sniffImage(b: Uint8Array): ContextImageType | null {
	const at = (i: number, ...xs: Array<number>): boolean => xs.every((x, j) => b[i + j] === x)
	if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
	if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
	if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif'
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
	return null
}

export function isImageType(v: unknown): v is ContextImageType {
	return (CONTEXT_IMAGE_TYPES as ReadonlyArray<unknown>).includes(v)
}

/**
 * Images you gave the reviewer, one file per content hash in the app's data folder, so the review store stays small
 * and the same screenshot added twice is stored once. Files are only ever added; a review references them by id.
 */
export class ContextImages {
	private dir: string

	constructor(dir: string) {
		this.dir = dir
	}

	private path(id: string, type: ContextImageType): string {
		if (!ID.test(id)) throw new AppFail('invalid-input', 'Invalid image id.')
		return join(this.dir, `${id}.${EXT[type]}`)
	}

	async add(bytes: Uint8Array): Promise<{ id: string; mediaType: ContextImageType; bytes: number }> {
		if (!bytes.length) throw new AppFail('invalid-input', 'The image is empty.')
		if (bytes.length > CONTEXT_LIMITS.imageBytes)
			throw new AppFail(
				'invalid-input',
				`The image is too large (${Math.round(bytes.length / 1000)} KB; the limit is ${CONTEXT_LIMITS.imageBytes / 1000} KB).`,
			)
		const mediaType = sniffImage(bytes)
		if (!mediaType) throw new AppFail('invalid-input', 'Not a PNG, JPEG, GIF or WebP image.')
		const id = createHash('sha256').update(bytes).digest('hex')
		const file = this.path(id, mediaType)
		if (!existsSync(file)) {
			await mkdir(this.dir, { recursive: true })
			const tmp = `${file}.${process.pid}.tmp`
			await writeFile(tmp, bytes, { mode: 0o600 })
			await rename(tmp, file)
		}
		return { id, mediaType, bytes: bytes.length }
	}

	has(id: string, type: ContextImageType): boolean {
		return ID.test(id) && existsSync(this.path(id, type))
	}

	async read(id: string, type: ContextImageType): Promise<Buffer> {
		const file = this.path(id, type)
		try {
			return await readFile(file)
		} catch {
			throw new AppFail('not-found', 'That image is no longer stored.')
		}
	}
}
