import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { prepareChange } from '../src/main/ai/context.ts'
import { ReviewService } from '../src/main/service.ts'
import { ReviewStore } from '../src/main/store.ts'

test('a moved submodule is listed, has no content to read, and is not sent for AI review', async () => {
	const tmp = (): string => mkdtempSync(join(tmpdir(), 'review-submodule-'))
	const main = tmp()
	const run = (...a: Array<string>): string =>
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
			cwd: main,
			encoding: 'utf8',
		}).trim()
	run('init', '-q', '-b', 'main')
	writeFileSync(join(main, 'a.ts'), 'export const a = 1\n')
	// Gitlinks point at commits in the submodule's repository, which this one never has.
	run('update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},manual`)
	run('add', 'a.ts')
	run('commit', '-qm', 'base')
	run('checkout', '-qb', 'topic')
	writeFileSync(join(main, 'a.ts'), 'export const a = 2\n')
	run('update-index', '--cacheinfo', `160000,${'b'.repeat(40)},manual`)
	run('add', 'a.ts')
	run('commit', '-qm', 'move the submodule')

	const store = ReviewStore.in(tmp())
	await store.load()
	const svc = new ReviewService(store, null)
	const s = await svc.open(main)
	const { comparison } = await svc.loadComparison(s.repo.id, {
		kind: 'target',
		target: { kind: 'branch', headRef: 'refs/heads/topic', baseRef: 'refs/heads/main' },
	})
	const byKey = new Map(comparison.files.map((file) => [file.key, file]))
	assert.equal(byKey.get('manual')?.submodule, true)
	assert.equal(byKey.get('a.ts')?.submodule, undefined)
	assert.deepEqual(await svc.loadFileLines(comparison.id, 'manual'), { kind: 'text', lines: [] }, 'nothing to read, and no error')

	const sources = await Promise.all(
		comparison.files.map(async (file) => ({ file, patch: await svc.loadPatch(comparison.id, file.key, false), fullText: null })),
	)
	const prepared = prepareChange(sources, { contextLines: 5, maxBatchChars: 100_000, maxRunChars: 1_000_000, verify: false })
	assert.deepEqual(
		prepared.files.map((c) => [c.fileKey, c.state]),
		[
			['a.ts', 'pending'],
			['manual', 'not-reviewable'],
		],
	)
})
