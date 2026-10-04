import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { buildContext, type FileSource } from '../src/main/ai/context.ts'
import { createFakeProvider, emptyEvaluation } from '../src/main/ai/fake.ts'
import { validateBatchOutput } from '../src/main/ai/findings.ts'
import { buildInput } from '../src/main/ai/prompt.ts'
import { findRelated, wantedNames } from '../src/main/ai/related.ts'
import { startRun } from '../src/main/ai/runner.ts'
import { ReviewService } from '../src/main/service.ts'
import { ReviewStore } from '../src/main/store.ts'

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'review-related-'))
}

const PRICING_V1 = `export function total(items) {
  let sum = 0
  for (const i of items) sum += i.price
  return sum
}

export function legacyTotal(items) {
  return total(items)
}
`
const PRICING_V2 = `export function total(items, taxRate) {
  let sum = 0
  for (const i of items) sum += i.price
  return sum * (1 + taxRate)
}
`
const DISCOUNT = `// Discount codes.
export function applyDiscount(amount, code) {
  if (code === 'HALF') return amount / 2
  return amount
}

export const unrelated = 1
`
const CART = `import { total, legacyTotal } from './pricing'

export class Cart {
  summary() {
    const a = total(this.items)
    const b = legacyTotal(this.items)
    return a + b
  }
}
`

/** main: pricing, discount, cart, checkout, and a vendored copy. topic: total() gains a parameter, legacyTotal goes, checkout applies a discount. */
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
		'src/pricing.ts': PRICING_V1,
		'src/discount.ts': DISCOUNT,
		'src/cart.ts': CART,
		'src/checkout.ts': `import { total } from './pricing'\n\nexport function checkout(cart) {\n  return total(cart.items)\n}\n`,
		'node_modules/lib/index.js': 'module.exports = () => total(x) + legacyTotal(y) + applyDiscount(1)\n',
	})
	run('add', '-A')
	run('commit', '-qm', 'base')
	run('checkout', '-qb', 'topic')
	write({
		'src/pricing.ts': PRICING_V2,
		'src/checkout.ts': `import { total } from './pricing'\nimport { applyDiscount } from './discount'\n\nexport function checkout(cart) {\n  return applyDiscount(total(cart.items, 0.2), cart.code)\n}\n`,
	})
	run('commit', '-qam', 'topic')
	// The working tree differs from the commit; the search must read the commit.
	writeFileSync(join(dir, 'src/discount.ts'), 'export function applyDiscount() { return "WORKTREE" }\n')

	const store = ReviewStore.in(tmp())
	await store.load()
	const svc = new ReviewService(store, null)
	const s = await svc.open(dir)
	const { comparison } = await svc.loadComparison(s.repo.id, {
		kind: 'target',
		target: { kind: 'branch', headRef: 'refs/heads/topic', baseRef: 'refs/heads/main' },
	})
	const sources: Array<FileSource> = []
	for (const file of comparison.files) {
		const patch = await svc.loadPatch(comparison.id, file.key, false)
		sources.push({ file, patch, fullText: await svc.loadFileLines(comparison.id, file.key) })
	}
	return { dir, comparison, sources }
}

test('changed names: edited signatures, removed definitions and names the added lines use', async () => {
	const w = await world()
	const want = wantedNames(w.sources)
	assert.equal(want.defined.get('total')?.kind, 'signature')
	assert.equal(want.defined.get('legacyTotal')?.kind, 'removed')
	assert.ok(want.defined.has('checkout'), 'the function whose body changed (from the hunk header or its lines)')
	assert.ok(want.used.has('applyDiscount'))
	assert.ok(!want.used.has('total'), 'defined by the change itself, so its definition is already supplied')
	assert.ok(!want.used.has('return') && !want.used.has('if'))
})

