/**
 * Starts a module worker under the page's content security policy. A worker loaded straight from the app's file://
 * URL gets no policy at all (Chromium passes the page's on only to workers started from blob: URLs), so code in it
 * could fetch from the internet, import code from it, or run strings with eval. Started from a blob, it can't: what
 * the worker loads or connects to must pass the page's script-src and connect-src. index.html allows workers only
 * from blob: (worker-src), so a worker can't be started the other way by mistake.
 *
 * The blob loads the worker with a dynamic import(), which script-src governs; a static import inside a module worker
 * counts as loading a worker, which worker-src would refuse. Messages that arrive while it loads are held and passed
 * on once the worker's own listeners are set up.
 *
 * `url` must be absolute: inside the blob, a relative address would be read against the blob's own.
 */
export function sandboxedWorker(url: string): Worker {
	return new Worker(bootUrl(url), { type: 'module' })
}

/** The blob address that starts the worker at `url` (exported for the test that runs it in Chromium). */
export function bootUrl(url: string): string {
	const boot = `const held = []
const hold = (e) => held.push(e)
addEventListener('message', hold)
await import(${JSON.stringify(url)})
removeEventListener('message', hold)
for (const e of held) dispatchEvent(new MessageEvent('message', { data: e.data }))`
	// Not revoked: the worker reads it while it starts, and there's one per worker for the app's life.
	return URL.createObjectURL(new Blob([boot], { type: 'text/javascript' }))
}
