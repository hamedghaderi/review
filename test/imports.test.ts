import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import type { FileSource } from '../src/main/ai/context.ts'
import { findImporters, importFacts, importSpecs, resolves } from '../src/main/ai/imports.ts'
import { findRelated } from '../src/main/ai/related.ts'
import { classifyRisk } from '../src/main/ai/risk.ts'
import type { ChangedFile, FileStatus } from '../src/shared/types.ts'

const imports = (importer: string, line: string, target: string): boolean => importSpecs(line).some((s) => resolves(importer, s, target))

test('import lines resolve to the file they name, across languages, and nothing else', () => {
	// JS/TS: relative with or without extension, index files, aliases, re-exports, require, multi-line closers.
	assert.ok(imports('src/app.ts', "import { total } from './cart'", 'src/cart.ts'))
	assert.ok(imports('src/ui/page.ts', "import { total } from '../cart.js'", 'src/cart.ts'))
	assert.ok(imports('src/app.ts', "import * as c from './cart'", 'src/cart/index.ts'))
	assert.ok(imports('src/app.ts', "import { total } from '@/lib/cart'", 'src/lib/cart.ts'))
	assert.ok(imports('src/app.ts', "export { total } from './cart'", 'src/cart.ts'))
	assert.ok(imports('src/app.js', "const { total } = require('./cart')", 'src/cart.js'))
	assert.ok(imports('src/app.ts', "} from './cart'", 'src/cart.ts'))
	assert.ok(!imports('src/app.ts', "import { total } from './cart'", 'lib/cart.ts'), 'a relative import names one file')
	assert.ok(!imports('src/app.ts', "import { total } from './carts'", 'src/cart.ts'))
	assert.ok(!imports('src/app.ts', "import React from 'react'", 'src/react.ts'), 'a bare package is not a local file')
	// Python: absolute, relative, module imported by name.
	assert.ok(imports('app/views.py', 'from app.billing.tax import rate', 'app/billing/tax.py'))
	assert.ok(imports('app/views.py', 'from app.billing import tax', 'app/billing/tax.py'))
	assert.ok(imports('app/billing/views.py', 'from .tax import rate', 'app/billing/tax.py'))
	assert.ok(imports('app/billing/sub/x.py', 'from ..tax import rate', 'app/billing/tax.py'))
	assert.ok(imports('app/billing/x.py', 'import tax', 'app/billing/tax.py'))
	assert.ok(!imports('other/x.py', 'import tax', 'app/billing/tax.py'))
	// PHP namespaces, Java packages, Go packages, C includes.
	assert.ok(imports('app/Http/Controller.php', 'use App\\Services\\PaymentService;', 'app/Services/PaymentService.php'))
	assert.ok(imports('src/main/java/com/shop/App.java', 'import com.shop.billing.Cart;', 'src/main/java/com/shop/billing/Cart.java'))
	assert.ok(imports('cmd/api/main.go', '	"github.com/acme/shop/internal/billing"', 'internal/billing/tax.go'))
	assert.ok(imports('src/main.c', '#include "tax.h"', 'src/tax.h'))
})

function repo() {
	const root = mkdtempSync(join(tmpdir(), 'review-imports-'))
	const git = (...a: Array<string>): string =>
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
			cwd: root,
			encoding: 'utf8',
		}).trim()
	const write = (path: string, text: string): void => {
		mkdirSync(dirname(join(root, path)), { recursive: true })
		writeFileSync(join(root, path), text)
	}
	git('init', '-q', '-b', 'main')
	write('src/cart.ts', 'export function total(items) {\n  return 0\n}\n')
	write('src/legacy.ts', 'export function old() {}\n')
	write('src/checkout.ts', "import { total } from './cart'\nimport { old } from './legacy'\nexport const pay = (i) => total(i)\n")
	write('src/admin/report.ts', "import { total } from '../cart'\nexport const sum = (i) => total(i)\n")
	// Same name, unrelated: does not import cart.
	write('src/stats.ts', 'function total(xs) { return xs.length }\nexport const n = (xs) => total(xs)\n')
	write('test/cart.test.ts', "import { total } from '../src/cart'\ntotal([])\n")
	git('add', '.')
	git('commit', '-q', '-m', 'base')
	const base = git('rev-parse', 'HEAD')
	write('src/cart.ts', 'export function total(items, taxRate) {\n  return 0\n}\n')
	rmSync(join(root, 'src/legacy.ts'))
	git('add', '-A')
	git('commit', '-q', '-m', 'change')
	return { root, base, head: git('rev-parse', 'HEAD') }
}

