import type { SoundId } from '../../shared/sounds.ts'

/** One tone: a frequency (gliding to `to`, if set) that starts `at` seconds in, then fades out over `dur` seconds. */
interface Tone {
	freq: number
	to?: number
	at: number
	dur: number
	gain: number
	wave?: OscillatorType
}

// Short and quiet on purpose: they mark that something happened, they don't demand attention.
const RECIPES: Record<SoundId, Array<Tone>> = {
	chime: [
		{ freq: 880, at: 0, dur: 0.6, gain: 0.18 },
		{ freq: 1318.5, at: 0.12, dur: 0.7, gain: 0.15 },
	],
	ping: [{ freq: 1568, at: 0, dur: 0.35, gain: 0.16 }],
	pop: [{ freq: 380, to: 900, at: 0, dur: 0.12, gain: 0.22 }],
	bell: [
		{ freq: 523.25, at: 0, dur: 1.2, gain: 0.16 },
		{ freq: 1046.5, at: 0, dur: 0.8, gain: 0.07 },
		{ freq: 1568, at: 0, dur: 0.5, gain: 0.04 },
	],
	marimba: [
		{ freq: 784, at: 0, dur: 0.25, gain: 0.18, wave: 'triangle' },
		{ freq: 987.8, at: 0.1, dur: 0.25, gain: 0.18, wave: 'triangle' },
		{ freq: 1174.7, at: 0.2, dur: 0.4, gain: 0.18, wave: 'triangle' },
	],
	drop: [{ freq: 1200, to: 500, at: 0, dur: 0.25, gain: 0.18 }],
}

let ctx: AudioContext | null = null

/** Plays a built-in sound. Errors are ignored: a missing sound must never break what triggered it. */
export function playSound(id: SoundId): void {
	try {
		ctx ??= new AudioContext()
		if (ctx.state === 'suspended') void ctx.resume()
		const start = ctx.currentTime + 0.01
		for (const t of RECIPES[id]) {
			const osc = ctx.createOscillator()
			const gain = ctx.createGain()
			osc.type = t.wave ?? 'sine'
			osc.frequency.setValueAtTime(t.freq, start + t.at)
			if (t.to) osc.frequency.exponentialRampToValueAtTime(t.to, start + t.at + t.dur * 0.6)
			// A quick rise avoids a click; the exponential fall sounds like a struck note.
			gain.gain.setValueAtTime(0.0001, start + t.at)
			gain.gain.exponentialRampToValueAtTime(t.gain, start + t.at + 0.01)
			gain.gain.exponentialRampToValueAtTime(0.0001, start + t.at + t.dur)
			osc.connect(gain).connect(ctx.destination)
			osc.start(start + t.at)
			osc.stop(start + t.at + t.dur + 0.05)
		}
	} catch {
		// No audio device, or audio blocked: stay silent.
	}
}
