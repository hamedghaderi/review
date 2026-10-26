import semver from 'semver'
import type { ReleaseNote } from './types.ts'

/**
 * Which release notes "What's new" shows: the versions after `from` up to and including `to`, or only `to` when what
 * you had before is unknown (`from` null). `all`: every one, for Help › What's New.
 */
export type NotesRange = { kind: 'since'; from: string | null; to: string } | { kind: 'all' }

export function notesIn(notes: ReadonlyArray<ReleaseNote>, range: NotesRange): Array<ReleaseNote> {
	if (range.kind === 'all') return [...notes]
	const { from, to } = range
	return notes.filter((n) => (from === null ? n.version === to : semver.gt(n.version, from) && semver.lte(n.version, to)))
}

/**
 * What to show when the app starts: the notes since the last version you saw, when this one is newer. A fresh install
 * shows nothing (there was nothing before it); an install from before this was recorded shows only this version.
 */
export function whatsNewOnStart(seen: string | null, current: string, fresh: boolean): NotesRange | null {
	if (seen === null) return fresh ? null : { kind: 'since', from: null, to: current }
	return semver.valid(seen) && semver.gt(current, seen) ? { kind: 'since', from: seen, to: current } : null
}
