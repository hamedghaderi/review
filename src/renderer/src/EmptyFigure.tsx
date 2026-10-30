import { useLayoutEffect, useRef } from 'react'
import { branches, loupe } from '@lucasmarkes/hairline'

// The plain-DOM entry, not /react: that one builds all 33 components at import, so none of them can be tree-shaken.
const figures = { loupe, branches }

/**
 * A line drawing above an empty state (hairline: SVG only, no network, moves only under the pointer). Colours come
 * from the theme through the --hairline-* variables in styles.css. Decorative: the text beside it says what happened.
 */
export function EmptyFigure({ figure }: { figure: keyof typeof figures }) {
	const el = useRef<HTMLDivElement>(null)
	useLayoutEffect(() => {
		const f = figures[figure](el.current!)
		return () => f.destroy()
	}, [figure])
	return <div ref={el} className="empty-figure" aria-hidden />
}
