import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadFixedPatch, parseChecked, selectFixedPatch } from '../src/main/fixedPatch.ts'
import type { Anchor, GoneFinding, Hunk } from '../src/shared/types.ts'

const hunk = (oldStart: number, oldCount: number, newStart: number, newCount: number, lines = 3): Hunk => ({
	oldStart,
	oldCount,
	newStart,
	newCount,
	section: '',
	lines: Array.from({ length: lines }, (_, i) => ({ kind: 'ctx' as const, oldNo: oldStart + i, newNo: newStart + i, text: `l${i}` })),
})

const base = { from: 'aaaaaaa111', to: 'bbbbbbb222', rewritten: false, checked: [], others: [] }

test('checked ranges: file and line or range, anything else skipped', () => {
	assert.deepEqual(parseChecked(['src/a.ts:12-30', 'src/b.ts:7', 'C:/x/y.ts:3-4', 'no lines', 'src/c.ts:x']), [
		{ path: 'src/a.ts', start: 12, end: 30 },
		{ path: 'src/b.ts', start: 7, end: 7 },
		{ path: 'C:/x/y.ts', start: 3, end: 4 },
	])
})

test('selection: hunks at the finding’s earlier lines, or at lines the check read, in its file and others', () => {
	const near = hunk(18, 4, 18, 6) // old 18-21 starts 3 lines after the finding (10-15): near enough
	const far = hunk(60, 2, 64, 2)
	const read = hunk(90, 1, 94, 3)
	const caller = hunk(5, 2, 5, 4)
	const elsewhere = hunk(200, 1, 200, 1)
	const p = selectFixedPatch({
		...base,
		own: { path: 'src/a.ts', hunks: [near, far, read], range: { start: 10, end: 15 } },
		checked: [
			{ path: 'src/a.ts', start: 95, end: 96 },
			{ path: 'src/caller.ts', start: 6, end: 6 },
		],
		others: [{ path: 'src/caller.ts', hunks: [caller, elsewhere] }],
	})
	assert.deepEqual(
		p.parts.map((x) => [x.path, x.why, x.hunks.map((h) => h.oldStart)]),
		[
			['src/a.ts', 'finding', [18, 90]],
			['src/caller.ts', 'checked', [5]],
		],
	)
	assert.equal(p.note, null)
	assert.equal(p.more, 0)
})

test('selection: a whole-file finding shows every hunk; nothing changed says so; a force-push is flagged', () => {
	const all = selectFixedPatch({ ...base, own: { path: 'a.ts', hunks: [hunk(1, 1, 1, 1), hunk(50, 1, 50, 1)], range: null } })
	assert.equal(all.parts[0].hunks.length, 2)

	const none = selectFixedPatch({
		...base,
		rewritten: true,
		own: { path: 'a.ts', hunks: [hunk(80, 1, 80, 1)], range: { start: 10, end: 12 } },
		checked: [{ path: 'b.ts', start: 1, end: 2 }],
	})
	assert.deepEqual(none.parts, [])
	assert.equal(
		none.note,
		'Nothing changed at the finding’s lines or the lines the double-check read between aaaaaaa and bbbbbbb. The branch was force-pushed since aaaaaaa, so this can include changes that came from the base branch.',
	)
})

test('selection: long hunks are cut and extra hunks counted, so it stays short', () => {
	const p = selectFixedPatch({
		...base,
		own: { path: 'a.ts', hunks: [hunk(1, 80, 1, 80, 80), hunk(100, 50, 100, 50, 50), hunk(200, 30, 200, 30, 30)], range: null },
	})
	assert.deepEqual(
		p.parts[0].hunks.map((h) => h.lines.length),
		[60, 50, 10],
	)
	assert.equal(p.parts[0].cut, true)

	const over = selectFixedPatch({
		...base,
		own: { path: 'a.ts', hunks: [hunk(1, 60, 1, 60, 60), hunk(100, 60, 100, 60, 60), hunk(200, 3, 200, 3)], range: null },
	})
	assert.equal(over.more, 1)
})

