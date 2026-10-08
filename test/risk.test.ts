import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildContext, type FileSource } from '../src/main/ai/context.ts'
import type { RelatedResult } from '../src/main/ai/related.ts'
import { byRisk, classifyRisk } from '../src/main/ai/risk.ts'
import { changeRisk, type ChangedFile, type Comparison, type DiffLine, type FileStatus } from '../src/shared/types.ts'

function source(
	path: string,
	lines: Array<[DiffLine['kind'], string]>,
	status: FileStatus = 'modified',
	counts?: [number, number],
): FileSource {
	const file: ChangedFile = {
		key: path,
		status,
		oldPath: status === 'added' ? null : path,
		newPath: status === 'deleted' ? null : path,
		additions: counts?.[0] ?? lines.filter(([k]) => k === 'add').length,
		deletions: counts?.[1] ?? lines.filter(([k]) => k === 'del').length,
		binary: false,
		similarity: null,
	}
	let o = 1
	let n = 1
	const diff: Array<DiffLine> = lines.map(([kind, text]) => ({
		kind,
		text,
		oldNo: kind === 'add' ? null : o++,
		newNo: kind === 'del' ? null : n++,
	}))
	return {
		file,
		patch: { kind: 'text', hunks: [{ oldStart: 1, oldLines: o - 1, newStart: 1, newLines: n - 1, section: '', lines: diff }] },
		fullText: null,
	} as FileSource
}

const edit = (path: string, from = 'const a = 1', to = 'const a = 2'): FileSource =>
	source(path, [
		['del', from],
		['add', to],
	])

function levels(sources: Array<FileSource>, related: RelatedResult | null = null): Record<string, string> {
	return Object.fromEntries(classifyRisk(sources, related).map((r) => [r.fileKey, `${r.level}: ${r.reasons.join('; ')}`]))
}

test('risk: sensitive areas, schema, deploy config and manifests are high or medium; tests, docs, locks and generated files are low', () => {
	const got = levels([
		edit('src/auth/session.ts'),
		edit('app/Services/PaymentService.php'),
		edit('database/migrations/2026_10_04_add_tax.php'),
		edit('.github/workflows/ci.yml'),
		edit('package.json', '"x": "1"', '"x": "2"'),
		edit('src/ui/Button.tsx'),
		edit('config/app.yml', 'a: 1', 'a: 2'),
		edit('src/auth/session.test.ts'),
		edit('tests/Feature/PaymentTest.php'),
		edit('docs/auth.md'),
		edit('package-lock.json'),
		edit('dist/bundle.min.js'),
	])
	assert.match(got['src/auth/session.ts'], /^high: security-sensitive area/)
	assert.match(got['app/Services/PaymentService.php'], /^high: handles money/, 'words inside camel-case names count')
	assert.match(got['database/migrations/2026_10_04_add_tax.php'], /^high: .*database migration/)
	assert.match(got['.github/workflows/ci.yml'], /^medium: build or deployment configuration/)
	assert.match(got['package.json'], /^medium: dependency manifest/)
	assert.equal(got['src/ui/Button.tsx'], 'medium: source code')
	assert.equal(got['config/app.yml'], 'low: not source code')
	// The file's kind wins over the folder it is in.
	assert.equal(got['src/auth/session.test.ts'], 'low: test file')
	assert.equal(got['tests/Feature/PaymentTest.php'], 'low: test file')
	assert.equal(got['docs/auth.md'], 'low: documentation')
	assert.match(got['package-lock.json'], /^low: lock file/)
	assert.match(got['dist/bundle.min.js'], /^low: generated/)
})

