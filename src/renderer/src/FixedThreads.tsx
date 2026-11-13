import { useEffect, useState } from 'react'
import { describeLeaks, findLeaks } from '../../shared/leaks.ts'
import type { FixedThread } from '../../shared/types.ts'

/**
 * Resolving your threads that a newer run found fixed (issue #193). The review only offers: a banner says how many look
 * fixed, and nothing changes on GitHub until you pick threads in the dialog and press Resolve.
 */

const short = (sha: string): string => sha.slice(0, 7)

export function FixedThreadsBanner({ rows, onOpen, onDismiss }: { rows: Array<FixedThread>; onOpen(): void; onDismiss(): void }) {
	const n = rows.filter((r) => r.state === 'confirmed').length
	return (
		<div className="banner" role="status">
			<span>
				<strong>
					{n} of your threads {n === 1 ? 'looks' : 'look'} fixed.
				</strong>{' '}
				The latest run no longer finds {n === 1 ? 'that problem' : 'those problems'}, and a double-check on the new code agrees. Nothing is
				resolved until you choose.
			</span>
			<span className="spacer" />
			<button className="btn small primary" onClick={onOpen}>
				Review and resolve…
			</button>
			<button className="btn small ghost" onClick={onDismiss} aria-label="Not now" title="Not now">
				✕
			</button>
		</div>
	)
}

type RowStatus = 'resolving' | 'done' | { error: string }

export function ResolveFixedDialog({
	rows,
	onResolve,
	onClose,
}: {
	rows: Array<FixedThread>
	/** Replies with `body` (when not empty) and resolves; returns why it failed, or null. */
	onResolve(threadId: string, body: string): Promise<string | null>
	onClose(): void
}) {
	const offered = rows.filter((r) => r.state === 'confirmed')
	const others = rows.filter((r) => r.state !== 'confirmed')
	const [picked, setPicked] = useState(() => new Set(offered.map((r) => r.threadId)))
	const [replies, setReplies] = useState(() => new Map(offered.map((r) => [r.threadId, `Fixed in ${short(r.commit)}.`])))
	const [status, setStatus] = useState<Map<string, RowStatus>>(new Map())
	const [busy, setBusy] = useState(false)

	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			if (e.key === 'Escape' && !busy) onClose()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [busy, onClose])

	const pending = offered.filter((r) => picked.has(r.threadId) && status.get(r.threadId) !== 'done')
	const allDone = offered.length > 0 && offered.every((r) => !picked.has(r.threadId) || status.get(r.threadId) === 'done')

	const resolve = async (): Promise<void> => {
		const leaks = pending.flatMap((r) => findLeaks(replies.get(r.threadId) ?? ''))
		if (leaks.length && !window.confirm(`A reply has ${describeLeaks(leaks)}. Post it on GitHub anyway?`)) return
		setBusy(true)
		// One at a time, so GitHub isn't hit all at once; one that fails says why on its row and the rest go on.
		for (const r of pending) {
			setStatus((s) => new Map(s).set(r.threadId, 'resolving'))
			const error = await onResolve(r.threadId, (replies.get(r.threadId) ?? '').trim())
			setStatus((s) => new Map(s).set(r.threadId, error ? { error } : 'done'))
		}
		setBusy(false)
	}

	return (
		<div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
			<div className="modal fixed-threads" role="dialog" aria-modal="true" aria-labelledby="fixed-threads-title">
				<div className="modal-head">
					<h2 id="fixed-threads-title">Resolve fixed threads</h2>
					<span className="spacer" />
					<button className="btn small ghost" onClick={onClose} disabled={busy} aria-label="Close">
						✕
					</button>
				</div>
				<div className="fixed-body">
					<p className="muted small">
						These threads came from findings that the latest run no longer finds, and a double-check on the new code says the problem is
						gone. Each one gets the reply below, then is resolved. Clear a reply to resolve without one.
					</p>
					<ul className="fixed-list">
						{offered.map((r) => {
							const s = status.get(r.threadId)
							const on = picked.has(r.threadId)
							return (
								<li key={r.threadId} className={`fixed-row${on ? '' : ' off'}`}>
									<div className="fixed-head">
										<label className="check">
											<input
												type="checkbox"
												checked={on}
												disabled={busy || s === 'done'}
												onChange={(e) =>
													setPicked((p) => {
														const n = new Set(p)
														if (e.target.checked) n.add(r.threadId)
														else n.delete(r.threadId)
														return n
													})
												}
											/>
											<strong>{r.title}</strong>
										</label>
										<span className="mono muted small">{r.place}</span>
										<span className="spacer" />
										{r.url && (
											<a className="small" href={r.url} target="_blank" rel="noreferrer" title="Open the thread on GitHub">
												Thread ↗
											</a>
										)}
									</div>
									{r.reason && <p className="muted small fixed-reason">{r.reason}</p>}
									<input
										className="fixed-reply"
										aria-label={`Reply to the thread on ${r.place}`}
										value={replies.get(r.threadId) ?? ''}
										placeholder="No reply: just resolve"
										disabled={!on || busy || s === 'done'}
										onChange={(e) => setReplies((m) => new Map(m).set(r.threadId, e.target.value))}
									/>
									{s === 'resolving' && <p className="muted small">Resolving…</p>}
									{s === 'done' && <p className="small ok-text">Resolved on GitHub.</p>}
									{s && typeof s === 'object' && <p className="small error-text">Not resolved: {s.error}</p>}
								</li>
							)
						})}
					</ul>
					{others.length > 0 && (
						<details className="fixed-others small">
							<summary className="muted">
								{others.length} more {others.length === 1 ? 'thread' : 'threads'} the run marked fixed{' '}
								{others.length === 1 ? 'isn’t' : 'aren’t'} offered
							</summary>
							<ul>
								{others.map((r) => (
									<li key={r.threadId}>
										<strong>{r.title}</strong> <span className="mono muted">{r.place}</span>:{' '}
										{r.state === 'unchecked'
											? 'not double-checked (the check is still running, or a budget you set was reached).'
											: `the double-check doesn’t confirm it’s fixed${r.reason ? `: ${r.reason}` : '.'}`}
									</li>
								))}
							</ul>
						</details>
					)}
				</div>
				<div className="form-actions fixed-actions">
					<button className="btn" onClick={onClose} disabled={busy}>
						{allDone ? 'Done' : 'Not now'}
					</button>
					{!allDone && (
						<button className="btn primary" onClick={() => void resolve()} disabled={busy || !pending.length}>
							{busy ? 'Resolving…' : `Resolve ${pending.length} thread${pending.length === 1 ? '' : 's'}`}
						</button>
					)}
				</div>
			</div>
		</div>
	)
}