test('related code: definitions of used names and callers of changed ones, read from the head commit, vendored code skipped', async () => {
	const w = await world()
	const r = await findRelated(w.dir, w.comparison.headSha, w.sources)
	const at = (path: string) => r.snippets.filter((s) => s.path === path)
	assert.ok(r.snippets.every((s) => !s.path.startsWith('node_modules/')))

	const [disc] = at('src/discount.ts')
	assert.ok(disc, 'the definition of applyDiscount')
	assert.equal(disc.priority, 1)
	assert.match(disc.reasons[0], /definition of `applyDiscount`, which the change uses/)
	assert.equal(disc.start, 1, 'includes its doc comment')
	assert.equal(disc.end, 5, 'ends at the closing brace')
	assert.ok(!disc.lines.join('\n').includes('WORKTREE'), 'the committed version, not the working tree')
	assert.ok(disc.fileKeys.has('src/checkout.ts'))

	const [cart] = at('src/cart.ts')
	assert.ok(cart, 'callers in cart.ts')
	assert.equal(cart.priority, 0)
	assert.ok(cart.reasons.some((x) => /use of `total`, whose definition the change edits \(in `summary`, line 4\)/.test(x)))
	assert.ok(cart.reasons.some((x) => /use of `legacyTotal`, which the change removes or renames/.test(x)))
	assert.ok(cart.lines.includes('    const b = legacyTotal(this.items)'))
	assert.equal(at('src/cart.ts').length, 1, 'overlapping windows are merged')
})

