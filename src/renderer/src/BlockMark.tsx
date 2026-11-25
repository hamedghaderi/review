export type AiActivity = 'searching' | 'reasoning' | 'working' | 'waiting'

/**
 * Review's mark: the app icon's R as three blocks (stem, bowl, leg), drawn in the accent colour. While an AI works the
 * blocks move, each activity its own way (styles.css, `.block-mark`); `settle` brings them in from scattered once and
 * stops on the R. At rest, and whenever motion is reduced, it is just the R. `label` makes it readable to screen
 * readers, otherwise it is decorative.
 */
export function BlockMark({ activity, size = 16, label }: { activity: AiActivity | 'settle'; size?: number; label?: string }) {
	return (
		<svg
			className={`block-mark block-mark--${activity}`}
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="currentColor"
			role={label ? 'img' : undefined}
			aria-label={label}
			aria-hidden={label ? undefined : true}
		>
			<rect className="block-mark__stem" x="1.5" y="1.5" width="3.6" height="13" rx="0.9" />
			<path
				className="block-mark__bowl"
				fillRule="evenodd"
				d="M6.8 1.5H10a4.05 4.05 0 0 1 0 8.1H6.8ZM6.8 4.3H10a1.25 1.25 0 0 1 0 2.5H6.8Z"
			/>
			<path className="block-mark__leg" d="M6.8 10.5h3.6l4 4h-3.6Z" />
		</svg>
	)
}
