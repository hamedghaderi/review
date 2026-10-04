import { Component, type ReactNode } from 'react'

/**
 * Keeps a failing panel from taking the whole window with it: React unmounts everything on an uncaught render error,
 * which looks like the app disappearing. Shows the error in place instead; changing `resetKey` (another tab or
 * comparison) or "Try again" renders the panel afresh.
 */
export class PanelBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null; key: string }> {
	state = { error: null as Error | null, key: this.props.resetKey }

	static getDerivedStateFromError(error: Error): Partial<{ error: Error }> {
		return { error }
	}

	static getDerivedStateFromProps(props: { resetKey: string }, state: { error: Error | null; key: string }) {
		return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null
	}

	componentDidCatch(error: Error): void {
		console.error('[panel] render failed', error)
	}

	render(): ReactNode {
		if (!this.state.error) return this.props.children
		return (
			<div className="pad small">
				<p className="error-text">This panel could not be shown: {this.state.error.message}</p>
				<p className="muted">The rest of the app still works. This is a bug in the app; the error is in the developer console.</p>
				<button className="btn small" onClick={() => this.setState({ error: null })}>
					Try again
				</button>
			</div>
		)
	}
}
