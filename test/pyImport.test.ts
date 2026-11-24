import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pythonImportAt } from '../src/shared/pyImport.ts'
import { pythonModuleFiles } from '../src/main/symbols.ts'

/** The import under the nth whole-word `name` in `line`. */
function at(line: string, name: string, nth = 0) {
	const found = [...line.matchAll(new RegExp(`\\b${name}\\b`, 'g'))]
	assert.ok(found[nth], `${name} in ${line}`)
	return pythonImportAt(line, found[nth].index)
}

test('a part of the module path in an import names that module, up to the clicked part', () => {
	const line = 'from shop.billing.context import Context'
	assert.deepEqual(at(line, 'context'), { level: 0, parts: ['shop', 'billing', 'context'], name: false })
	assert.deepEqual(at(line, 'billing'), { level: 0, parts: ['shop', 'billing'], name: false })
	assert.deepEqual(at(line, 'shop'), { level: 0, parts: ['shop'], name: false })
	assert.deepEqual(at('import shop.types as t, os', 'types'), { level: 0, parts: ['shop', 'types'], name: false })
	assert.deepEqual(at('import shop.types as t, os', 'os'), { level: 0, parts: ['os'], name: false })
	assert.deepEqual(at('    from ..helpers.results import ok  # noqa', 'results'), { level: 2, parts: ['helpers', 'results'], name: false })
})

test('a name imported from a module may be a module of it; an alias or a non-import line is neither', () => {
	assert.deepEqual(at('from shop.billing.context import Context', 'Context'), {
		level: 0,
		parts: ['shop', 'billing', 'context', 'Context'],
		name: true,
	})
	assert.deepEqual(at('from . import context, types as t', 'types'), { level: 1, parts: ['types'], name: true })
	assert.deepEqual(at('from shop import (', 'shop'), { level: 0, parts: ['shop'], name: false })
	assert.equal(at('from . import context, types as t', 't'), null, 'the alias')
	assert.equal(at('import shop.types as t', 't'), null, 'the alias')
	assert.equal(at('    context = make_context()', 'context'), null)
	assert.equal(at('    CHUNK_SIZE,', 'CHUNK_SIZE'), null, 'a later line of a parenthesised import is looked up by name')
})

test("a module's files: by path tail anywhere in a monorepo, relative from the clicked file, skipping virtualenvs", () => {
	const paths = [
		'shop/src/shop/__init__.py',
		'shop/src/shop/billing/__init__.py',
		'shop/src/shop/billing/context.py',
		'shop/src/shop/types.py',
		'shop/src/shop/types.pyi',
		'shop/.venv/lib/shop/types.py',
		'api/src/api/types.py',
		'api/src/api/route/event_log.py',
	]
	const ref = (parts: Array<string>, level = 0) => ({ level, parts, name: false })
	assert.deepEqual(pythonModuleFiles(paths, null, ref(['shop', 'billing', 'context'])), ['shop/src/shop/billing/context.py'])
	assert.deepEqual(pythonModuleFiles(paths, null, ref(['shop', 'billing'])), ['shop/src/shop/billing/__init__.py'])
	assert.deepEqual(pythonModuleFiles(paths, null, ref(['shop', 'types'])), ['shop/src/shop/types.py'], 'source over stub; not .venv')
	assert.deepEqual(pythonModuleFiles(paths, null, ref(['types'])), ['api/src/api/types.py', 'shop/src/shop/types.py'], 'every place')
	assert.deepEqual(pythonModuleFiles(paths, null, ref(['os'])), [])
	const from = 'shop/src/shop/billing/context.py'
	assert.deepEqual(pythonModuleFiles(paths, from, ref(['types'], 2)), ['shop/src/shop/types.py'])
	assert.deepEqual(pythonModuleFiles(paths, from, ref(['context'], 1)), ['shop/src/shop/billing/context.py'])
	assert.deepEqual(pythonModuleFiles(paths, from, ref(['types'], 1)), [], 'relative means here, not anywhere')
	assert.deepEqual(pythonModuleFiles(paths, from, ref(['x'], 9)), [], 'above the root')
	assert.deepEqual(pythonModuleFiles(paths, null, ref(['types'], 1)), [])
})
