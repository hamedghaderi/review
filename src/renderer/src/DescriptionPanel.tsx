import DOMPurify from 'dompurify'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppError, PrDescription } from '../../shared/types.ts'
import { useMentionCommand } from './Mention.tsx'

interface Props {
	repoId: string
	reviewId: string
	onConnect(): void
}

interface Draft {
	base: string // the description the edit started from, sent back so a change on GitHub is never overwritten
	text: string
	tab: 'write' | 'preview'
}

// Unsaved edits per review, kept while the app runs so switching tabs or reviews doesn't lose them.
const drafts = new Map<string, Draft>()

/**
 * The open PR review's description: GitHub's rendering of it, and an editor that saves it back to GitHub. Read from
 * GitHub when the tab opens; it doesn't update by itself.
 */
export function DescriptionPanel({ repoId, reviewId, onConnect }: Props) {
	const key = `${repoId}\u0000${reviewId}`
	const [d, setD] = useState<PrDescription | null>(null)
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<AppError | null>(null)
	const [draft, setDraftState] = useState<Draft | null>(() => drafts.get(key) ?? null)
	const [preview, setPreview] = useState<{ text: string; html: string } | null>(null)
	const [previewError, setPreviewError] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)

	const setDraft = useCallback(
		(next: Draft | null) => {
			if (next) drafts.set(key, next)
			else drafts.delete(key)
			setDraftState(next)
		},
		[key],
	)
	const inputRef = useRef<HTMLTextAreaElement>(null)
	const mention = useMentionCommand(draft?.text ?? '', inputRef, (next) => draft && setDraft({ ...draft, text: next }))

	const load = useCallback(async () => {
		setLoading(true)
		const r = await window.review.prDescription(repoId, reviewId)
		setLoading(false)
		if (r.ok) {
			setD(r.value)
			setError(null)
		} else setError(r.error)
	}, [repoId, reviewId])

	useEffect(() => {
		setDraftState(drafts.get(key) ?? null)
		setPreview(null)
		void load()
	}, [key, load])

	// Preview what GitHub will show, rendered by GitHub; asked again only when the text changed.
	useEffect(() => {
		if (draft?.tab !== 'preview' || preview?.text === draft.text) return
		let live = true
		setPreviewError(null)
		void window.review.prDescriptionPreview(repoId, reviewId, draft.text).then((r) => {
			if (!live) return
			if (r.ok) setPreview({ text: draft.text, html: r.value })
			else setPreviewError(r.error.message)
		})
		return () => {
			live = false
		}
	}, [draft?.tab, draft?.text, preview?.text, repoId, reviewId])

	async function save(): Promise<void> {
		if (!draft) return
		setSaving(true)
		const r = await window.review.prDescriptionUpdate(repoId, reviewId, draft.base, draft.text)
		setSaving(false)
		if (r.ok) {
			setD(r.value)
			setError(null)
			setDraft(null)
		} else setError(r.error)
	}

	function cancel(): void {
		if (draft && draft.text !== draft.base && !window.confirm('Discard your changes to the description?')) return
		setDraft(null)
		setError(null)
	}

	/** After a conflict: show GitHub's new text and start the edit from it, keeping what you wrote. */
	async function rebase(): Promise<void> {
		const r = await window.review.prDescription(repoId, reviewId)
		if (!r.ok) return setError(r.error)
		setD(r.value)
		setError(null)
		if (draft) setDraft({ ...draft, base: r.value.body })
	}

	const conflict = error?.code === 'pr-changed'
	return (
		<div className="comments description">
			<div className="gh-status small">
				<span className="muted">
					{loading
						? 'Reading from GitHub…'
						: d
							? `Read ${new Date(d.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · doesn’t update by itself`
							: ''}
				</span>
				<span className="spacer" />
				{d && !draft && (
					<button
						className="btn small"
						disabled={!d.canEdit}
						title={d.editIssue ?? 'Edit the description on GitHub'}
						onClick={() => setDraft({ base: d.body, text: d.body, tab: 'write' })}
					>
						Edit
					</button>
				)}
				<button className="btn small" onClick={() => void load()} disabled={loading}>
					Refresh
				</button>
			</div>
			{error && (
				<div className="gh-reason small error-text">
					{error.message}{' '}
					{conflict && draft && (
						<button className="link" onClick={() => void rebase()}>
							Show the new text
						</button>
					)}
					{error.code === 'github-auth' && (
						<button className="link" onClick={onConnect}>
							Connect GitHub
						</button>
					)}
				</div>
			)}
			{d && !d.canEdit && d.editIssue && !draft && <p className="small muted desc-note">{d.editIssue}</p>}
			{draft ? (
				<div className="desc-editor">
					{draft.tab === 'write' && mention.panel}
					<div className="seg" role="tablist" aria-label="Editor">
						{(['write', 'preview'] as const).map((t) => (
							<button
								key={t}
								role="tab"
								aria-selected={draft.tab === t}
								className={draft.tab === t ? 'on' : ''}
								onClick={() => setDraft({ ...draft, tab: t })}
							>
								{t === 'write' ? 'Write' : 'Preview'}
							</button>
						))}
					</div>
					{draft.tab === 'write' ? (
						<textarea
							ref={inputRef}
							className="desc-input mono"
							value={draft.text}
							spellCheck
							autoFocus
							maxLength={65_536}
							aria-label="Pull request description (Markdown)"
							onChange={(e) => setDraft({ ...draft, text: e.target.value })}
							onKeyDown={(e) => {
								if (mention.onKeyDown(e)) return
								if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && draft.text !== draft.base) {
									e.preventDefault()
									void save()
								}
							}}
						/>
					) : previewError ? (
						<p className="small error-text">{previewError}</p>
					) : preview?.text === draft.text ? (
						<GitHubHtml html={preview.html} empty="Nothing to preview." />
					) : (
						<p className="small muted">Rendering…</p>
					)}
					<div className="form-actions">
						<button className="btn small primary" disabled={saving || draft.text === draft.base} onClick={() => void save()}>
							{saving ? 'Saving…' : 'Save to GitHub'}
						</button>
						<button className="btn small" onClick={cancel} disabled={saving}>
							Cancel
						</button>
						<span className="muted small">Markdown · visible to everyone on the pull request once saved</span>
					</div>
				</div>
			) : d ? (
				<GitHubHtml html={d.html} empty="No description provided." />
			) : null}
		</div>
	)
}