function source(path: string, status: FileStatus, lines: Array<['add' | 'del', string]>): FileSource {
	const file: ChangedFile = {
		key: path,
		status,
		oldPath: path,
		newPath: status === 'deleted' ? null : path,
		additions: lines.filter(([k]) => k === 'add').length,
		deletions: lines.filter(([k]) => k === 'del').length,
		binary: false,
		similarity: null,
	}
	let o = 1
	let n = 1
	const diff = lines.map(([kind, text]) => ({ kind, text, oldNo: kind === 'add' ? null : o++, newNo: kind === 'del' ? null : n++ }))
	return {
		file,
		patch: { kind: 'text', hunks: [{ oldStart: 1, oldLines: o - 1, newStart: 1, newLines: n - 1, section: '', lines: diff }] },
		fullText: null,
	} as FileSource
}

const SOURCES = [
	source('src/cart.ts', 'modified', [
		['del', 'export function total(items) {'],
		['add', 'export function total(items, taxRate) {'],
	]),
	source('src/legacy.ts', 'deleted', [['del', 'export function old() {}']]),
]

test('importers are traced in the head commit, split into code and tests; a deleted file that is still imported is flagged', async () => {
	const r = repo()
	const found = await findImporters(r.root, r.head, SOURCES)
	assert.deepEqual(found, [
		{
			fileKey: 'src/cart.ts',
			path: 'src/cart.ts',
			importers: ['src/admin/report.ts', 'src/checkout.ts'],
			tests: ['test/cart.test.ts'],
			stale: [],
		},
		{ fileKey: 'src/legacy.ts', path: 'src/legacy.ts', importers: [], tests: [], stale: ['src/checkout.ts'] },
	])
	const facts = importFacts(found)
	assert.equal(facts[0].kind, 'structure')
	assert.deepEqual(facts[0].fileKeys, ['src/cart.ts'])
	assert.equal(
		facts[0].text,
		'src/cart.ts:\n- imported by 2 files: src/admin/report.ts, src/checkout.ts\n- imported by 1 test file: test/cart.test.ts',
	)
	assert.match(facts[1].text, /STILL IMPORTED at the path this change removes, by 1 file: src\/checkout\.ts/)
})

test('related code puts uses in importing files first and says so; the same name in an unrelated file comes after', async () => {
	const r = repo()
	const related = await findRelated(r.root, r.head, SOURCES)
	const uses = related.snippets.filter((s) => s.reasons.some((x) => x.includes('use of `total`')))
	const order = uses.map((s) => s.path)
	assert.ok(order.indexOf('src/stats.ts') > order.indexOf('src/checkout.ts'), order.join(', '))
	assert.ok(order.indexOf('src/stats.ts') > order.indexOf('src/admin/report.ts'), order.join(', '))
	assert.ok(uses.find((s) => s.path === 'src/checkout.ts')!.reasons.some((x) => x.endsWith('this file imports the changed file')))
	assert.ok(!uses.find((s) => s.path === 'src/stats.ts')!.reasons.some((x) => x.includes('imports the changed file')))
	assert.equal(related.importers.length, 2)

	const risk = Object.fromEntries(classifyRisk(SOURCES, related).map((x) => [x.fileKey, x]))
	assert.equal(risk['src/legacy.ts'].level, 'high')
	assert.ok(risk['src/legacy.ts'].reasons.includes('1 file still imports the path it removes'))
})
