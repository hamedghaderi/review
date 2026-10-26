import type { ReactNode } from 'react'
import type { ChangeExplanation } from '../../shared/types.ts'
import { AiOrb } from './AiOrb.tsx'
import { ago } from './branches.ts'

interface Props {
	explanation: ChangeExplanation | null
	busy: boolean
	error: string | null
	disabled: string | null // why it can't be asked now (no model for questions…)
	modelPicker: ReactNode // picks the model for questions, which answers
	described: boolean // the change has a description of its own
	onExplain(): void
	onOpenPath(path: string): void // opens a changed file
}

const SOURCE: Record<ChangeExplanation['source'], { label: string; title: string }> = {
	stated: { label: 'Stated by the author', title: 'The description, a linked issue or the commits say what it is for.' },
	inferred: { label: 'Worked out from the code', title: 'Nothing the author wrote says what it is for; this is read from the code.' },
	unclear: { label: 'Not clear', title: 'Neither the author’s text nor the code settles what it is for. Ask the author.' },
}

/**
 * "Explain this change": what the change is for, what behaves differently and where to start reading, from the model
 * for questions. The text is the model's, shown as plain text; it reads the code but can still be wrong.
 */
export function ExplainChange({ explanation: e, busy, error, disabled, modelPicker, described, onExplain, onOpenPath }: Props) {
	const ask = (label: string) => (
		<button className="btn small" onClick={onExplain} disabled={busy || !!disabled} title={disabled ?? undefined}>
			{busy ? (
				<>
					<AiOrb activity="reasoning" size={12} /> Reading the change…
				</>
			) : (
				label
			)}
		</button>
	)
	const file = (path: string) => (
		<button key={path} className="link mono" title={`Open ${path}`} onClick={() => onOpenPath(path)}>
			{path.split('/').pop()}
		</button>
	)
	if (!e)
		return (
			<section className="explain-change empty">
				<div className="small">
					<b>{described ? 'Not sure what this change is for?' : 'No description to go on?'}</b>{' '}
					<span className="muted">
						The AI reads the {described ? 'description, linked issues, ' : ''}commits and diff, and says what the change is for and where to
						start reading.
					</span>
				</div>
				<div className="ask-actions">
					{modelPicker}
					{ask('Explain this change')}
				</div>
				{error && <p className="small error-text">{error}</p>}
			</section>
		)
	return (
		<section className="explain-change">
			<div className="explain-head small">
				<b>What this change is for</b>
				<span className={`gh-pill source-${e.source}`} title={SOURCE[e.source].title}>
					{SOURCE[e.source].label}
				</span>
				<span className="spacer" />
				<span className="muted nowrap" title={new Date(e.at).toLocaleString()}>
					{e.model} · {ago(e.at)}
				</span>
			</div>
			<p className="explain-purpose selectable">{e.purpose}</p>
			{e.changes.length > 0 && (
				<>
					<div className="section-title">What changes</div>
					<ul className="explain-list small">
						{e.changes.map((c, i) => (
							<li key={i}>
								<span className="selectable">{c.what}</span>
								{c.files.length > 0 && <span className="explain-files"> {c.files.map(file)}</span>}
							</li>
						))}
					</ul>
				</>
			)}
			{e.readingOrder.length > 0 && (
				<>
					<div className="section-title">Where to start</div>
					<ol className="explain-list small">
						{e.readingOrder.map((r) => (
							<li key={r.path}>
								<button className="link mono" title="Open this file" onClick={() => onOpenPath(r.path)}>
									{r.path}
								</button>{' '}
								<span className="muted selectable">{r.why}</span>
							</li>
						))}
					</ol>
				</>
			)}
			{e.questions.length > 0 && (
				<>
					<div className="section-title">Ask the author</div>
					<ul className="explain-list small selectable">
						{e.questions.map((q, i) => (
							<li key={i}>{q}</li>
						))}
					</ul>
				</>
			)}
			{e.omitted.length > 0 && (
				<p className="small muted">
					{e.omitted.length} diff{e.omitted.length === 1 ? ' was' : 's were'} too big to send in full ({e.omitted.slice(0, 3).join(', ')}
					{e.omitted.length > 3 ? ` and ${e.omitted.length - 3} more` : ''}); the AI could look them up.
				</p>
			)}
			<div className="ask-actions">
				<span className="muted small">Read from the code, but it can be wrong.</span>
				<span className="spacer" />
				{modelPicker}
				{ask('Explain again')}
			</div>
			{error && <p className="small error-text">{error}</p>}
		</section>
	)
}
