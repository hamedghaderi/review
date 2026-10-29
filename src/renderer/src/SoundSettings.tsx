import { useEffect, useState } from 'react'
import {
	SOUND_EVENT_LABELS,
	SOUND_EVENTS,
	SOUND_LABELS,
	SOUNDS,
	type SoundChoice,
	type SoundEvent,
	type SoundPrefs,
} from '../../shared/sounds.ts'
import { playSound } from './sounds.ts'

/**
 * Settings › Sounds: the sound each event plays, picked from the built-in ones. The GitHub events only happen while
 * review-request notifications are on (`githubNotifications`); the others always can.
 */
export function SoundSettings({ githubNotifications }: { githubNotifications: boolean }) {
	const [sounds, setSounds] = useState<SoundPrefs | null>(null)
	const [error, setError] = useState<string | null>(null)
	useEffect(() => {
		void window.review.sounds().then((r) => (r.ok ? setSounds(r.value) : setError(r.error.message)))
	}, [])
	if (!sounds) return <div className="form">{error && <p className="small error-text">{error}</p>}</div>

	const pick = async (e: SoundEvent, choice: SoundChoice): Promise<void> => {
		if (choice !== 'off') playSound(choice)
		const next = { ...sounds, [e]: choice }
		setSounds(next)
		setError(null)
		const r = await window.review.setSounds(next)
		if (r.ok) setSounds(r.value)
		else setError(r.error.message)
	}
	const github = (e: SoundEvent) => e === 'request' || e === 'commits'
	return (
		<div className="form">
			<h3>Sounds</h3>
			<p className="muted small">
				A short sound when something happens, so you can tell what it was without looking. When you are in another app, the AI events also
				show a notification.
			</p>
			<table className="sound-table small">
				<tbody>
					{SOUND_EVENTS.map((e) => {
						const choice = sounds[e]
						const off = github(e) && !githubNotifications
						return (
							<tr key={e}>
								<td>
									{SOUND_EVENT_LABELS[e].label}
									<span className="muted block">
										{off ? 'Review-request notifications are off, in GitHub › Notifications' : SOUND_EVENT_LABELS[e].hint}
									</span>
								</td>
								<td>
									<select
										value={choice}
										disabled={off}
										aria-label={`Sound for ${SOUND_EVENT_LABELS[e].label}`}
										onChange={(ev) => void pick(e, ev.target.value as SoundChoice)}
									>
										<option value="off">Off</option>
										{SOUNDS.map((s) => (
											<option key={s} value={s}>
												{SOUND_LABELS[s]}
											</option>
										))}
									</select>
								</td>
								<td>
									<button
										className="btn small ghost"
										disabled={choice === 'off' || off}
										onClick={() => choice !== 'off' && playSound(choice)}
										aria-label={`Play the sound for ${SOUND_EVENT_LABELS[e].label}`}
										title="Play"
									>
										▶
									</button>
								</td>
							</tr>
						)
					})}
				</tbody>
			</table>
			{error && <p className="small error-text">{error}</p>}
		</div>
	)
}
