import type { FileStatus, Hunk } from '../shared/types.ts'

export interface PatchSection {
	isNew: boolean
	isDeleted: boolean
	isRename: boolean
	binary: boolean
	hunks: Array<Hunk>
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

/** Parses `git diff-tree -p` output into per-file sections. Content lines are always prefixed, so headers never collide with them. */
export function parsePatch(text: string): Array<PatchSection> {
	const sections: Array<PatchSection> = []
	const lines = text.split('\n')
	let cur: PatchSection | null = null
	let hunk: Hunk | null = null
	let oldLeft = 0
	let newLeft = 0
	let oldNo = 0
	let newNo = 0

	for (let raw of lines) {
		if (raw.endsWith('\r')) raw = raw.slice(0, -1)
		if (hunk && (oldLeft > 0 || newLeft > 0)) {
			const c = raw[0]
			const body = raw.slice(1)
			if (c === ' ') {
				hunk.lines.push({ kind: 'ctx', oldNo: oldNo++, newNo: newNo++, text: body })
				oldLeft--
				newLeft--
				continue
			}
			if (c === '-') {
				hunk.lines.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: body })
				oldLeft--
				continue
			}
			if (c === '+') {
				hunk.lines.push({ kind: 'add', oldNo: null, newNo: newNo++, text: body })
				newLeft--
				continue
			}
			if (c === '\\') {
				markNoNewline(hunk)
				continue
			}
			// Malformed or truncated hunk: stop consuming it.
			hunk = null
		}
		if (hunk && raw.startsWith('\\')) {
			markNoNewline(hunk)
			continue
		}
		if (raw.startsWith('diff --git ')) {
			cur = { isNew: false, isDeleted: false, isRename: false, binary: false, hunks: [] }
			sections.push(cur)
			hunk = null
			continue
		}
		if (!cur) continue
		const m = HUNK_RE.exec(raw)
		if (m) {
			hunk = {
				oldStart: Number(m[1]),
				oldCount: m[2] === undefined ? 1 : Number(m[2]),
				newStart: Number(m[3]),
				newCount: m[4] === undefined ? 1 : Number(m[4]),
				section: m[5] ?? '',
				lines: [],
			}
			oldLeft = hunk.oldCount
			newLeft = hunk.newCount
			oldNo = hunk.oldStart
			newNo = hunk.newStart
			cur.hunks.push(hunk)
			continue
		}
		if (hunk) continue
		if (raw.startsWith('new file mode')) cur.isNew = true
		else if (raw.startsWith('deleted file mode')) cur.isDeleted = true
		else if (raw.startsWith('rename from ')) cur.isRename = true
		else if (raw.startsWith('Binary files ') || raw === 'GIT binary patch') cur.binary = true
	}
	return sections
}

function markNoNewline(hunk: Hunk): void {
	const last = hunk.lines[hunk.lines.length - 1]
	if (last) last.noNewline = true
}

/** Picks the section that corresponds to a changed file when a pathspec matched several (e.g. rename source re-added). */
export function pickSection(sections: Array<PatchSection>, status: FileStatus): PatchSection | null {
	const want = (s: PatchSection): boolean => {
		switch (status) {
			case 'renamed':
			case 'copied':
				return s.isRename || (!s.isNew && !s.isDeleted)
			case 'added':
				return s.isNew
			case 'deleted':
				return s.isDeleted
			case 'type-changed':
				return s.isNew
			default:
				return !s.isNew && !s.isDeleted && !s.isRename
		}
	}
	return sections.find(want) ?? sections[0] ?? null
}
