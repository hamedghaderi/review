import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { ReviewService } from '../src/main/service.ts'
import { ReviewStore } from '../src/main/store.ts'
import { definedName } from '../src/main/symbols.ts'

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'review-symbols-'))
}

/** main: TS, Python and Go code. topic: renames oldRate to newRate, adds a caller of applyDiscount, a second `format`. */
async function world() {
	const dir = tmp()
	const run = (...a: Array<string>): string =>
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
			cwd: dir,
			encoding: 'utf8',
		}).trim()
	const write = (files: Record<string, string>): void => {
		for (const [f, text] of Object.entries(files)) {
			mkdirSync(dirname(join(dir, f)), { recursive: true })
			writeFileSync(join(dir, f), text)
		}
	}
	run('init', '-q', '-b', 'main')
	write({
		'src/discount.ts': `// Discount codes.\nexport function applyDiscount(amount: number, code: string) {\n  return code === 'HALF' ? amount / 2 : amount\n}\n\nexport function format(n: number) {\n  return n.toFixed(2)\n}\n`,
		'src/rates.ts': `export const oldRate = (n: number) => n * 0.2\n`,
		'src/cart.ts': `import { applyDiscount } from './discount'\n\nexport function cartTotal(a: number) {\n  return applyDiscount(a, 'X')\n}\n`,
		'tools/report.py': `def summarize(rows):\n    return len(rows)\n\n\nclass Report:\n    pass\n`,
		'cmd/main.go': `package main\n\nfunc (s *Server) Serve(port int) error {\n\treturn nil\n}\n\nfunc main() {}\n`,
		'node_modules/lib/index.js': 'function applyDiscount() {}\n',
		'README.md': 'function applyDiscount is documented here\n',
	})
	run('add', '-A')
	run('commit', '-qm', 'base')
	run('checkout', '-qb', 'topic')
	write({
		'src/rates.ts': `export const newRate = (n: number) => n * 0.2\n`,
		'src/checkout.ts': `import { applyDiscount, format } from './discount'\n\nexport function checkout(a: number) {\n  return format(applyDiscount(a, 'HALF'))\n}\n`,
		'src/money.ts': `export function format(n: number) {\n  return '$' + n\n}\n`,
		'tools/report.py': `def summarize(rows):\n    return len(rows)\n\n\nclass Report:\n    def total(self):\n        return summarize([])\n`,
	})
	run('add', '-A')
	run('commit', '-qm', 'topic')
	writeFileSync(join(dir, 'src/discount.ts'), 'export function applyDiscount() { return "WORKTREE" }\n')

	const store = ReviewStore.in(tmp())
	await store.load()
	const svc = new ReviewService(store, null)
	const s = await svc.open(dir)
	const { comparison } = await svc.loadComparison(s.repo.id, {
		kind: 'target',
		target: { kind: 'branch', headRef: 'refs/heads/topic', baseRef: 'refs/heads/main' },
	})
	return { svc, id: comparison.id }
}

test('go to definition finds one definition at the head commit, in TS, Python and Go, skipping vendored code and prose', async () => {
	const { svc, id } = await world()
	const d = await svc.lookupSymbol(id, 'applyDiscount', 'new', 'definition')
	assert.deepEqual(
		d.hits.map((h) => [h.path, h.line, h.fileKey, h.inDiff]),
		[['src/discount.ts', 2, null, false]],
		'read from the commit, not the working tree; an unchanged file has no file key',
	)
	assert.equal(d.hits[0].text, 'export function applyDiscount(amount: number, code: string) {')
	assert.deepEqual(
		(await svc.lookupSymbol(id, 'summarize', 'new', 'definition')).hits.map((h) => [h.path, h.line]),
		[['tools/report.py', 1]],
	)
	assert.deepEqual(
		(await svc.lookupSymbol(id, 'Serve', 'new', 'definition')).hits.map((h) => [h.path, h.line]),
		[['cmd/main.go', 3]],
	)
	const added = await svc.lookupSymbol(id, 'newRate', 'new', 'definition')
	assert.deepEqual(
		added.hits.map((h) => [h.path, h.fileKey, h.inDiff]),
		[['src/rates.ts', 'src/rates.ts', true]],
	)
})

test('several definitions are all listed; none is an empty list', async () => {
	const { svc, id } = await world()
	const several = await svc.lookupSymbol(id, 'format', 'new', 'definition')
	assert.deepEqual(several.hits.map((h) => h.path).sort(), ['src/discount.ts', 'src/money.ts'])
	const none = await svc.lookupSymbol(id, 'nowhere', 'new', 'definition')
	assert.deepEqual(none.hits, [])
	assert.equal(none.truncated, false)
})

