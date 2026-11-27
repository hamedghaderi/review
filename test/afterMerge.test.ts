import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { addedRanges, followAfterMerge, type FollowTarget } from '../src/main/afterMerge.ts'
import type { GitHubService } from '../src/main/github.ts'
import { ReviewService } from '../src/main/service.ts'
import { ReviewStore } from '../src/main/store.ts'
import type { MergeFixInput } from '../src/main/ai/mergeFix.ts'
import { worstFix } from '../src/shared/mergeScore.ts'
import type { AiRun, Finding, FixLevel, PrDetail, Review } from '../src/shared/types.ts'

function lines(n: number, edit: Record<number, string> = {}, top: Array<string> = []): string {
	return [...top, ...Array.from({ length: n }, (_, i) => edit[i + 1] ?? `l${i + 1}`)].join('\n') + '\n'
}

/**
 * main: f.txt (10 lines) and g.txt. The pull request (topic) edits f.txt line 5 and is squash-merged onto main as one
 * commit, the way GitHub squashes.
 */
function world() {
	const dir = mkdtempSync(join(tmpdir(), 'review-after-'))
	const run = (...a: Array<string>): string =>
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
			cwd: dir,
			encoding: 'utf8',
		}).trim()
	const commit = (files: Record<string, string | null>, msg: string): string => {
		for (const [f, text] of Object.entries(files)) {
			if (text === null) rmSync(join(dir, f))
			else writeFileSync(join(dir, f), text)
		}
		run('add', '-A')
		run('commit', '-qm', msg)
		return run('rev-parse', 'HEAD')
	}
	run('init', '-q', '-b', 'main')
	commit({ 'f.txt': lines(10), 'g.txt': 'g1\n' }, 'base')
	run('checkout', '-qb', 'topic')
	const head = commit({ 'f.txt': lines(10, { 5: 'L5' }) }, 'edit line 5')
	run('checkout', '-q', 'main')
	const merge = commit({ 'f.txt': lines(10, { 5: 'L5' }) }, 'Edit line 5 (#7)')
	return { dir, run, commit, head, merge }
}

const PR = { repo: 'acme/web', number: 7, title: 'Edit line 5' }
const at5: FollowTarget = { id: 'f5', path: 'f.txt', start: 5, end: 5 }

test('after merge: lines nothing changed are untouched, also when lines are added above them', async () => {
	const w = world()
	w.commit({ 'g.txt': 'g1\ng2\n' }, 'unrelated file')
	const end = w.commit({ 'f.txt': lines(10, { 5: 'L5' }, ['new top']) }, 'line added above')
	const r = await followAfterMerge(w.dir, w.head, { ...PR, mergeCommit: w.merge }, end, [at5])
	assert.deepEqual(r.get('f5'), { state: 'untouched', commit: null, reason: null })
})

test('after merge: the first commit that changes the lines is reported, not a later one', async () => {
	const w = world()
	w.commit({ 'g.txt': 'g1\ng2\n' }, 'unrelated file')
	const fix = w.commit({ 'f.txt': lines(10, { 5: 'fixed' }) }, 'Fix line 5')
	const end = w.commit({ 'f.txt': lines(10, { 5: 'again' }) }, 'Change it again')
	const other: FollowTarget = { id: 'f9', path: 'f.txt', start: 9, end: 9 }
	const r = await followAfterMerge(w.dir, w.head, { ...PR, mergeCommit: w.merge }, end, [at5, other])
	assert.equal(r.get('f5')?.state, 'changed')
	assert.equal(r.get('f5')?.commit?.sha, fix)
	assert.equal(r.get('f5')?.commit?.subject, 'Fix line 5')
	assert.equal(r.get('f9')?.state, 'untouched')
})

test('after merge: a renamed file is followed under its new name', async () => {
	const w = world()
	w.run('mv', 'f.txt', 'h.txt')
	w.commit({}, 'rename')
	w.commit({ 'g.txt': 'g1\ng2\n' }, 'unrelated file')
	const fix = w.commit({ 'h.txt': lines(10, { 5: 'fixed' }) }, 'Fix line 5 in h')
	const r = await followAfterMerge(w.dir, w.head, { ...PR, mergeCommit: w.merge }, fix, [at5])
	assert.equal(r.get('f5')?.state, 'changed')
	assert.equal(r.get('f5')?.commit?.sha, fix)
})

