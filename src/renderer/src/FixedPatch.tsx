import { useState } from 'react'
import type { FixedPatch, Result } from '../../shared/types.ts'

/**
 * What changed at a gone finding since the run that raised it (issue #215), collapsed until opened, so a "fixed" verdict
 * can be checked by eye before you act on it. Loaded from Git the first time it is opened.
 */
export function FixedPatchDetails({ since, load }: { since: string; load(): Promise<Result<FixedPatch>> }) {
	const [state, setState] = useState<{ patch: FixedPatch } | { error: string } | 'loading' | null>(null)
	return (
		<details
			className="fixed-patch small"
			onToggle={(e) => {
				if (!(e.currentTarget as HTMLDetailsElement).open || state !== null) return
				setState('loading')
				void load().then((r) => setState(r.ok ? { patch: r.value } : { error: r.error.message }))
			}}
		>
			<summary>What changed since {since.slice(0, 7)}</summary>
			{state === 'loading' && <p className="muted">Reading the change…</p>}
			{state && typeof state === 'object' && 'error' in state && <p className="error-text">{state.error}</p>}
			{state && typeof state === 'object' && 'patch' in state && <PatchView patch={state.patch} />}
		</details>
	)
}

function PatchView({ patch }: { patch: FixedPatch }) {
	return (
		<div className="fixed-patch-body">
			{patch.note && <p className="muted">{patch.note}</p>}
			{patch.parts.map((p) => (
				<div key={`${p.why}:${p.path}`} className="fixed-patch-file">
					<div className="mono muted">
						{p.path}
						{p.why === 'checked' ? ' · read by the double-check' : ''}
					</div>
					{p.hunks.map((h) => (
						<pre key={`${h.oldStart}:${h.newStart}`} className="fixed-patch-hunk mono">
							{h.lines.map((l, i) => (
								<div key={i} className={`fixed-patch-line ${l.kind}`}>
									<span className="fixed-patch-num">{l.kind === 'del' ? l.oldNo : l.newNo}</span>
									<span className="fixed-patch-sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
									<span>{l.text}</span>
								</div>
							))}
						</pre>
					))}
					{p.cut && <p className="muted">Cut to keep it short; the full diff is in the file view.</p>}
				</div>
			))}
			{patch.more > 0 && (
				<p className="muted">
					{patch.more} more {patch.more === 1 ? 'hunk' : 'hunks'} not shown; the full diff is in the file view.
				</p>
			)}
		</div>
	)
}
