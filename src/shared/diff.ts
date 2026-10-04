import type { Hunk } from './types.ts'

/** Unchanged lines not included in the patch. `old = new + offset`. `to === null` means "until end of file, length unknown". */
export interface Gap {
	from: number
	to: number | null
	offset: number
}

/** Computes the unchanged gaps around hunks in new-file coordinates. */
export function computeGaps(hunks: Array<Hunk>, totalNew: number | null): Array<Gap> {
	const gaps: Array<Gap> = []
	let prevNew = 0
	let prevOld = 0
	for (const h of hunks) {
		const nf = h.newCount ? h.newStart : h.newStart + 1
		const of = h.oldCount ? h.oldStart : h.oldStart + 1
		gaps.push({ from: prevNew + 1, to: nf - 1, offset: of - nf })
		prevNew = nf + h.newCount - 1
		prevOld = of + h.oldCount - 1
	}
	gaps.push({ from: prevNew + 1, to: totalNew, offset: prevOld - prevNew })
	return gaps
}
