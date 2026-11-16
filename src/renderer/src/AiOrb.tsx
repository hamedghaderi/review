import { Orb } from '@yogesharc/thinking-orbs'
import { useReducedMotion } from './motion.ts'

export type AiActivity = 'searching' | 'reasoning' | 'working' | 'waiting' | 'retrying'

/**
 * What an AI is doing right now, as an animated orb (thinking-orbs: SVG only, no network). It holds still when motion
 * is reduced, by the system or in Settings › Accessibility. Drawn in the accent color; `label` makes it readable to
 * screen readers, otherwise it is decorative.
 */
export function AiOrb({ activity, size = 16, label }: { activity: AiActivity; size?: number; label?: string }) {
	const still = useReducedMotion()
	return (
		<span className="ai-orb" style={{ width: size, height: size }}>
			<Orb state={activity} size={size} label={label} paused={still} />
		</span>
	)
}
