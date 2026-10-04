import type { CiAnnotation, Finding, FindingSupport } from '../../shared/types.ts'
import type { ContextFact, FileSource } from './context.ts'
import type { FileImporters } from './imports.ts'
import { fileKind } from './risk.ts'

/**
 * Evidence the app checks findings against after the review, without running any code: messages CI tools attached to
 * lines of the head commit (read from GitHub), and which tests import the file a finding is in (from the import trace).
 * It never confirms a claim on its own: a CI message on the same lines says a tool flagged them too, a test that imports
 * the file says something exercises it.
 */
export interface EvidenceIndex {
	annotations: Array<CiAnnotation>
	importers: Array<FileImporters> | null // null: imports were not traced, so nothing can be said about tests
	changedTests: Set<string> // test files this change touches
	changedLines: Map<string, Set<number>> // head path → added lines
}

const NEAR = 2 // lines of slack between a CI message and a finding
const MAX_CI_PER_FINDING = 3
const MAX_PER_FILE_FACT = 15
const MAX_UNCOVERED = 50

export function buildEvidence(
	sources: Array<FileSource>,
	annotations: Array<CiAnnotation>,
	importers: Array<FileImporters> | null,
): EvidenceIndex {
	const changedLines = new Map<string, Set<number>>()
	const changedTests = new Set<string>()
	for (const { file, patch } of sources) {
		if (!file.newPath) continue
		if (fileKind(file.newPath) === 'test') changedTests.add(file.newPath)
		if (patch.kind !== 'text') continue
		const lines = new Set<number>()
		for (const h of patch.hunks) for (const l of h.lines) if (l.kind === 'add' && l.newNo !== null) lines.add(l.newNo)
		changedLines.set(file.newPath, lines)
	}
	return { annotations, importers, changedTests, changedLines }
}

export function supportFor(f: Finding, ev: EvidenceIndex): Array<FindingSupport> {
	const out: Array<FindingSupport> = []
	const a = f.anchor
	if (a.side === 'new' && a.newPath && a.startLine !== null) {
		const end = a.endLine ?? a.startLine
		const hits = ev.annotations.filter((x) => x.path === a.newPath && x.startLine <= end + NEAR && x.endLine >= a.startLine! - NEAR)
		for (const x of hits.slice(0, MAX_CI_PER_FINDING))
			out.push({ source: 'ci', strength: x.level === 'notice' ? 'context' : 'flags', text: describe(x) })
	}
	if (ev.importers) {
		const path = a.newPath ?? a.oldPath
		const imp = ev.importers.find((x) => x.fileKey === a.fileKey)
		const tests = imp?.tests ?? []
		if (tests.length) {
			const changed = tests.filter((t) => ev.changedTests.has(t))
			out.push({
				source: 'tests',
				strength: 'context',
				text: `Imported by ${tests.length} test file${tests.length === 1 ? '' : 's'}: ${list(tests)}${
					changed.length === tests.length
						? `; ${tests.length === 1 ? 'it is' : 'all are'} changed in this change`
						: changed.length
							? `; ${list(changed)} ${changed.length === 1 ? 'is' : 'are'} changed in this change`
							: `; ${tests.length === 1 ? 'it is not' : 'none of them is'} changed in this change`
				}.`,
			})
		} else if (path && fileKind(path) === 'code')
			out.push({ source: 'tests', strength: 'context', text: 'No test file imports this file, as far as import lines show.' })
	}
	return out
}

/** CI failures and warnings on lines this change added that no finding is near: problems the review may have missed. */
export function uncoveredCi(findings: Array<Finding>, ev: EvidenceIndex): Array<CiAnnotation> {
	return ev.annotations
		.filter((x) => x.level !== 'notice')
		.filter((x) => {
			const lines = ev.changedLines.get(x.path)
			if (!lines) return false
			for (let n = x.startLine; n <= x.endLine; n++) if (lines.has(n)) return true
			return false
		})
		.filter(
			(x) =>
				!findings.some(
					(f) =>
						f.anchor.side === 'new' &&
						f.anchor.newPath === x.path &&
						f.anchor.startLine !== null &&
						f.anchor.startLine <= x.endLine + NEAR &&
						(f.anchor.endLine ?? f.anchor.startLine) >= x.startLine - NEAR,
				),
		)
		.slice(0, MAX_UNCOVERED)
}

/** What the reviewer is told before it reviews: the CI messages on each changed file. */
export function annotationFacts(annotations: Array<CiAnnotation>, sources: Array<FileSource>): Array<ContextFact> {
	const out: Array<ContextFact> = []
	for (const { file } of sources) {
		const mine = annotations.filter((x) => x.path === file.newPath)
		if (!mine.length) continue
		const shown = mine.slice(0, MAX_PER_FILE_FACT).map((x) => `- ${describe(x)}`)
		if (mine.length > shown.length) shown.push(`- … and ${mine.length - shown.length} more`)
		out.push({ kind: 'ci', title: `CI annotations on ${file.newPath}`, text: shown.join('\n'), fileKeys: [file.key] })
	}
	return out
}

function describe(x: CiAnnotation): string {
	const lines = x.endLine !== x.startLine ? `lines ${x.startLine}-${x.endLine}` : `line ${x.startLine}`
	const msg = `${x.title ? `${x.title}: ` : ''}${x.message}`.replace(/\s+/g, ' ').trim()
	return `${x.check} (${x.level}) at ${lines}: ${msg.length > 300 ? `${msg.slice(0, 299)}…` : msg}`
}

function list(xs: Array<string>): string {
	return xs.length > 4 ? `${xs.slice(0, 4).join(', ')} and ${xs.length - 4} more` : xs.join(', ')
}
