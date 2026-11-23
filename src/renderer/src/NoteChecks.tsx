import { NOTE_ACCEPTED_WARN, type NoteCheck, type NoteFindingRef, type NotePeriod } from '../../shared/types.ts'

/**
 * How a reviewer note is doing (issue #278): what was raised of its kind before and since it was added, and the
 * warnings that it may hide real problems. Shown on Outcomes and on the note itself; Review never changes a note
 * because of them.
 */

const when = (iso: string): string => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

function periodText(p: NotePeriod): string {
	if (!p.runs && !p.raised) return 'no runs reviewed its files'
	const runs = `${p.runs} run${p.runs === 1 ? '' : 's'} on its files raised ${p.raised || 'no'} finding${p.raised === 1 ? '' : 's'} of its kind`
	if (!p.raised) return runs
	return `${runs}; you dismissed ${p.dismissed} and accepted ${p.accepted}`
}

/** Before and since the note, in one line each. */
export function NotePeriods({ check: c }: { check: NoteCheck }) {
	return (
		<div className="small note-periods">
			<div>
				<span className="muted">Before the note:</span> {periodText(c.before)}.
			</div>
			<div>
				<span className="muted">Since {when(c.note.addedAt)}:</span> {periodText(c.after)}
				{c.marked ? `. The reviewer said this note covers ${c.marked} of them` : ''}.
			</div>
		</div>
	)
}

/** The warnings and what changed after merge. `actions` go under a warning: Edit and Switch off, on the note's own page. */
export function NoteWarnings({ check: c, actions }: { check: NoteCheck; actions?: React.ReactNode }) {
	const github = c.key.startsWith('local:') ? null : c.key
	const accepted = c.acceptedUnder.length >= NOTE_ACCEPTED_WARN
	if (!accepted && !c.reverted.length && !c.changed.length) return null
	return (
		<div className="note-warnings small">
			{accepted && (
				<div className="discussed-note raised-note rejected">
					<b>You accepted {c.acceptedUnder.length} findings the reviewer said this note covers.</b> The note may be wrong or too broad for
					them.
					<RefList refs={c.acceptedUnder} github={null} />
				</div>
			)}
			{c.reverted.length > 0 && (
				<div className="discussed-note raised-note rejected">
					<b>
						{c.reverted.length} dismissed finding{c.reverted.length === 1 ? '' : 's'} of this kind{' '}
						{c.reverted.length === 1 ? 'was' : 'were'} reverted after merge.
					</b>{' '}
					The pull request was undone on those lines, so the problem may have been real.
					<RefList refs={c.reverted} github={github} />
				</div>
			)}
			{(accepted || c.reverted.length > 0) && actions}
			{c.changed.length > 0 && (
				<details>
					<summary className="muted">
						{c.changed.length} dismissed finding{c.changed.length === 1 ? '' : 's'} of this kind had{' '}
						{c.changed.length === 1 ? 'its' : 'their'} lines changed after merge. Nothing judged whether that fixed anything.
					</summary>
					<RefList refs={c.changed} github={github} />
				</details>
			)}
		</div>
	)
}

function RefList({ refs, github }: { refs: Array<NoteFindingRef>; github: string | null }) {
	return (
		<ul className="dismissal-list">
			{refs.map((r) => (
				<li key={`${r.reviewId}:${r.findingId}`}>
					<span className="mono">{r.target}</span> · <span className="mono">{`${r.path}${r.line ? `:${r.line}` : ''}`}</span> · “{r.title}”
					{r.commit && (
						<>
							{' · '}
							{github ? (
								<a
									className="mono"
									href={`https://github.com/${github}/commit/${r.commit.sha}`}
									target="_blank"
									rel="noreferrer"
									title={r.commit.subject}
								>
									{r.commit.sha.slice(0, 7)} ↗
								</a>
							) : (
								<span className="mono" title={r.commit.subject}>
									{r.commit.sha.slice(0, 7)}
								</span>
							)}
						</>
					)}
				</li>
			))}
		</ul>
	)
}

/** True when a note has a warning: what Outcomes and the notes page draw attention to. */
export function noteWarned(c: NoteCheck): boolean {
	return c.acceptedUnder.length >= NOTE_ACCEPTED_WARN || c.reverted.length > 0
}