test('risk: removed and redefined names, callers in other files, deletions and size raise a file', () => {
	const removes = source('src/cart.ts', [
		['del', 'export function legacyTotal(items) {'],
		['del', '  return total(items)'],
		['del', '}'],
	])
	const redefines = source('src/calc.ts', [
		['del', 'export function total(items) {'],
		['add', 'export function total(items, taxRate) {'],
	])
	const big = source('src/report.ts', [['add', 'const x = 1']], 'modified', [250, 120])
	const gone = source('src/old.ts', [['del', 'const y = 2']], 'deleted')
	const related: RelatedResult = {
		symbols: 2,
		notes: [],
		snippets: [
			{ path: 'src/checkout.ts', start: 1, end: 3, lines: [], reasons: [], fileKeys: new Set(['src/calc.ts']), priority: 0 },
			{ path: 'src/admin.ts', start: 1, end: 3, lines: [], reasons: [], fileKeys: new Set(['src/calc.ts']), priority: 0 },
			{ path: 'src/util.ts', start: 1, end: 3, lines: [], reasons: [], fileKeys: new Set(['src/calc.ts']), priority: 1 },
		],
	}
	const got = levels([removes, redefines, big, gone], related)
	assert.equal(got['src/cart.ts'], 'high: removes or renames `legacyTotal`')
	assert.equal(
		got['src/calc.ts'],
		'high: changes the definition of `total`; 2 other files use what it changes',
		'definitions are not callers',
	)
	assert.equal(got['src/report.ts'], 'high: large change (370 lines)')
	assert.equal(got['src/old.ts'], 'high: deletes a source file')
	// Without the related-code search there are no callers to count.
	assert.equal(levels([redefines])['src/calc.ts'], 'high: changes the definition of `total`')
})

test('risk: riskiest files are packed first, so the run limit leaves out low-risk code; the overview names each file’s risk', () => {
	const sources = [edit('README.md', 'old', 'new'), edit('src/ui/Button.tsx'), edit('src/auth/login.ts')]
	const risk = classifyRisk(sources, null)
	assert.deepEqual(
		byRisk(sources, risk).map((s) => s.file.key),
		['src/auth/login.ts', 'src/ui/Button.tsx', 'README.md'],
	)
	const comparison: Comparison = {
		id: 'a..b',
		repoId: 'r',
		baseRef: 'main',
		baseTipSha: 'a',
		baseSha: 'a',
		headSha: 'b',
		headRef: 'topic',
		target: null,
		pr: null,
		files: sources.map((s) => s.file),
	}
	// Room for two excerpts only.
	const one = buildContext(comparison, sources, { contextLines: 3, maxBatchChars: 200_000, maxRunChars: 200_000 }, [], [], risk).batches[0]
	const size = one.excerpts[0].text.length
	const pkg = buildContext(comparison, sources, { contextLines: 3, maxBatchChars: 200_000, maxRunChars: size * 2 + 10 }, [], [], risk)
	assert.deepEqual(
		pkg.supplied.map((s) => s.fileKey),
		['src/auth/login.ts', 'src/ui/Button.tsx'],
	)
	assert.equal(pkg.files.find((f) => f.fileKey === 'README.md')?.state, 'skipped')
	assert.deepEqual(pkg.files.find((f) => f.fileKey === 'src/auth/login.ts')?.risk, {
		fileKey: 'src/auth/login.ts',
		level: 'high',
		reasons: ['security-sensitive area'],
	})
	assert.match(pkg.batches[0].overview, /src\/auth\/login\.ts \(\+1 -1\) \[IN THIS REQUEST\] risk high: security-sensitive area/)
	assert.match(pkg.batches[0].overview, /README\.md \(\+1 -1\) \[not supplied\] risk low: documentation/)
})

test('risk: a change is as risky as its riskiest file', () => {
	const rate = (...paths: Array<string>) =>
		changeRisk(
			classifyRisk(
				paths.map((p) => edit(p)),
				null,
			).map((risk) => ({ risk })),
		)
	assert.equal(rate('README.md', 'src/auth/login.ts'), 'high')
	assert.equal(rate('README.md', 'src/app.ts'), 'medium')
	assert.equal(rate('README.md', 'test/app.test.ts'), 'low')
	assert.equal(changeRisk([]), null)
})