test('find uses lists the uses, not the definition or imports, and marks the lines the change added', async () => {
	const { svc, id } = await world()
	const uses = await svc.lookupSymbol(id, 'applyDiscount', 'new', 'uses')
	assert.deepEqual(
		uses.hits.map((h) => [h.path, h.line, h.inDiff]),
		[
			['src/cart.ts', 4, false],
			['src/checkout.ts', 4, true],
		],
	)
	const py = await svc.lookupSymbol(id, 'summarize', 'new', 'uses')
	assert.deepEqual(
		py.hits.map((h) => [h.path, h.line, h.inDiff]),
		[['tools/report.py', 7, true]],
	)
})

test('the base side looks names up at the base commit, and marks removed lines', async () => {
	const { svc, id } = await world()
	assert.deepEqual((await svc.lookupSymbol(id, 'oldRate', 'new', 'definition')).hits, [], 'gone at the head commit')
	const base = await svc.lookupSymbol(id, 'oldRate', 'old', 'definition')
	assert.deepEqual(
		base.hits.map((h) => [h.path, h.line, h.fileKey, h.inDiff]),
		[['src/rates.ts', 1, 'src/rates.ts', true]],
	)
	assert.deepEqual(
		(await svc.lookupSymbol(id, 'format', 'old', 'definition')).hits.map((h) => h.path),
		['src/discount.ts'],
	)
})

test('lookups work with submodule.recurse on and a submodule commit that is not checked out', async () => {
	const dir = tmp()
	const run = (cwd: string, ...a: Array<string>): string =>
		execFileSync(
			'git',
			['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...a],
			{ cwd, encoding: 'utf8' },
		).trim()
	const sub = join(dir, 'sub')
	const main = join(dir, 'main')
	mkdirSync(sub)
	mkdirSync(main)
	run(sub, 'init', '-q', '-b', 'main')
	writeFileSync(join(sub, 'a.txt'), 'x\n')
	run(sub, 'add', '-A')
	run(sub, 'commit', '-qm', 's')
	run(main, 'init', '-q', '-b', 'main')
	writeFileSync(join(main, 'a.ts'), 'export function base() {}\n')
	run(main, 'submodule', 'add', '-q', '../sub', 'sub')
	run(main, 'add', '-A')
	run(main, 'commit', '-qm', 'base')
	run(main, 'checkout', '-qb', 'topic')
	writeFileSync(join(main, 'b.ts'), 'export function target() {}\n')
	// The gitlink points at a commit the submodule's clone doesn't have, as in a shallow submodule.
	run(main, 'update-index', '--cacheinfo', `160000,${'1'.repeat(40)},sub`)
	run(main, 'add', 'b.ts')
	run(main, 'commit', '-qm', 'topic')
	run(main, 'config', 'submodule.recurse', 'true')

	const store = ReviewStore.in(tmp())
	await store.load()
	const svc = new ReviewService(store, null)
	const s = await svc.open(main)
	const { comparison } = await svc.loadComparison(s.repo.id, {
		kind: 'target',
		target: { kind: 'branch', headRef: 'refs/heads/topic', baseRef: 'refs/heads/main' },
	})
	const d = await svc.lookupSymbol(comparison.id, 'target', 'new', 'definition')
	assert.deepEqual(
		d.hits.map((h) => h.path),
		['b.ts'],
	)
})

test('a file outside the change opens at either commit, read-only', async () => {
	const { svc, id } = await world()
	const head = await svc.loadFileAt(id, 'src/cart.ts', 'new')
	assert.equal(head.kind === 'text' && head.lines[3], "  return applyDiscount(a, 'X')")
	const base = await svc.loadFileAt(id, 'src/rates.ts', 'old')
	assert.equal(base.kind === 'text' && base.lines[0], 'export const oldRate = (n: number) => n * 0.2')
	await assert.rejects(svc.loadFileAt(id, 'src/checkout.ts', 'old'), /not in the base commit/)
})

test('calls in conditions and names in comments are not definitions; class fields and multi-line signatures are', () => {
	for (const line of [
		'\tif isAdmin(user) {',
		'\tswitch kind(x) {',
		'\tnew Thread(r) {',
		'// call the function isAdmin first',
		' * Unlike class Report, this',
		'# def summarize is old',
	])
		assert.equal(definedName(line), null, line)
	assert.equal(definedName('\tasync lookupSymbol('), 'lookupSymbol')
	assert.equal(definedName('\tprivate handle = async (e: Event) => {'), 'handle')
	assert.equal(definedName('\tonClick = () => {'), 'onClick')
	assert.equal(definedName('func (s *Server) Serve(port int) error {'), 'Serve')
	assert.equal(definedName('public static int count(List<String> xs) {'), 'count')
})
