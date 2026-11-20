import { useEffect, useState } from 'react'
import { announce } from './announce.ts'

/**
 * The branch under review, selectable, with a button that copies its name to check it out elsewhere (issue #257). A
 * pull request from a fork shows and copies "owner:branch", as GitHub does.
 */
export function BranchRef({ name }: { name: string }) {
	const [copied, setCopied] = useState<'yes' | 'failed' | null>(null)
	useEffect(() => {
		if (!copied) return
		const t = setTimeout(() => setCopied(null), 1500)
		return () => clearTimeout(t)
	}, [copied])
	const copy = (): void => {
		navigator.clipboard.writeText(name).then(
			() => {
				setCopied('yes')
				announce('Branch name copied', 'result')
			},
			() => {
				setCopied('failed')
				announce('Could not copy the branch name', 'result')
			},
		)
	}
	return (
		<span className="branch-ref">
			<span className="mono ellipsis selectable" title={name}>
				{name}
			</span>
			<button
				className="copy-ref"
				onClick={copy}
				title={copied === 'yes' ? 'Copied' : copied === 'failed' ? 'Could not copy to the clipboard' : 'Copy branch name'}
				aria-label={`Copy branch name ${name}`}
			>
				<svg
					width="13"
					height="13"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					{copied === 'yes' ? (
						<path d="M5 12.5l4.5 4.5L19 7.5" />
					) : (
						<>
							<rect x="8" y="8" width="12" height="12" rx="2" />
							<path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
						</>
					)}
				</svg>
			</button>
		</span>
	)
}