test('after merge: a revert of the pull request is told apart from a change, in git’s and GitHub’s wording', async () => {
	const git = world()
	git.run('revert', '--no-edit', git.merge)
	const reverted = git.run('rev-parse', 'HEAD')
	const r1 = await followAfterMerge(git.dir, git.head, { ...PR, mergeCommit: git.merge }, reverted, [at5])
	assert.equal(r1.get('f5')?.state, 'reverted')

	const gh = world()
	writeFileSync(join(gh.dir, 'f.txt'), lines(10))
	gh.run('add', '-A')
	gh.run('commit', '-qm', 'Revert "Edit line 5" (#8)', '-m', 'Reverts acme/web#7')
	const r2 = await followAfterMerge(gh.dir, gh.head, { ...PR, mergeCommit: gh.merge }, gh.run('rev-parse', 'HEAD'), [at5])
	assert.equal(r2.get('f5')?.state, 'reverted')
})

test('after merge: a merge commit no longer on the base branch leaves every finding unknown', async () => {
	const w = world()
	w.run('reset', '-q', '--hard', 'HEAD~1')
	const end = w.commit({ 'g.txt': 'rewritten\n' }, 'history rewritten')
	const r = await followAfterMerge(w.dir, w.head, { ...PR, mergeCommit: w.merge }, end, [at5])
	assert.equal(r.get('f5')?.state, 'unknown')
})

test('following merged pull requests: settled findings are kept, untouched ones followed again until the window ends', async () => {
	const w = world()
	const fix = w.commit({ 'f.txt': lines(10, { 5: 'fixed' }) }, 'Fix line 5')
	let tip = fix
	const mergedAt = '2026-10-01T00:00:00Z'
	const detail = { state: 'merged', mergedAt, mergeCommit: w.merge, baseRef: 'main', headSha: w.head, title: PR.title } as PrDetail
	const asked: Array<string> = []
	const gh = {
		status: () => ({ state: 'connected', login: 'me' }),
		detail: async () => detail,
		branchTipAt: async (_repo: string, _branch: string, until: string) => (asked.push(until), tip),
	} as unknown as GitHubService
	const store = ReviewStore.in(mkdtempSync(join(tmpdir(), 'after-store-')))
	await store.load()
	const anchor = (line: number) => ({ ...base, startLine: line, endLine: line })
	const base = {
		repoId: 'r',
		baseSha: w.head,
		headSha: w.head,
		fileKey: 'f.txt',
		oldPath: 'f.txt',
		newPath: 'f.txt',
		side: 'new',
		excerpt: '',
	}
	const finding = (id: string, line: number) => ({ id, anchor: anchor(line), title: id, category: 'bug' }) as unknown as Finding
	await store.update((d) => {
		d.repos.r = {
			repoId: 'r',
			root: w.dir,
			selectedBase: null,
			activeReviewId: null,
			reviews: { rev: { id: 'rev', headSha: w.head, updatedAt: mergedAt, pr: { ...PR } } as unknown as Review },
			aiRuns: { rev: [{ id: 'run', fixture: false, findings: [finding('f5', 5), finding('f9', 9)] } as unknown as AiRun] },
		}
	})
	const svc = new ReviewService(store, gh)

	const first = await svc.followMerged(null, new Date('2026-10-20T00:00:00Z'))
	assert.deepEqual(first, { followed: 2, problems: [] })
	let m = store.read().repos.r.merged!['7']!
	assert.equal(m.done, false, 'the 90 days have not passed')
	assert.equal(m.findings.f5.state, 'changed')
	assert.equal(m.findings.f9.state, 'untouched')
	assert.equal(asked[0], '2026-10-20T00:00:00.000Z', 'the base branch as it is now')

	// Later: line 9 changes too. Only the untouched finding is followed again; the window has passed, so it is done.
	tip = w.commit({ 'f.txt': lines(10, { 5: 'fixed', 9: 'nine' }) }, 'Change line 9')
	const second = await svc.followMerged(null, new Date('2027-03-01T00:00:00Z'))
	assert.deepEqual(second, { followed: 1, problems: [] })
	m = store.read().repos.r.merged!['7']!
	assert.equal(m.done, true)
	assert.equal(m.findings.f5.commit?.sha, fix, 'kept from the first check')
	assert.equal(m.findings.f9.state, 'changed')
	assert.equal(asked[1], '2026-12-30T00:00:00.000Z', 'the base branch as it was at the end of the window')

	// Done: nothing is asked again.
	await svc.followMerged(null, new Date('2027-04-01T00:00:00Z'))
	assert.equal(asked.length, 2)
})

test('added ranges: the lines a pull request added or changed on its head, by file; deletions alone add nothing', async () => {
	const w = world()
	w.run('checkout', '-q', 'topic')
	const head = w.commit({ 'f.txt': lines(10, { 5: 'L5', 8: 'L8' }, ['top']), 'g.txt': null, 'h.txt': 'h1\nh2\n' }, 'more')
	assert.deepEqual(
		(await addedRanges(w.dir, w.run('rev-parse', 'main~1'), head)).map((t) => t.id),
		['f.txt:1-1', 'f.txt:6-6', 'f.txt:9-9', 'h.txt:1-2'],
	)
})

