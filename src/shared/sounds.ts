/** What can make a sound: GitHub events from the watcher, and the AI finishing work you started. */
export const SOUND_EVENTS = ['request', 'commits', 'autoReview', 'runFinished', 'answer'] as const
export type SoundEvent = (typeof SOUND_EVENTS)[number]

/** The built-in sounds. They are made in the window with Web Audio (see renderer sounds.ts), so no files ship. */
export const SOUNDS = ['chime', 'ping', 'pop', 'bell', 'marimba', 'drop'] as const
export type SoundId = (typeof SOUNDS)[number]
export type SoundChoice = SoundId | 'off'
/** The sound each event plays. An app setting, like the theme; not tied to GitHub. */
export type SoundPrefs = Record<SoundEvent, SoundChoice>

export const SOUND_LABELS: Record<SoundId, string> = {
	chime: 'Chime',
	ping: 'Ping',
	pop: 'Pop',
	bell: 'Bell',
	marimba: 'Marimba',
	drop: 'Drop',
}

export const SOUND_EVENT_LABELS: Record<SoundEvent, { label: string; hint: string }> = {
	request: { label: 'Review requested', hint: 'A new request, a request after you reviewed, or a draft marked ready' },
	commits: { label: 'New commits', hint: 'On a pull request you reviewed' },
	autoReview: { label: 'Automatic review done', hint: 'The app reviewed a pull request for you' },
	runFinished: { label: 'AI review finished', hint: 'A review run you started has finished' },
	answer: { label: 'AI answer ready', hint: 'A conclusion, explanation, drafted reply or answer to your question' },
}

export const DEFAULT_SOUNDS: SoundPrefs = {
	request: 'chime',
	commits: 'ping',
	autoReview: 'bell',
	runFinished: 'marimba',
	answer: 'pop',
}

/**
 * Each event's sound from stored settings: unknown values fall back to the default. Before sounds could be picked there
 * was one switch, "Play a sound" in the GitHub notification settings; when it was off, every event stays silent.
 */
export function storedSounds(raw: unknown, legacySound?: unknown): SoundPrefs {
	const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
	const out = { ...DEFAULT_SOUNDS }
	for (const e of SOUND_EVENTS) {
		const v = o?.[e]
		if (v === 'off' || SOUNDS.includes(v as SoundId)) out[e] = v as SoundChoice
		else if (!o && legacySound === false) out[e] = 'off'
	}
	return out
}
