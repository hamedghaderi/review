import { CLI_CONCURRENCY } from '../../shared/types.ts'
import { ProviderError, type ReviewProvider } from './provider.ts'

// How long a usage limit without a known reset blocks the login before a request may try again.
const UNKNOWN_RESET_MS = 5 * 60_000

/**
 * One gate per CLI connection, kept across runs. It lets `limit` requests run at once and queues the rest, whichever
 * team member, focused pass or run sends them. Once a request reports the plan's usage limit, every other request on
 * the login fails at once with the same message until the limit resets, instead of each spending its own attempt.
 */
export class CliGate {
	private active = 0
	private waiting: Array<() => void> = []
	private blocked: { until: number; error: ProviderError } | null = null
	private limit: number
	private now: () => number

	constructor(limit = CLI_CONCURRENCY, now: () => number = Date.now) {
		this.limit = limit
		this.now = now
	}

	wrap(provider: ReviewProvider): ReviewProvider {
		return { ...provider, review: (request, signal) => this.run(() => provider.review(request, signal), signal) }
	}

	/** Forgets a usage limit, so the next request tries again (Test connection, or a changed program). */
	clear(): void {
		this.blocked = null
	}

	private async run<T>(send: () => Promise<T>, signal: AbortSignal): Promise<T> {
		this.check()
		await this.acquire(signal)
		try {
			this.check() // another request may have reached the limit while this one waited
			return await send()
		} catch (e) {
			if (e instanceof ProviderError && e.kind === 'quota')
				this.blocked = { until: this.now() + (e.retryAfterMs ?? UNKNOWN_RESET_MS), error: e }
			throw e
		} finally {
			this.release()
		}
	}

	private check(): void {
		if (!this.blocked) return
		if (this.now() >= this.blocked.until) this.blocked = null
		else throw new ProviderError('quota', this.blocked.error.message, this.blocked.until - this.now())
	}

	private acquire(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return Promise.reject(new ProviderError('cancelled', 'Request cancelled'))
		if (this.active < this.limit) {
			this.active++
			return Promise.resolve()
		}
		return new Promise((resolve, reject) => {
			const go = (): void => {
				signal.removeEventListener('abort', abort)
				this.active++
				resolve()
			}
			const abort = (): void => {
				this.waiting = this.waiting.filter((w) => w !== go)
				reject(new ProviderError('cancelled', 'Request cancelled'))
			}
			signal.addEventListener('abort', abort, { once: true })
			this.waiting.push(go)
		})
	}

	private release(): void {
		this.active--
		this.waiting.shift()?.()
	}
}
