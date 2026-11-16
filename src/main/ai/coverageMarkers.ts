import type { ContextFact, FileSource } from './context.ts'

/**
 * Lines a change adds that tell a coverage tool to skip code (issue #207). Agents put them on error handlers far more
 * often than people do, so they mark paths no test was required to run. Found by matching text on added lines; the
 * reviewer is told where they are, and a marker alone is never a finding.
 */
const MARKER =
	/pragma:\s*no\s*cover|\b(?:istanbul|c8|v8)\s+ignore\b|@codeCoverageIgnore|\bExcludeFromCodeCoverage\b|:nocov:|\bLCOV_EXCL_|\bcoverage:ignore-|\bcoverage\(off\)/i
const MAX_PER_FILE = 10
const MAX_TEXT = 160

export interface CoverageMarkers {
	facts: Array<ContextFact>
	summary: string
}

export function coverageMarkerFacts(sources: ReadonlyArray<FileSource>): CoverageMarkers | null {
	const facts: Array<ContextFact> = []
	let total = 0
	for (const s of sources) {
		if (s.patch.kind !== 'text') continue
		const hits = s.patch.hunks.flatMap((h) => h.lines.filter((l) => l.kind === 'add' && l.newNo !== null && MARKER.test(l.text)))
		if (!hits.length) continue
		total += hits.length
		const path = s.file.newPath ?? s.file.key
		const shown = hits.slice(0, MAX_PER_FILE).map((l) => `- line ${l.newNo}: ${clip(l.text.trim())}`)
		const more = hits.length > MAX_PER_FILE ? [`- and ${hits.length - MAX_PER_FILE} more`] : []
		facts.push({
			kind: 'coverage',
			title: 'Coverage exclusions this change adds',
			text: [`${path}:`, ...shown, ...more].join('\n'),
			fileKeys: [s.file.key],
		})
	}
	if (!facts.length) return null
	const files = facts.length
	return {
		facts,
		summary: `${total} coverage exclusion${total === 1 ? '' : 's'} added in ${files} file${files === 1 ? '' : 's'}; the reviewer was pointed at the code ${total === 1 ? 'it skips' : 'they skip'}.`,
	}
}

function clip(text: string): string {
	return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text
}
