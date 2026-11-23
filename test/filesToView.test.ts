import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { ReviewService } from '../src/main/service.ts'
import { ReviewStore } from '../src/main/store.ts'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'review-to-view-'))

test('the files an approval checks against Viewed: what the diff shows, less generated, binary, huge and rename-only', async () => {
	const dir = tmp()
	const git = (...a: Array<string>): string =>
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
			cwd: dir,
			encoding: 'utf8',
		}).trim()
	const write = (files: Record<string, string | Buffer>) => {
		for (const [f, text] of Object.entries(files)) {
			mkdirSync(dirname(join(dir, f)), { recursive: true })
			writeFileSync(join(dir, f), text)
		}
	}
	git('init', '-q', '-b', 'main')
	write({ 'old-name.ts': 'export const kept = 1\n', 'README.md': '# Hi\n' })
	git('add', '-A')
	git('commit', '-qm', 'base')
	git('checkout', '-qb', 'topic')
	git('mv', 'old-name.ts', 'new-name.ts') // renamed, not changed
	write({
		'src/a.ts': 'export const a = 1\n',
		'README.md': '# Hello\n',
		'config.yml': 'on: push\n',
		'package-lock.json': '{"lockfileVersion": 3}\n',
		'dist/bundle.js': 'var x=1\n',
		'vendor/lib/x.go': 'package x\n',
		'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0, 3]),
		'huge.txt': Array.from({ length: 10_001 }, (_, i) => `line ${i}`).join('\n') + '\n',
	})
	git('add', '-A')
	git('commit', '-qm', 'work')
	git('checkout', '-q', 'main')

	const store = ReviewStore.in(tmp())
	await store.load()
	const svc = new ReviewService(store, null)
	const s = await svc.open(dir)
	const v = await svc.loadComparison(s.repo.id, {
		kind: 'target',
		target: { kind: 'branch', headRef: 'refs/heads/topic', baseRef: 'refs/heads/main' },
	})
	const files = await svc.filesToView(v.comparison.id)
	assert.deepEqual(files.map((f) => f.path).sort(), ['README.md', 'config.yml', 'src/a.ts'])
})
