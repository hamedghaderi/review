import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FileSource } from '../src/main/ai/context.ts'
import { coverageMarkerFacts } from '../src/main/ai/coverageMarkers.ts'
import type { DiffLine } from '../src/shared/types.ts'

function source(path: string, lines: Array<[DiffLine['kind'], string]>): FileSource {
	let next = 1
	const rows: Array<DiffLine> = lines.map(([kind, text]) => ({ kind, text, oldNo: null, newNo: kind === 'del' ? null : next++ }))
	return {
		file: { key: path, status: 'modified', oldPath: path, newPath: path, additions: 1, deletions: 0, binary: false, similarity: null },
		patch: { kind: 'text', bytes: 0, hunks: [{ oldStart: 1, oldCount: 0, newStart: 1, newCount: rows.length, section: '', lines: rows }] },
		fullText: null,
	}
}

test('coverage exclusions: added markers in each language, one fact per file with line numbers', () => {
	const result = coverageMarkerFacts([
		source('app/rules.py', [
			['ctx', 'def load():'],
			['add', '    try:'],
			['add', '        return read()'],
			['add', '    except OSError:  # pragma: no cover'],
			['add', '        return None'],
		]),
		source('src/a.ts', [
			['add', '/* istanbul ignore next */'],
			['add', 'catch (e) { /* c8 ignore next */ return null }'],
			['add', '/* v8 ignore start */'],
		]),
		source('lib/b.rb', [['add', '# :nocov:']]),
		source('src/C.cs', [['add', '[ExcludeFromCodeCoverage]']]),
		source('src/d.php', [['add', ' * @codeCoverageIgnore']]),
		source('src/e.cpp', [['add', 'x(); // LCOV_EXCL_LINE']]),
		source('lib/f.dart', [['add', '// coverage:ignore-line']]),
		source('src/g.rs', [['add', '#[coverage(off)]']]),
	])!
	assert.equal(result.facts.length, 8)
	assert.equal(result.facts[0].kind, 'coverage')
	assert.deepEqual(result.facts[0].fileKeys, ['app/rules.py'])
	assert.equal(result.facts[0].text, 'app/rules.py:\n- line 4: except OSError:  # pragma: no cover')
	assert.match(
		result.facts[1].text,
		/line 1: \/\* istanbul ignore next \*\/\n- line 2: .*c8 ignore next.*\n- line 3: \/\* v8 ignore start \*\//,
	)
	assert.match(result.summary, /^10 coverage exclusions added in 8 files/)
})

test('coverage exclusions: removed or unchanged markers and look-alikes are not counted; nothing found is null', () => {
	assert.equal(
		coverageMarkerFacts([
			source('a.py', [
				['del', 'x = 1  # pragma: no cover'],
				['ctx', 'y = 2  # pragma: no cover'],
				['add', '# coverage is ignored for generated files'],
				['add', 'const ignored = istanbulIgnoreList'],
			]),
		]),
		null,
	)
	const binary: FileSource = { ...source('img.png', []), patch: { kind: 'binary' } }
	assert.equal(coverageMarkerFacts([binary]), null)
})

test('coverage exclusions: a file with many markers lists ten and says how many more', () => {
	const many = Array.from({ length: 13 }, (_, i) => ['add', `x${i}()  # pragma: no cover`] as [DiffLine['kind'], string])
	const result = coverageMarkerFacts([source('a.py', many)])!
	assert.equal(result.facts[0].text.split('\n').length, 12)
	assert.match(result.facts[0].text, /- and 3 more$/)
	assert.match(result.summary, /^13 coverage exclusions added in 1 file;/)
})
