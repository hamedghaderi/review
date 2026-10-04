import type { ChangedFile } from '../../shared/types.ts'

export interface DirNode {
	name: string // may be a compacted chain like "src/main"
	path: string
	dirs: Array<DirNode>
	files: Array<ChangedFile>
}

export function displayPath(f: ChangedFile): string {
	return (f.newPath ?? f.oldPath) as string
}

/** Builds a folder tree (folders first, then files, alphabetical) and compacts single-child folder chains. */
export function buildTree(files: Array<ChangedFile>): DirNode {
	const root: DirNode = { name: '', path: '', dirs: [], files: [] }
	const index = new Map<string, DirNode>([['', root]])
	for (const f of files) {
		const parts = displayPath(f).split('/')
		let node = root
		let path = ''
		for (const part of parts.slice(0, -1)) {
			path = path ? `${path}/${part}` : part
			let next = index.get(path)
			if (!next) {
				next = { name: part, path, dirs: [], files: [] }
				index.set(path, next)
				node.dirs.push(next)
			}
			node = next
		}
		node.files.push(f)
	}
	const sort = (n: DirNode): DirNode => {
		n.dirs = n.dirs.map(sort).map(compact)
		n.dirs.sort((a, b) => a.name.localeCompare(b.name))
		n.files.sort((a, b) => displayPath(a).localeCompare(displayPath(b)))
		return n
	}
	return sort(root)
}

function compact(n: DirNode): DirNode {
	while (n.files.length === 0 && n.dirs.length === 1) {
		const c = n.dirs[0]
		n = { ...c, name: `${n.name}/${c.name}` }
	}
	return n
}

export function flatten(n: DirNode, out: Array<ChangedFile> = []): Array<ChangedFile> {
	for (const d of n.dirs) flatten(d, out)
	out.push(...n.files)
	return out
}
