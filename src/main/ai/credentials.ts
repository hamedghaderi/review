import { join } from 'node:path'
import type { CredentialStorageInfo } from '../../shared/types.ts'
import { JsonStore } from '../store.ts'

/** The subset of Electron's safeStorage used here, so tests can supply a fake. */
export interface SecretCipher {
	isAsyncEncryptionAvailable(): Promise<boolean>
	encryptStringAsync(plain: string): Promise<Buffer>
	decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
	getSelectedStorageBackend?(): string
}

interface CredentialFile {
	version: 1
	// connection id → encrypted secret, bound to the endpoint it was entered for
	entries: Record<string, { cipher: string; endpoint: string; savedAt: string }>
}

export type CredentialRead =
	| { state: 'saved' | 'session'; secret: string }
	| { state: 'none' }
	| { state: 'unreadable'; reason: string }
	| { state: 'endpoint-changed' }

const INSECURE_BACKENDS = new Set(['basic_text', 'unknown'])

/**
 * Stores API keys encrypted with OS-backed storage (Keychain, DPAPI, libsecret/kwallet). When that is not available,
 * including Linux's `basic_text` fallback, keys are kept in memory for the session only and never written to disk.
 * There is no API to list or export secrets; `read` is only used by the main process to build a provider client.
 */
export class CredentialService {
	private file: JsonStore<CredentialFile>
	private cipher: SecretCipher
	private session = new Map<string, { secret: string; endpoint: string }>()
	private storage: CredentialStorageInfo = { secure: false, backend: 'unknown', message: null }

	constructor(dir: string, cipher: SecretCipher) {
		this.cipher = cipher
		this.file = new JsonStore<CredentialFile>(join(dir, 'ai-credentials.json'), empty, migrate, 0o600)
	}

	async load(): Promise<void> {
		await this.file.load()
		const backend = this.cipher.getSelectedStorageBackend?.() ?? (process.platform === 'darwin' ? 'keychain' : process.platform)
		let available = false
		try {
			available = await this.cipher.isAsyncEncryptionAvailable()
		} catch {
			available = false
		}
		const insecure = process.platform === 'linux' && INSECURE_BACKENDS.has(backend)
		this.storage = {
			secure: available && !insecure,
			backend,
			message: !available
				? 'Secure credential storage is not available on this system. Keys can be used for this session only.'
				: insecure
					? `No OS keyring was found (backend "${backend}"). Keys can be used for this session only; install and unlock a keyring (e.g. GNOME Keyring or KWallet) to save them.`
					: null,
		}
	}

	storageInfo(): CredentialStorageInfo {
		return this.storage
	}

	/** Saves a secret for a connection's current endpoint. `persist` requires secure storage; there is no plaintext path. */
	async save(connectionId: string, secret: string, endpoint: string, persist: boolean): Promise<'saved' | 'session'> {
		if (persist && !this.storage.secure) throw new Error(this.storage.message ?? 'Secure storage is not available.')
		this.session.delete(connectionId)
		if (!persist) {
			await this.file.update((d) => {
				delete d.entries[connectionId]
			})
			this.session.set(connectionId, { secret, endpoint })
			return 'session'
		}
		const encrypted = await this.cipher.encryptStringAsync(secret)
		await this.file.update((d) => {
			d.entries[connectionId] = { cipher: encrypted.toString('base64'), endpoint, savedAt: new Date().toISOString() }
		})
		return 'saved'
	}

	/** Returns the secret only if it was saved for this exact endpoint. */
	async read(connectionId: string, endpoint: string): Promise<CredentialRead> {
		const s = this.session.get(connectionId)
		if (s) return s.endpoint === endpoint ? { state: 'session', secret: s.secret } : { state: 'endpoint-changed' }
		const entry = this.file.read().entries[connectionId]
		if (!entry) return { state: 'none' }
		if (entry.endpoint !== endpoint) return { state: 'endpoint-changed' }
		try {
			const { result, shouldReEncrypt } = await this.cipher.decryptStringAsync(Buffer.from(entry.cipher, 'base64'))
			if (shouldReEncrypt && this.storage.secure) void this.save(connectionId, result, endpoint, true).catch(() => {})
			return { state: 'saved', secret: result }
		} catch {
			return { state: 'unreadable', reason: 'The saved key could not be decrypted (the OS keyring may have changed). Enter it again.' }
		}
	}

	/** Cheap presence check for the settings view; never decrypts. */
	peek(connectionId: string, endpoint: string): 'saved' | 'session' | 'none' | 'endpoint-changed' {
		const s = this.session.get(connectionId)
		if (s) return s.endpoint === endpoint ? 'session' : 'endpoint-changed'
		const entry = this.file.read().entries[connectionId]
		if (!entry) return 'none'
		return entry.endpoint === endpoint ? 'saved' : 'endpoint-changed'
	}

	async remove(connectionId: string): Promise<void> {
		this.session.delete(connectionId)
		await this.file.update((d) => {
			delete d.entries[connectionId]
		})
	}

	flush(): Promise<unknown> {
		return this.file.flush()
	}
}

function empty(): CredentialFile {
	return { version: 1, entries: {} }
}

function migrate(raw: unknown): CredentialFile {
	const d = raw as Partial<CredentialFile> | null
	if (!d || d.version !== 1 || typeof d.entries !== 'object' || d.entries === null) throw new Error('Unsupported credential file')
	return { version: 1, entries: d.entries }
}
