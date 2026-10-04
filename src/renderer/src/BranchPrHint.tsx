import { useEffect, useState } from 'react'
import type { AppError, BranchPr, PrDetail } from '../../shared/types.ts'

/** Looks up the pull request for a branch. `null` while loading or when GitHub isn't mapped. */
export function useBranchPr(repoId: string, headRef: string | null, enabled: boolean): { data: BranchPr | null; error: AppError | null } {
	const [state, setState] = useState<{ key: string; data: BranchPr | null; error: AppError | null }>({ key: '', data: null, error: null })
	const key = `${repoId}|${headRef}`
	useEffect(() => {
		if (!enabled || !headRef) return
		let live = true
		// Short delay so arrowing through the branch list doesn't fire a request per row.
		const t = window.setTimeout(() => {
			void window.review.branchPr(repoId, headRef).then((r) => {
				if (live) setState({ key, data: r.ok ? r.value : null, error: r.ok ? null : r.error })
			})
		}, 250)
		return () => {
			live = false
			window.clearTimeout(t)
		}
	}, [key, enabled]) // eslint-disable-line react-hooks/exhaustive-deps
	return state.key === key ? state : { data: null, error: null }
}

const LABEL: Record<PrDetail['state'], string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' }

/** "PR #123 · Open · Open PR review" for a branch, or why none was found. */
export function BranchPrHint(props: {
	data: BranchPr | null
	error: AppError | null
	opening: boolean
	onOpen(pr: PrDetail): void
	onConnect?(): void
	compact?: boolean
}) {
	const { data, error } = props
	if (error) {
		return (
			<span className="branch-pr small">
				<span className="warn-text selectable">Can’t look up this branch’s pull request: {lookupProblem(error)}</span>
				{props.onConnect && isAuthProblem(error) && (
					<button className="btn small primary" onClick={props.onConnect}>
						Connect GitHub
					</button>
				)}
			</span>
		)
	}
	if (!data?.head) return null
	const pr = data.prs[0]
	if (!pr)
		return props.compact ? null : (
			<span className="small muted">
				No pull request from <span className="mono">{data.head}</span> in {data.repo}
			</span>
		)
	return (
		<span className="branch-pr small">
			<span className={`pr-state ${pr.state}`}>{LABEL[pr.state]}</span>
			<a href={pr.url} target="_blank" rel="noreferrer" className="ellipsis" title={pr.title}>
				#{pr.number} {props.compact ? '' : pr.title}
			</a>
			{data.prs.length > 1 && (
				<span
					className="muted"
					title={data.prs
						.slice(1)
						.map((p) => `#${p.number} ${LABEL[p.state]}: ${p.title}`)
						.join('\n')}
				>
					+{data.prs.length - 1} older
				</span>
			)}
			<button className="btn small primary" disabled={props.opening} onClick={() => props.onOpen(pr)}>
				Open PR review
			</button>
		</span>
	)
}

export function isAuthProblem(e: AppError): boolean {
	return e.code === 'github-not-found' || e.code === 'github-auth' || e.code === 'github-forbidden'
}

export function lookupProblem(e: AppError): string {
	if (e.code === 'github-not-found')
		return 'GitHub says the repository doesn’t exist, which is what it says for private repositories without a token.'
	return e.message
}
