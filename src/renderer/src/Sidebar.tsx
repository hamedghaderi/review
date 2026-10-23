import { useEffect, useRef, type ReactNode } from 'react'
import type { GitHubStatus, RepoTab } from '../../shared/types.ts'
import { keyLabel, useKeymap } from './keymap.ts'

/** The tooltip, with the action's shortcut on a line of its own when it has one. */
const withKey = (text: string, id: string): string => (keyLabel(id) ? `${text}\n${keyLabel(id)}` : text)

/**
 * The app's left sidebar: Home and Outcomes pinned at the top, one vertical tab per open repository under them, and
 * GitHub, Settings and Feedback at the bottom. Collapsed, it shows icons and each repository's initial.
 */
export function Sidebar(props: {
	collapsed: boolean
	tabs: Array<RepoTab>
	activeId: string | null
	page: 'home' | 'outcomes' | null
	homeCount: number
	github: GitHubStatus | null
	githubText: string
	error: string | null
	extensionHint: { url: string } | null // no browser link has opened a review yet
	onToggle(): void
	onHome(): void
	onOutcomes(): void
	onSelect(id: string): void
	onClose(id: string): void
	onOpen(): void
	onGitHub(): void
	onSettings(): void
	onFeedback(): void
	onDismissError(): void
}) {
	const { tabs, activeId, collapsed } = props
	useKeymap()
	// When focus is in the list, it follows the selected entry, so a shortcut never leaves the ring on the old one.
	const nav = useRef<HTMLElement>(null)
	useEffect(() => {
		const el = nav.current
		if (el && el.contains(document.activeElement) && document.activeElement?.getAttribute('role') === 'tab')
			el.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
	}, [activeId, props.page])
	// Same-named clones are told apart by their parent folder.
	const label = (t: RepoTab): string => {
		if (tabs.filter((x) => x.name === t.name).length < 2) return t.name
		const parent = t.root.split(/[\\/]/).slice(-2, -1)[0]
		return parent ? `${parent}/${t.name}` : t.name
	}
	return (
		<nav className={`sidebar${collapsed ? ' collapsed' : ''}`} aria-label="Pages and repositories" ref={nav}>
			<div className="sidebar-top">
				<button
					className="side-item side-toggle"
					onClick={props.onToggle}
					aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
					aria-expanded={!collapsed}
					title={withKey(`${collapsed ? 'Expand' : 'Collapse'} sidebar`, 'sidebar')}
				>
					<Icon>
						<rect x="3" y="3" width="18" height="18" rx="2" />
						<path d="M9 3v18" />
					</Icon>
				</button>
			</div>
			<div className="side-list" role="tablist" aria-orientation="vertical">
				<SideTab
					on={props.page === 'home'}
					collapsed={collapsed}
					label="Home"
					count={props.homeCount}
					countTitle={`${props.homeCount} waiting for you`}
					title={withKey('Pull requests waiting for you in all repositories', 'home')}
					icon={
						<Icon>
							<path d="M3 10.5 12 3l9 7.5" />
							<path d="M5 9v11h14V9" />
						</Icon>
					}
					onClick={props.onHome}
				/>
				<SideTab
					on={props.page === 'outcomes'}
					collapsed={collapsed}
					label="Outcomes"
					title={withKey('What became of the AI’s findings: accepted, dismissed and fixed, by model and rule', 'outcomes')}
					icon={
						<Icon>
							<path d="M3 3v18h18" />
							<path d="M7 15l4-4 3 3 5-6" />
						</Icon>
					}
					onClick={props.onOutcomes}
				/>
				<div className="side-section" role="presentation">
					<span className="side-section-title">Repositories</span>
				</div>
				{tabs.map((t, i) => (
					<SideTab
						key={t.id}
						on={props.page === null && t.id === activeId}
						collapsed={collapsed}
						label={label(t)}
						count={t.requests}
						countTitle={`${t.requests} open review request${t.requests === 1 ? '' : 's'}`}
						title={i < 8 ? withKey(t.root, `repo${i + 1}`) : i === tabs.length - 1 ? withKey(t.root, 'repoLast') : t.root}
						icon={<span className="side-initial">{t.name.slice(0, 1).toUpperCase()}</span>}
						onClick={() => props.onSelect(t.id)}
						onClose={() => props.onClose(t.id)}
						closeTitle="Close. Its reviews are kept and its review requests still notify."
					/>
				))}
				<button className="side-item side-add" onClick={props.onOpen} title="Open repository…" aria-label="Open repository">
					<Icon>
						<path d="M12 5v14M5 12h14" />
					</Icon>
					<span className="side-label">Open repository…</span>
				</button>
			</div>
			{props.error && (
				<button className="notice side-error" onClick={props.onDismissError} title={`${props.error}\nDismiss`}>
					{collapsed ? '!' : `${props.error} ✕`}
				</button>
			)}
			<div className="sidebar-bottom">
				{props.extensionHint && !collapsed && (
					<a
						className="side-hint small"
						href={props.extensionHint.url}
						target="_blank"
						rel="noreferrer"
						title="The Open in Review extension for Chrome. Press Shift+R on a pull request on github.com to open its review here. This goes away once you have opened one that way."
					>
						Open pull requests from GitHub with Shift+R: get the Chrome extension ↗
					</a>
				)}
				<button
					className={`side-item side-gh ${props.github?.state ?? 'checking'}`}
					onClick={props.onGitHub}
					title={`${props.githubText}\nClick for GitHub settings.`}
					aria-label={`GitHub settings. ${props.githubText}`}
				>
					<span className="side-icon">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
							<path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
						</svg>
						<span className="gh-dot" aria-hidden="true" />
					</span>
					<span className="side-label">GitHub</span>
				</button>
				<button className="side-item" onClick={props.onSettings} title={withKey('Settings', 'settings')} aria-label="Settings">
					<Icon>
						<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
						<circle cx="12" cy="12" r="3" />
					</Icon>
					<span className="side-label">Settings</span>
				</button>
				<button
					className="side-item"
					onClick={props.onFeedback}
					title="Report a problem or suggest an idea on GitHub"
					aria-label="Feedback"
				>
					<Icon>
						<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
					</Icon>
					<span className="side-label">Feedback</span>
				</button>
			</div>
		</nav>
	)
}

/** One entry in the sidebar's tab list: an icon, a label that hides when collapsed, an optional count and close button. */
function SideTab(props: {
	on: boolean
	collapsed: boolean
	label: string
	icon: ReactNode
	title: string
	count?: number | null
	countTitle?: string
	onClick(): void
	onClose?(): void
	closeTitle?: string
}) {
	const count = props.count ?? 0
	return (
		<div className={`side-tab${props.on ? ' on' : ''}`}>
			<button
				role="tab"
				aria-selected={props.on}
				className="side-item"
				aria-label={count ? `${props.label}, ${props.countTitle}` : props.label}
				title={props.collapsed ? `${props.label}\n${props.title}` : props.title}
				onClick={props.onClick}
				onAuxClick={(e) => e.button === 1 && props.onClose?.()}
			>
				<span className="side-icon">{props.icon}</span>
				<span className="side-label ellipsis">{props.label}</span>
				{count > 0 && (
					<span className="side-count" title={props.countTitle}>
						{props.collapsed && count > 9 ? '9+' : count}
					</span>
				)}
			</button>
			{props.onClose && !props.collapsed && (
				<button className="side-close" aria-label={`Close ${props.label}`} title={props.closeTitle} onClick={props.onClose}>
					×
				</button>
			)}
		</div>
	)
}

function Icon({ children }: { children: ReactNode }) {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{children}
		</svg>
	)
}
