import { useEffect, useState } from 'react'
import { claudeCommand, mcpJson } from '../../shared/agentSetup.ts'
import type { AgentSetup } from '../../shared/types.ts'

/**
 * Settings › Coding agents (issue #200): how to give an agent like Claude Code read-only access to Review's findings
 * and runs for the repository it works in. Review only shows the command; you add it to the agent yourself.
 */

export function AgentSettings() {
	const [setup, setSetup] = useState<AgentSetup | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [copied, setCopied] = useState<string | null>(null)

	useEffect(() => {
		void window.review.agentSetup().then((r) => (r.ok ? setSetup(r.value) : setError(r.error.message)))
	}, [])

	const copy = (what: string, text: string): void => {
		void navigator.clipboard.writeText(text).then(() => {
			setCopied(what)
			setTimeout(() => setCopied((c) => (c === what ? null : c)), 1500)
		})
	}

	return (
		<div className="settings-main form">
			<h3>Coding agents</h3>
			<p className="muted small">
				Let the coding agent you work with read what Review found, so you can ask it to “fix the blocking findings Review raised on this
				branch”. It gets three read-only tools for the repository it works in: <code>reviews</code>, <code>findings</code> and{' '}
				<code>run</code>. It reads Review’s data on this computer, also while Review is closed. It can’t post, resolve, change anything or
				reach GitHub, and it only sees repositories you’ve opened in Review.
			</p>
			{error && <p className="small error-text">{error}</p>}
			{setup && !setup.ready && (
				<p className="small error-text">The server isn’t built yet. Restart Review (in development: restart npm run dev).</p>
			)}
			{setup && (
				<>
					{setup.extract && (
						<div className="agent-snippet">
							<div className="agent-snippet-head">
								<strong className="small">First: extract the AppImage once</strong>
								<span className="spacer" />
								<button className="btn small" onClick={() => copy('extract', setup.extract!.command)}>
									{copied === 'extract' ? 'Copied' : 'Copy'}
								</button>
							</div>
							<pre className="mono small">{setup.extract.command}</pre>
							<p className="muted small">
								Review is running from an AppImage, which Linux opens in a different temporary folder each time, so an agent can’t start the
								server from it. This unpacks it into <span className="mono">{setup.extract.folder}</span>, which the commands below use.
								After you update Review, delete that folder and run this again.
							</p>
						</div>
					)}
					<div className="agent-snippet">
						<div className="agent-snippet-head">
							<strong className="small">Claude Code</strong>
							<span className="spacer" />
							<button className="btn small" onClick={() => copy('claude', claudeCommand(setup))}>
								{copied === 'claude' ? 'Copied' : 'Copy'}
							</button>
						</div>
						<pre className="mono small">{claudeCommand(setup)}</pre>
						<p className="muted small">Run it once in a terminal. It adds the server for all your projects.</p>
					</div>
					<div className="agent-snippet">
						<div className="agent-snippet-head">
							<strong className="small">Other agents (MCP config)</strong>
							<span className="spacer" />
							<button className="btn small" onClick={() => copy('json', mcpJson(setup))}>
								{copied === 'json' ? 'Copied' : 'Copy'}
							</button>
						</div>
						<pre className="mono small">{mcpJson(setup)}</pre>
					</div>
					<p className="muted small">
						{setup.extract
							? 'The commands point at the extracted copy, not at the AppImage.'
							: 'If you move or reinstall Review somewhere else, copy the command again: it points at this copy of the app.'}
					</p>
				</>
			)}
		</div>
	)
}