test('references share requests with the files they relate to, within the request and run limits, and are never citable', async () => {
	const w = await world()
	const { snippets } = await findRelated(w.dir, w.comparison.headSha, w.sources)
	const limits = { contextLines: 5, maxBatchChars: 100_000, maxRunChars: 1_000_000 }
	const pkg = buildContext(w.comparison, w.sources, limits, snippets)
	const refs = pkg.batches.flatMap((b) => b.references)
	assert.ok(refs.length >= 2)
	assert.equal(pkg.related.sent, new Set(refs.map((r) => r.id)).size)
	assert.equal(pkg.related.omitted, 0)
	const input = buildInput(pkg.batches[0])
	assert.match(input, /# Related code \(read-only reference/)
	assert.match(input, /=== BEGIN R\d+ \(reference, not part of the change\) ===\npath: src\/(cart|discount)\.ts \(head version\)/)
	assert.doesNotMatch(input.split('# Excerpts')[0], /R\d+:/, 'the manifest lists only excerpts')
	assert.ok(pkg.batches[0].chars > pkg.batches[0].overview.length + pkg.batches[0].excerpts.reduce((n, e) => n + e.text.length, 0))

	// A finding may not cite a reference.
	const ref = pkg.batches[0].references[0]
	const out = validateBatchOutput(
		{
			findings: [
				{
					excerpt_id: ref.id,
					file_path: ref.path,
					side: 'new',
					start_line: ref.start,
					end_line: ref.start,
					category: 'bug',
					signature: null,
					test_pattern: null,
					severity: 'should_fix',
					title: 'In reference code',
					body: 'x',
					reasoning: 'x',
					disproof: null,
					background: null,
					evidence: 'x',
				},
			],
			evaluation: emptyEvaluation(),
			unexplained_files: [],
			limitations: [],
		},
		pkg.batches[0],
		w.comparison,
		'run',
	)
	assert.equal(out.findings.length, 0)
	assert.match(out.rejected[0].reason, /Unknown excerpt id/)

	// Run limit: changed code is counted first; related code gets only what is left.
	const changedOnly = buildContext(w.comparison, w.sources, limits)
	const tight = buildContext(w.comparison, w.sources, { ...limits, maxRunChars: changedOnly.inputChars }, snippets)
	assert.deepEqual(
		tight.supplied.map((s) => s.excerptId),
		changedOnly.supplied.map((s) => s.excerptId),
		'every changed excerpt is still sent',
	)
	assert.equal(tight.related.sent, 0)
	assert.ok(tight.related.omitted > 0)
})

test('runs send related code unless it is turned off, and a failed search never fails the run', async () => {
	const w = await world()
	const go = async (limits: object, loadRelated: Parameters<typeof startRun>[0]['loadRelated']) => {
		const inputs: Array<string> = []
		const provider = createFakeProvider({
			script: (req) => {
				inputs.push(req.input)
				return { findings: [], evaluation: emptyEvaluation(), unexplained_files: [], limitations: [] }
			},
		})
		const run = await startRun(
			{
				reviewId: w.comparison.id,
				comparison: w.comparison,
				scope: { kind: 'all' },
				loadSources: async () => w.sources,
				loadRelated,
				previousFindings: [],
			},
			{
				provider,
				limits: { contextLines: 5, maxBatchChars: 100_000, maxRunChars: 1_000_000, ...limits },
				concurrency: 1,
				maxAttempts: 1,
				backoffMs: () => 1,
			},
			() => {},
		).done
		return { run, inputs }
	}
	const search = (sources: Array<FileSource>, signal: AbortSignal) => findRelated(w.dir, w.comparison.headSha, sources, signal)

	const on = await go({ relatedCode: true }, search)
	assert.equal(on.run.status, 'completed')
	assert.ok(on.inputs.some((i) => i.includes('# Related code')))
	assert.ok(on.run.coverage.related && on.run.coverage.related.sent > 0 && on.run.coverage.related.symbols > 0)

	let called = false
	const off = await go({ relatedCode: false }, async (s, sig) => {
		called = true
		return search(s, sig)
	})
	assert.equal(called, false)
	assert.ok(off.inputs.every((i) => !i.includes('# Related code')))
	assert.ok(!off.run.coverage.related)

	const broken = await go({ relatedCode: true }, async () => {
		throw new Error('git grep failed: boom')
	})
	assert.equal(broken.run.status, 'completed')
	assert.ok(broken.run.notices!.some((n) => /Related code could not be searched.*boom/.test(n)))
})

test('a new file brings existing files of the same kind from its folder, so the reviewer sees the convention', async () => {
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
	const rule = (name: string) =>
		`<?php\nclass ${name}\n{\n    public function validate($a, $v, $fail): void\n    {\n        $fail(__('validation.${name}'));\n    }\n}\n`
	run('init', '-q', '-b', 'main')
	write({
		'app/Rules/SafeUrl.php': rule('SafeUrl'),
		'app/Rules/MarketExclusivity.php': rule('MarketExclusivity'),
		'app/Rules/Readme.md': 'not code\n',
		'app/Rules/helpers.js': 'export const x = 1\n',
		'app/Rules/Touched.php': rule('Touched'),
	})
	run('add', '-A')
	run('commit', '-qm', 'base')
	run('checkout', '-qb', 'topic')
	write({
		'app/Rules/NoXssInput.php': `<?php\nclass NoXssInput\n{\n    public function validate($a, $v, $fail): void\n    {\n        $fail('Invalid characters found');\n    }\n}\n`,
		'app/Rules/Touched.php': rule('Touched') + '// edited\n',
	})
	run('add', '-A')
	run('commit', '-qm', 'topic')
	const store = ReviewStore.in(tmp())
	await store.load()
	const svc = new ReviewService(store, null)
	const s = await svc.open(dir)
	const { comparison } = await svc.loadComparison(s.repo.id, {
		kind: 'target',
		target: { kind: 'branch', headRef: 'refs/heads/topic', baseRef: 'refs/heads/main' },
	})
	const sources: Array<FileSource> = []
	for (const file of comparison.files)
		sources.push({
			file,
			patch: await svc.loadPatch(comparison.id, file.key, false),
			fullText: await svc.loadFileLines(comparison.id, file.key),
		})

	const { snippets } = await findRelated(dir, comparison.headSha, sources)
	const peers = snippets.filter((x) => x.reasons.some((r) => r.startsWith('peer of `NoXssInput.php`')))
	assert.deepEqual(
		peers.map((p) => p.path).sort(),
		['app/Rules/MarketExclusivity.php', 'app/Rules/SafeUrl.php'],
		'same extension, not changed by the change, at most two',
	)
	assert.ok(peers.every((p) => p.start === 1 && p.lines.some((l) => l.includes("__('validation."))))
	assert.ok(
		peers.every((p) => p.fileKeys.has('app/Rules/NoXssInput.php')),
		'sent with the request that carries the new file',
	)
	assert.ok(!snippets.some((x) => x.reasons.some((r) => r.startsWith('peer of `Touched.php`'))), 'only added files get peers')
})
