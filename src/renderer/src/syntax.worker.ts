import { tokenize } from './syntaxEngine.ts'

/**
 * Colours code off the page's thread (issue #237): one request at a time, in the order asked. A cancelled request
 * that has started stops at its next pause, so moving through files never waits for one you've left.
 */
type Message = { id: number; path: string; lines: Array<string> } | { cancel: number }

const scope = globalThis as unknown as {
	postMessage(m: unknown): void
	addEventListener(t: 'message', f: (e: MessageEvent<Message>) => void): void
}
const cancelled = new Set<number>()
let queue: Promise<void> = Promise.resolve()

scope.addEventListener('message', (e) => {
	const m = e.data
	if ('cancel' in m) {
		cancelled.add(m.cancel)
		return
	}
	queue = queue.then(async () => {
		const pause = (): Promise<boolean> => new Promise((r) => setTimeout(() => r(!cancelled.has(m.id)), 0))
		let tokens = null
		if (!cancelled.has(m.id))
			try {
				tokens = await tokenize(m.path, m.lines, pause)
			} catch {
				// Left plain.
			}
		cancelled.delete(m.id)
		scope.postMessage({ id: m.id, tokens })
	})
})
