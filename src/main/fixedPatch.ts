import type { FixedPatch, GoneFinding, Hunk } from '../shared/types.ts'
import { readPatchBetween } from './git.ts'
import { parsePatch } from './patch.ts'

/**
 * What changed at a gone finding between the head it was raised on and this run's (issue #215), so a "fixed" verdict
 * can be checked by eye before resolving a thread: the hunks at the finding's lines, and at the lines the double-check
 * says it read, since the fix often lands in a caller. Read from Git; no model is asked.
 */

const NEAR = 3 // lines either side of a range that still count as touching it
const MAX_LINES = 120 // shown in all
const MAX_HUNK_LINES = 60 // a longer hunk is cut
const MAX_OTHER_FILES = 3 // files the check read besides the finding's
const PATCH_LIMIT = 512 * 1024

interface Range {
	start: number
	end: number
}

export interface PatchFile {
	path: string
	hunks: Array<Hunk>
}

/** "src/a.ts:12-30" or "src/a.ts:12", as a check's `checked` lists them; anything else is skipped. */
export function parseChecked(checked: ReadonlyArray<string>): Array<{ path: string } & Range> {
	const out: Array<{ path: string } & Range> = []
	for (const c of checked) {
		const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(c.trim())
		if (m) out.push({ path: m[1], start: Number(m[2]), end: Number(m[3] ?? m[2]) })
	}
	return out
}

const span = (start: number, count: number): Range => ({ start, end: start + Math.max(count, 1) - 1 })
const touches = (a: Range, b: Range): boolean => a.start <= b.end + NEAR && b.start <= a.end + NEAR

/**
 * The hunks to show. `own` is the finding's file: a hunk counts when its old side touches the finding's lines (`range`,
 * in the earlier head; null for a whole-file finding or one on removed lines, which shows the whole file), or its new
 * side touches a range the check read in that file. `others` are other files the check read, by the same new-side test.
 */
export function selectFixedPatch(o: {
	from: string
	to: string
	rewritten: boolean
	own: PatchFile & { range: Range | null }
	checked: ReadonlyArray<{ path: string } & Range>
	others: ReadonlyArray<PatchFile>
}): FixedPatch {
	const parts: FixedPatch['parts'] = []
	let lines = 0
	let more = 0
	const read = (path: string): Array<Range> => o.checked.filter((c) => c.path === path)
	const add = (path: string, why: 'finding' | 'checked', hunks: Array<Hunk>): void => {
		const kept: Array<Hunk> = []
		let cut = false
		for (const h of hunks) {
			if (lines >= MAX_LINES) {
				more++
				continue
			}
			const room = Math.min(MAX_HUNK_LINES, MAX_LINES - lines)
			if (h.lines.length > room) cut = true
			const shown = h.lines.length > room ? { ...h, lines: h.lines.slice(0, room) } : h
			kept.push(shown)
			lines += shown.lines.length
		}
		if (kept.length) parts.push({ path, why, hunks: kept, cut })
	}

	const ownRead = read(o.own.path)
	add(
		o.own.path,
		'finding',
		o.own.hunks.filter(
			(h) =>
				!o.own.range || touches(span(h.oldStart, h.oldCount), o.own.range) || ownRead.some((r) => touches(span(h.newStart, h.newCount), r)),
		),
	)
	for (const f of o.others) {
		const ranges = read(f.path)
		add(
			f.path,
			'checked',
			f.hunks.filter((h) => ranges.some((r) => touches(span(h.newStart, h.newCount), r))),
		)
	}

	const notes: Array<string> = []
	if (!parts.length)
		notes.push(
			`Nothing changed at the finding’s lines${o.checked.length ? ' or the lines the double-check read' : ''} between ${short(o.from)} and ${short(o.to)}.`,
		)
	if (o.rewritten)
		notes.push(`The branch was force-pushed since ${short(o.from)}, so this can include changes that came from the base branch.`)
	return { from: o.from, to: o.to, parts, more, note: notes.length ? notes.join(' ') : null }
}

export async function loadFixedPatch(root: string, from: string, to: string, gone: GoneFinding, rewritten: boolean): Promise<FixedPatch> {
	const a = gone.finding.anchor
	const before = a.newPath ?? a.oldPath ?? a.fileKey
	const now = gone.at?.newPath ?? null
	const hunksOf = async (paths: Array<string>): Promise<Array<Hunk>> => {
		const r = await readPatchBetween(root, from, to, [...new Set(paths)], PATCH_LIMIT)
		if (r.truncated) throw new Error('the diff is too large to show')
		return parsePatch(r.text).flatMap((s) => (s.binary ? [] : s.hunks))
	}
	try {
		const own = await hunksOf(now ? [before, now] : [before])
		const checked = parseChecked(gone.check?.checked ?? [])
		const others: Array<PatchFile> = []
		const otherPaths = [...new Set(checked.map((c) => c.path))].filter((p) => p !== before && p !== now)
		for (const path of otherPaths.slice(0, MAX_OTHER_FILES)) others.push({ path, hunks: await hunksOf([path]) })
		return selectFixedPatch({
			from,
			to,
			rewritten,
			own: {
				path: now ?? before,
				hunks: own,
				range: a.side === 'new' && a.startLine !== null ? { start: a.startLine, end: a.endLine ?? a.startLine } : null,
			},
			checked,
			others,
		})
	} catch (e) {
		const why = e instanceof Error ? e.message : String(e)
		return { from, to, parts: [], more: 0, note: `What changed since ${short(from)} could not be read: ${why}` }
	}
}

function short(sha: string): string {
	return sha.slice(0, 7)
}
