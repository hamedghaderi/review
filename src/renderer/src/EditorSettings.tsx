import { useEffect, useState } from 'react'
import type { EditorChoice } from '../../shared/types.ts'

/** Settings › Editor: which editor "Open in editor" uses, out of the ones installed. */
export function EditorSettings() {
	const [choice, setChoice] = useState<EditorChoice | null>(null)
	const [error, setError] = useState<string | null>(null)
	useEffect(() => {
		void window.review.editors().then((r) => (r.ok ? setChoice(r.value) : setError(r.error.message)))
	}, [])
	const pick = async (id: string): Promise<void> => {
		setError(null)
		const r = await window.review.setEditor(id)
		if (r.ok) setChoice(r.value)
		else setError(r.error.message)
	}
	return (
		<div className="form">
			<h3>Editor</h3>
			<p className="muted small">
				Open in editor, next to a pull request’s branch name, checks out the pull request’s latest commit in a folder of its own and opens
				it there. The folder you work in and its branch are never touched. Once the pull request is merged or closed, that folder is removed
				the next time Review connects to GitHub, unless you changed or added something in it. Your editor may run things in that folder,
				such as tasks, extensions or language servers, the same as when you open any repository.
			</p>
			{choice &&
				(choice.installed.length ? (
					<label className="field">
						<span>Open pull requests in</span>
						<select value={choice.chosen ?? ''} onChange={(e) => void pick(e.target.value)}>
							{choice.installed.map((e) => (
								<option key={e.id} value={e.id}>
									{e.label}
								</option>
							))}
						</select>
					</label>
				) : (
					<p className="small">
						No supported editor was found. Review knows Visual Studio Code, Cursor, Zed, Windsurf, VSCodium, Sublime Text and the JetBrains
						IDEs: on macOS in Applications, elsewhere as their command on your PATH (for example <code>code</code> or <code>zed</code>).
					</p>
				))}
			{error && <p className="small error-text">{error}</p>}
		</div>
	)
}