/**
 * HTML that GitHub rendered from Markdown, sanitised again here: no scripts, styles, forms or event handlers. Links
 * open in your browser and show where they go; images become links, since the window loads no remote images.
 */
function GitHubHtml({ html, empty }: { html: string; empty: string }) {
	const box = useRef<HTMLDivElement>(null)
	useEffect(() => {
		const el = box.current
		if (!el) return
		const frag = DOMPurify.sanitize(html, {
			USE_PROFILES: { html: true },
			FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'video', 'audio', 'source'],
			RETURN_DOM_FRAGMENT: true,
		})
		for (const a of frag.querySelectorAll('a')) {
			const href = a.getAttribute('href') ?? ''
			if (/^https?:\/\//i.test(href)) {
				a.setAttribute('target', '_blank')
				a.setAttribute('rel', 'noreferrer noopener')
				a.setAttribute('title', href)
			} else a.removeAttribute('href') // in-page anchors and other schemes: text only
		}
		for (const img of frag.querySelectorAll('img')) {
			const src = img.getAttribute('src') ?? ''
			const label = `🖼 ${img.getAttribute('alt')?.trim() || 'image'}`
			const link = document.createElement(/^https?:\/\//i.test(src) ? 'a' : 'span')
			link.textContent = label
			link.className = 'desc-image'
			if (link instanceof HTMLAnchorElement) {
				link.href = src
				link.target = '_blank'
				link.rel = 'noreferrer noopener'
				link.title = 'Images aren’t loaded in the app. Opens in your browser.'
			}
			// GitHub wraps images in a link to the full-size file; keep a single link.
			const parent = img.parentElement
			if (parent instanceof HTMLAnchorElement && parent.childNodes.length === 1) parent.replaceWith(link)
			else img.replaceWith(link)
		}
		for (const input of frag.querySelectorAll('input')) input.setAttribute('disabled', '')
		el.replaceChildren(frag)
	}, [html])
	if (!html.trim()) return <p className="small muted desc-note">{empty}</p>
	return <div ref={box} className="md-body selectable" />
}