test('from Git: the fix in a renamed file and in a caller the check read; unreadable commits become a note', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'review-fixed-patch-'))
	const git = (...a: Array<string>): string =>
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
			cwd: dir,
			encoding: 'utf8',
		}).trim()
	git('init', '-q', '-b', 'main')
	mkdirSync(join(dir, 'src'))
	const lines = (n: number, at: Record<number, string>) =>
		Array.from({ length: n }, (_, i) => at[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'
	writeFileSync(join(dir, 'src/rules.py'), lines(40, { 10: '    except Exception:', 11: '        return {}' }))
	writeFileSync(join(dir, 'src/caller.py'), lines(20, { 5: 'if rules is None: return' }))
	git('add', '-A')
	git('commit', '-qm', 'raised here')
	const from = git('rev-parse', 'HEAD')
	renameSync(join(dir, 'src/rules.py'), join(dir, 'src/policy.py'))
	writeFileSync(join(dir, 'src/policy.py'), lines(40, { 10: '    except OSError:', 11: '        raise' }))
	writeFileSync(join(dir, 'src/caller.py'), lines(20, { 5: 'if rules is None: raise Denied()' }))
	git('add', '-A')
	git('commit', '-qm', 'fix')
	const to = git('rev-parse', 'HEAD')

	const anchor = {
		fileKey: 'src/rules.py',
		oldPath: 'src/rules.py',
		newPath: 'src/rules.py',
		side: 'new',
		startLine: 10,
		endLine: 11,
	} as Anchor
	const gone = {
		finding: { id: 'f', anchor },
		at: { ...anchor, fileKey: 'src/policy.py', oldPath: 'src/policy.py', newPath: 'src/policy.py' },
		check: { verdict: 'wrong', reason: 'r', level: null, checked: ['src/caller.py:4-6'] },
	} as unknown as GoneFinding

	const p = await loadFixedPatch(dir, from, to, gone, false)
	assert.equal(p.note, null)
	assert.deepEqual(
		p.parts.map((x) => [x.path, x.why]),
		[
			['src/policy.py', 'finding'],
			['src/caller.py', 'checked'],
		],
	)
	const text = (i: number) => p.parts[i].hunks.flatMap((h) => h.lines.filter((l) => l.kind !== 'ctx').map((l) => `${l.kind} ${l.text}`))
	assert.deepEqual(text(0), ['del     except Exception:', 'del         return {}', 'add     except OSError:', 'add         raise'])
	assert.deepEqual(text(1), ['del if rules is None: return', 'add if rules is None: raise Denied()'])

	const missing = await loadFixedPatch(dir, 'f'.repeat(40), to, gone, false)
	assert.deepEqual(missing.parts, [])
	assert.match(missing.note ?? '', /^What changed since fffffff could not be read: /)
})

test('after a force-push, the earlier change is replayed onto the new base: only the author’s fix shows', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'review-fixed-patch-'))
	const git = (...a: Array<string>): string =>
		execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
			cwd: dir,
			encoding: 'utf8',
		}).trim()
	const lines = (n: number, at: Record<number, string>, top: Array<string> = []) =>
		[...top, ...Array.from({ length: n }, (_, i) => at[i + 1] ?? `line ${i + 1}`)].join('\n') + '\n'
	const commit = (files: Record<string, string>, msg: string): string => {
		for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t)
		git('add', '-A')
		git('commit', '-qm', msg)
		return git('rev-parse', 'HEAD')
	}
	git('init', '-q', '-b', 'main')
	commit({ 'rules.py': lines(40, {}) }, 'base')
	git('checkout', '-qb', 'topic')
	const from = commit({ 'rules.py': lines(40, { 20: '    except Exception:', 21: '        return {}' }) }, 'raised here')
	// main moves on: three lines at the top of the same file, one just below the finding, and another file.
	git('checkout', '-q', 'main')
	commit({ 'rules.py': lines(40, { 23: 'line 23 from main' }, ['# a', '# b', '# c']), 'other.py': 'from main\n' }, 'main moves on')
	const newBase = git('rev-parse', 'HEAD')
	// Rebased onto main, with the fix.
	git('checkout', '-q', '-B', 'topic', 'main')
	const to = commit(
		{ 'rules.py': lines(40, { 20: '    except OSError:', 21: '        raise', 23: 'line 23 from main' }, ['# a', '# b', '# c']) },
		'fixed',
	)

	const anchor = { fileKey: 'rules.py', oldPath: 'rules.py', newPath: 'rules.py', side: 'new', startLine: 20, endLine: 21 } as Anchor
	const gone = { finding: { id: 'f', anchor }, at: null, check: null } as unknown as GoneFinding
	const text = (p: Awaited<ReturnType<typeof loadFixedPatch>>) =>
		p.parts.flatMap((x) => x.hunks.flatMap((h) => h.lines.filter((l) => l.kind !== 'ctx').map((l) => `${l.kind} ${l.text}`)))

	const p = await loadFixedPatch(dir, from, to, gone, { base: newBase })
	assert.deepEqual(text(p), ['del     except Exception:', 'del         return {}', 'add     except OSError:', 'add         raise'])
	assert.match(p.note ?? '', /replayed onto the base it has now first, so what came from the base branch is left out/)
	assert.equal(p.from, from, 'it still names the head the finding was raised on')

	// Head to head, main's line next to the finding would show as the author's.
	const raw = await loadFixedPatch(dir, from, to, gone, { base: null })
	assert.ok(text(raw).includes('add line 23 from main'))
	assert.match(raw.note ?? '', /can include changes that came from the base branch\.$/)

	// When main changed the same lines, it can't be replayed there: head to head, saying why.
	git('checkout', '-q', 'main')
	const clashBase = commit(
		{ 'rules.py': lines(40, { 20: '    pass', 21: '    pass', 23: 'line 23 from main' }, ['# a', '# b', '# c']) },
		'main edits the same lines',
	)
	git('checkout', '-q', '-B', 'topic', 'main')
	const to2 = commit(
		{ 'rules.py': lines(40, { 20: '    except OSError:', 21: '        raise', 23: 'line 23 from main' }, ['# a', '# b', '# c']) },
		'fixed again',
	)
	const clash = await loadFixedPatch(dir, from, to2, gone, { base: clashBase })
	assert.match(
		clash.note ?? '',
		/can include changes that came from the base branch \(the base branch changed the same lines in rules\.py\)\./,
	)
})