test('merge score track record: the head that merged is followed 30 days on its own lines, and each change is judged once', async () => {
	const w = world()
	const fix = w.commit({ 'f.txt': lines(10, { 5: 'fixed' }) }, 'Handle the empty case')
	const tip = fix
	const mergedAt = '2026-10-01T00:00:00Z'
	const detail = { state: 'merged', mergedAt, mergeCommit: w.merge, baseRef: 'main', headSha: w.head, title: PR.title } as PrDetail
	const gh = {
		status: () => ({ state: 'connected', login: 'me' }),
		detail: async () => detail,
		branchTipAt: async () => tip,
	} as unknown as GitHubService
	const store = ReviewStore.in(mkdtempSync(join(tmpdir(), 'after-store-')))
	await store.load()
	const seen = { head: w.head, data: 82, final: 74, at: mergedAt }
	await store.update((d) => {
		d.repos.r = {
			repoId: 'r',
			root: w.dir,
			selectedBase: null,
			activeReviewId: null,
			reviews: {
				rev: {
					id: 'rev',
					repoId: 'r',
					baseSha: w.run('rev-parse', 'topic~1'),
					headSha: w.head,
					updatedAt: mergedAt,
					pr: { ...PR },
					mergeSeen: seen,
				} as unknown as Review,
			},
			aiRuns: {}, // no findings: a clean review counts too
		}
	})
	const svc = new ReviewService(store, gh)
	const asked: Array<MergeFixInput> = []
	let answer: { level: FixLevel; why: string } | null = null
	const judge = async (_repo: string, input: MergeFixInput) => (asked.push(input), answer)

	// No model yet: the change waits, not judged.
	await svc.followMerged(null, new Date('2026-10-20T00:00:00Z'), judge)
	let o = store.read().repos.r.merged!['7']!.outcome!
	assert.deepEqual(o.score, seen, 'held against the score seen before it merged')
	assert.equal(o.done, false)
	assert.equal(o.lines['f.txt:5-5'].commit?.sha, fix)
	assert.deepEqual(
		o.fixes.map((f) => [f.sha, f.level]),
		[[fix, null]],
	)
	assert.equal(asked.length, 1)
	assert.match(asked[0].prDiff, /\+L5/, "the pull request's diff for that file")
	assert.match(asked[0].commit.diff, /\+fixed/)
	assert.match(asked[0].commit.message, /Handle the empty case/)

	// The window passes and a model answers: settled.
	answer = { level: 'should_fix', why: 'Line 5 broke on empty input.' }
	await svc.followMerged(null, new Date('2026-11-15T00:00:00Z'), judge)
	o = store.read().repos.r.merged!['7']!.outcome!
	assert.equal(o.done, true)
	assert.deepEqual(o.fixes[0].level, 'should_fix')
	assert.equal(worstFix(o), 'should_fix')
	assert.equal(asked.length, 2)

	// Settled, though the 90-day finding window hasn't passed: the outcome isn't judged again.
	await svc.followMerged(null, new Date('2026-11-20T00:00:00Z'), judge)
	assert.equal(asked.length, 2)
})

test('merge score track record: a score seen on an earlier head is not held against what merged', async () => {
	const w = world()
	const detail = {
		state: 'merged',
		mergedAt: '2026-10-01T00:00:00Z',
		mergeCommit: w.merge,
		baseRef: 'main',
		headSha: w.head,
		title: PR.title,
	} as PrDetail
	const gh = {
		status: () => ({ state: 'connected', login: 'me' }),
		detail: async () => detail,
		branchTipAt: async () => w.merge,
	} as unknown as GitHubService
	const store = ReviewStore.in(mkdtempSync(join(tmpdir(), 'after-store-')))
	await store.load()
	const old = w.run('rev-parse', 'topic~1') // an earlier head, before the change
	await store.update((d) => {
		d.repos.r = {
			repoId: 'r',
			root: w.dir,
			selectedBase: null,
			activeReviewId: null,
			reviews: {
				rev: {
					id: 'rev',
					repoId: 'r',
					baseSha: old,
					headSha: old,
					updatedAt: '2026-10-01T00:00:00Z',
					pr: { ...PR },
					mergeSeen: { head: old, data: 90, final: null, at: '' },
				} as unknown as Review,
			},
			aiRuns: {},
		}
	})
	await new ReviewService(store, gh).followMerged(null, new Date('2026-11-15T00:00:00Z'))
	assert.equal(store.read().repos.r.merged!['7']!.outcome, null)
})
