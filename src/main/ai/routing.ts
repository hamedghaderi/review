import type { FileRisk, ReviewRule } from '../../shared/types.ts'
import type { FileSource } from './context.ts'
import type { FileImporters } from './imports.ts'
import { fileKind, type FileKind } from './risk.ts'

/**
 * Which changed files a review team member gets, from the rules it owns: a rule only looks at the kinds of file it can
 * find something in. Security reads code and configuration the risk estimate does not rate low; tests are read by
 * whoever checks test value, together with the changed code those tests import; generated and vendored files go to
 * nobody. Routing applies to team runs only; a single reviewer gets every file.
 */
const APPLIES: Record<string, (kind: FileKind, risk: FileRisk | undefined) => boolean> = {
	bug: (k) => k === 'code' || k === 'other',
	'error-handling': (k) => k === 'code' || k === 'other',
	security: (k, r) => (k === 'code' || k === 'other') && r?.level !== 'low',
	// Lock files carry the dependency facts that show who a version change can break.
	'breaking-change': (k) => k === 'code' || k === 'other' || k === 'lock',
	'file-split': (k) => k === 'code',
	'over-engineered': (k) => k === 'code',
	convention: (k) => k === 'code',
	'test-value': (k) => k === 'test',
	residue: (k) => k === 'code' || k === 'test' || k === 'docs',
}

export function routeFiles(
	rules: ReadonlyArray<ReviewRule>,
	sources: Array<FileSource>,
	risk: Array<FileRisk>,
	importers: Array<FileImporters>,
): Set<string> {
	const riskOf = new Map(risk.map((r) => [r.fileKey, r]))
	const kinds = new Map(sources.map((s) => [s.file.key, fileKind(s.file.newPath ?? s.file.oldPath ?? s.file.key)]))
	const out = new Set<string>()
	for (const { file } of sources) {
		const kind = kinds.get(file.key)!
		if (rules.some((r) => APPLIES[r.startsWith('residue-') ? 'residue' : r]?.(kind, riskOf.get(file.key)))) out.add(file.key)
	}
	// Test value also looks at the changed code the changed tests exercise (test-only seams, tests that miss the change).
	if (rules.includes('test-value')) {
		const changedTests = new Set(sources.filter((s) => kinds.get(s.file.key) === 'test').map((s) => s.file.newPath ?? s.file.oldPath))
		for (const f of importers) if (f.tests.some((t) => changedTests.has(t))) out.add(f.fileKey)
	}
	return out
}

/** Why a file went to no member of the team. */
export function unroutedReason(source: FileSource | undefined): string {
	const kind = source ? fileKind(source.file.newPath ?? source.file.oldPath ?? source.file.key) : 'other'
	return kind === 'generated'
		? 'Generated, vendored or binary asset: none of the review rules apply'
		: "None of this team's rules apply to this kind of file"
}
