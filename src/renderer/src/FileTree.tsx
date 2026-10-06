import { useMemo, useState } from 'react'
import type { ChangedFile } from '../../shared/types.ts'
import { buildTree, displayPath, type DirNode } from './tree.ts'

type Filter = 'all' | 'unreviewed' | 'commented'

interface Props {
	files: Array<ChangedFile>
	selected: string | null
	viewed: Set<string>
	commented: Map<string, number>
	onSelect(key: string): void
	onToggleViewed(key: string): void
	onNextUnreviewed(): void
}

const STATUS_LETTER: Record<ChangedFile['status'], string> = {
	added: 'A',
	deleted: 'D',
	modified: 'M',
	renamed: 'R',
	copied: 'C',
	'type-changed': 'T',
}

export function FileTree({ files, selected, viewed, commented, onSelect, onToggleViewed, onNextUnreviewed }: Props) {
	const [query, setQuery] = useState('')
	const [filter, setFilter] = useState<Filter>('all')
	const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())

	const counts = useMemo(
		() => ({
			all: files.length,
			unreviewed: files.filter((f) => !viewed.has(f.key)).length,
			commented: files.filter((f) => commented.has(f.key)).length,
		}),
		[files, viewed, commented],
	)

	const tree = useMemo(() => {
		const q = query.trim().toLowerCase()
		const shown = files.filter((f) => {
			if (filter === 'unreviewed' && viewed.has(f.key)) return false
			if (filter === 'commented' && !commented.has(f.key)) return false
			if (!q) return true
			return displayPath(f).toLowerCase().includes(q) || (f.oldPath?.toLowerCase().includes(q) ?? false)
		})
		return { root: buildTree(shown), count: shown.length }
	}, [files, filter, query, viewed, commented])

	const searching = query.trim() !== ''
	const toggle = (path: string): void =>
		setCollapsed((s) => {
			const n = new Set(s)
			if (n.has(path)) n.delete(path)
			else n.add(path)
			return n
		})

	const renderDir = (node: DirNode, depth: number): React.ReactNode => (
		<>
			{node.dirs.map((d) => {
				const open = searching || !collapsed.has(d.path)
				return (
					<div key={`d:${d.path}`} role="treeitem" aria-expanded={open}>
						<button className="tree-row tree-dir" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => toggle(d.path)} title={d.path}>
							<span className={`chev ${open ? 'open' : ''}`} aria-hidden>
								▸
							</span>
							<span className="tree-name">{d.name}</span>
						</button>
						{open && <div role="group">{renderDir(d, depth + 1)}</div>}
					</div>
				)
			})}
			{node.files.map((f) => {
				const path = displayPath(f)
				const name = path.slice(path.lastIndexOf('/') + 1)
				const isViewed = viewed.has(f.key)
				const n = commented.get(f.key)
				return (
					<div
						key={`f:${f.key}`}
						role="treeitem"
						aria-selected={selected === f.key}
						className={`tree-row tree-file ${selected === f.key ? 'selected' : ''} ${isViewed ? 'viewed' : ''}`}
						style={{ paddingLeft: 8 + depth * 12 }}
						onClick={() => onSelect(f.key)}
						title={f.oldPath && f.newPath && f.oldPath !== f.newPath ? `${f.oldPath} → ${f.newPath}` : path}
					>
						<input
							type="checkbox"
							className="viewed-box"
							checked={isViewed}
							aria-label={`Mark ${path} as viewed`}
							onClick={(e) => e.stopPropagation()}
							onChange={() => onToggleViewed(f.key)}
						/>
						<span className={`status st-${f.status}`} title={f.status}>
							{STATUS_LETTER[f.status]}
						</span>
						<span className="tree-name">{name}</span>
						{n ? (
							<span className="badge" title={`${n} comment${n === 1 ? '' : 's'}`}>
								{n}
							</span>
						) : null}
						<span className="stat">
							{f.binary ? (
								'bin'
							) : (
								<>
									{f.additions ? <span className="plus">+{f.additions}</span> : null}
									{f.deletions ? <span className="minus">−{f.deletions}</span> : null}
								</>
							)}
						</span>
					</div>
				)
			})}
		</>
	)

	return (
		<div className="tree">
			<div className="tree-tools">
				<input
					className="search"
					type="search"
					placeholder="Filter files by name or path"
					data-search
					value={query}
					onChange={(e) => setQuery(e.target.value)}
				/>
				<div className="seg" role="tablist">
					{(
						[
							['all', 'All'],
							['unreviewed', 'Unreviewed'],
							['commented', 'Commented'],
						] as const
					).map(([k, label]) => (
						<button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
							{label} <span className="count">{counts[k]}</span>
						</button>
					))}
				</div>
				<div
					className="tree-viewed"
					role="progressbar"
					aria-label="Files marked as viewed"
					aria-valuemin={0}
					aria-valuemax={counts.all}
					aria-valuenow={counts.all - counts.unreviewed}
					title={`${counts.all - counts.unreviewed} of ${counts.all} files marked as viewed`}
				>
					<span style={{ width: `${counts.all ? (100 * (counts.all - counts.unreviewed)) / counts.all : 0}%` }} />
				</div>
				<div className="tree-actions">
					<button className="btn small" onClick={onNextUnreviewed} disabled={counts.unreviewed === 0}>
						Next unreviewed
					</button>
					<button className="btn small ghost" onClick={() => setCollapsed(new Set())}>
						Expand all
					</button>
				</div>
			</div>
			<div className="tree-list" role="tree">
				{tree.count === 0 ? (
					<div className="muted pad">{files.length === 0 ? 'No changed files.' : 'No files match.'}</div>
				) : (
					renderDir(tree.root, 0)
				)}
			</div>
		</div>
	)
}
