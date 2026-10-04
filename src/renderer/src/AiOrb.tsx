import { Orb } from '@yogesharc/thinking-orbs'

export type AiActivity = 'searching' | 'reasoning' | 'working' | 'waiting' | 'retrying'

/**
 * What an AI is doing right now, as an animated orb (thinking-orbs: SVG only, no network, holds still with reduced
 * motion). Drawn in the accent color; `label` makes it readable to screen readers, otherwise it is decorative.
 */
export function AiOrb({ activity, size = 16, label }: { activity: AiActivity; size?: number; label?: string }) {
	return (
		<span className="ai-orb" style={{ width: size, height: size }}>
			<Orb state={activity} size={size} label={label} />
		</span>
	)
}
