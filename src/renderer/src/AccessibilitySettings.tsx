import { useState } from 'react'
import { announce, announceLevel, setAnnounceLevel, type AnnounceLevel } from './announce.ts'
import { motionPref, setMotionPref, type MotionPref } from './motion.ts'

const OPTIONS: ReadonlyArray<{ id: AnnounceLevel; label: string; hint: string }> = [
	{
		id: 'all',
		label: 'Everything',
		hint: 'What the AI is doing (“Reading the code…”, a review starting) and what it answered.',
	},
	{ id: 'results', label: 'Only results', hint: 'Answers, drafts and how a review ended. Nothing while it works.' },
	{ id: 'off', label: 'Nothing', hint: 'Screen readers are told nothing about the AI. What’s on screen doesn’t change.' },
]

const MOTION: ReadonlyArray<{ id: MotionPref; label: string; hint: string }> = [
	{ id: 'system', label: 'Follow the system', hint: 'Reduce motion when macOS, Windows or Linux is set to.' },
	{ id: 'reduce', label: 'Reduce motion', hint: 'No animations or transitions: spinners and the AI mark hold still.' },
	{ id: 'full', label: 'Keep motion', hint: 'Animations even when the system asks for less.' },
]

/**
 * Settings › Accessibility: how much screen readers are told about the AI (issue #217), and reduced motion (issue
 * #219). Kept on this computer; the review window follows a change at once.
 */
export function AccessibilitySettings() {
	const [level, setLevel] = useState<AnnounceLevel>(announceLevel)
	const [motion, setMotion] = useState<MotionPref>(motionPref)
	const pick = (l: AnnounceLevel): void => {
		setAnnounceLevel(l)
		setLevel(l)
	}
	const pickMotion = (m: MotionPref): void => {
		setMotionPref(m)
		setMotion(m)
	}
	return (
		<div className="form">
			<h3>Accessibility</h3>
			<fieldset className="radio-list">
				<legend>Read AI activity aloud with a screen reader</legend>
				<p className="muted small">
					Your focus stays where you typed, so a screen reader can miss an answer arriving elsewhere. Review says it once it’s complete; a
					code block or table is described by its size.
				</p>
				{OPTIONS.map((o) => (
					<label key={o.id} className="radio">
						<input type="radio" name="announce" checked={level === o.id} onChange={() => pick(o.id)} />
						<span>
							{o.label}
							<span className="muted block small">{o.hint}</span>
						</span>
					</label>
				))}
			</fieldset>
			<div>
				<button
					className="btn small"
					disabled={level === 'off'}
					onClick={() => announce('This is how Review tells your screen reader what the AI said.', 'result')}
				>
					Try it
				</button>
			</div>
			<fieldset className="radio-list">
				<legend>Motion</legend>
				{MOTION.map((o) => (
					<label key={o.id} className="radio">
						<input type="radio" name="motion" checked={motion === o.id} onChange={() => pickMotion(o.id)} />
						<span>
							{o.label}
							<span className="muted block small">{o.hint}</span>
						</span>
					</label>
				))}
			</fieldset>
		</div>
	)
}
