import { useEffect, useRef, useState } from 'react'
import { CONTEXT_LIMITS, type ContextImage, type ReviewContext } from '../../shared/types.ts'

interface Props {
	context: ReviewContext | null
	isPr: boolean
	onNotes(notes: string): void
	onAddFiles(files: Array<{ name: string; text: string }>): void
	onRemoveFile(id: string): void
	onAddImages(images: Array<ContextImage>): void
	onRemoveImage(id: string): void
}

type Read = { files: Array<{ name: string; text: string }>; images: Array<ContextImage>; problems: Array<string> }

const isImage = (f: File): boolean => f.type.startsWith('image/')

/**
 * Scales an image down to at most CONTEXT_LIMITS.imageEdge on its longest side, as the providers do anyway, so it
 * costs fewer tokens and stays under every provider's size limit. Photos stay JPEG; everything else becomes PNG
 * (an animated GIF keeps its first frame). A small PNG or JPEG is kept as it is.
 */
async function scaleImage(f: File): Promise<Uint8Array> {
	const bitmap = await createImageBitmap(f)
	try {
		const scale = Math.min(1, CONTEXT_LIMITS.imageEdge / Math.max(bitmap.width, bitmap.height))
		if (scale === 1 && (f.type === 'image/png' || f.type === 'image/jpeg') && f.size <= CONTEXT_LIMITS.imageBytes)
			return new Uint8Array(await f.arrayBuffer())
		const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)))
		canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
		let blob = await canvas.convertToBlob({ type: f.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', quality: 0.9 })
		// A detailed PNG can stay large even when scaled; JPEG always fits.
		if (blob.size > CONTEXT_LIMITS.imageBytes) blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
		return new Uint8Array(await blob.arrayBuffer())
	} finally {
		bitmap.close()
	}
}

/** Reads dropped, picked or pasted files: text files as text, images scaled and stored; anything else is refused with a reason. */
async function readFiles(list: Array<File>, room: { files: number; images: number }): Promise<Read> {
	const out: Read = { files: [], images: [], problems: [] }
	for (const f of list) {
		const name = f.name || 'pasted image.png'
		if (isImage(f)) {
			if (out.images.length >= room.images) {
				out.problems.push(`${name}: a review holds at most ${CONTEXT_LIMITS.images} images.`)
				continue
			}
			try {
				const r = await window.review.addContextImage(name, await scaleImage(f))
				if (r.ok) out.images.push(r.value)
				else out.problems.push(`${name}: ${r.error.message}`)
			} catch {
				out.problems.push(`${name}: this image could not be read.`)
			}
			continue
		}
		if (out.files.length >= room.files) {
			out.problems.push(`${name}: a review holds at most ${CONTEXT_LIMITS.files} files.`)
			continue
		}
		if (f.size > CONTEXT_LIMITS.fileBytes) {
			out.problems.push(`${name}: too large (${Math.round(f.size / 1024)} KB; the limit is ${CONTEXT_LIMITS.fileBytes / 1000} KB).`)
			continue
		}
		const text = await f.text()
		if (text.includes('\u0000')) out.problems.push(`${name}: not a text file or an image.`)
		else if (text.length > CONTEXT_LIMITS.fileChars)
			out.problems.push(`${name}: more than ${CONTEXT_LIMITS.fileChars.toLocaleString()} characters.`)
		else if (!text.trim()) out.problems.push(`${name}: empty.`)
		else out.files.push({ name, text })
	}
	return out
}

/** A stored image's thumbnail, read once per id. */
function Thumb({ image }: { image: ContextImage }) {
	const [src, setSrc] = useState<string | null>(null)
	const [missing, setMissing] = useState(false)
	useEffect(() => {
		let live = true
		void window.review.contextImage(image.id, image.mediaType).then((r) => {
			if (!live) return
			if (r.ok) setSrc(r.value)
			else setMissing(true)
		})
		return () => {
			live = false
		}
	}, [image.id, image.mediaType])
	return src ? <img src={src} alt={image.name} /> : <span className="muted small">{missing ? 'Missing' : '…'}</span>
}

export function ContextPanel({ context, isPr, onNotes, onAddFiles, onRemoveFile, onAddImages, onRemoveImage }: Props) {
	const picker = useRef<HTMLInputElement>(null)
	const [problems, setProblems] = useState<Array<string>>([])
	const [dragging, setDragging] = useState(false)
	const [adding, setAdding] = useState(false)
	const files = context?.files ?? []
	const images = context?.images ?? []
	const notes = context?.notes ?? ''
	const total = notes.trim().length + files.reduce((n, f) => n + f.text.length, 0)
	const full = files.length >= CONTEXT_LIMITS.files && images.length >= CONTEXT_LIMITS.images

	const add = async (list: Array<File>): Promise<void> => {
		if (!list.length) return
		setAdding(true)
		try {
			const r = await readFiles(list, { files: CONTEXT_LIMITS.files - files.length, images: CONTEXT_LIMITS.images - images.length })
			setProblems(r.problems)
			if (r.files.length) onAddFiles(r.files)
			if (r.images.length) onAddImages(r.images)
		} finally {
			setAdding(false)
		}
	}

	return (
		<div
			className={`context-panel${dragging ? ' dragging' : ''}`}
			onDragOver={(e) => {
				if (![...e.dataTransfer.types].includes('Files')) return
				e.preventDefault()
				setDragging(true)
			}}
			onDragLeave={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
			}}
			onDrop={(e) => {
				e.preventDefault()
				setDragging(false)
				void add([...e.dataTransfer.files])
			}}
			onPaste={(e) => {
				// A pasted screenshot becomes an image; pasted text goes into the notes as usual.
				const pasted = [...e.clipboardData.files].filter(isImage)
				if (!pasted.length) return
				e.preventDefault()
				void add(pasted)
			}}
		>
			<p className="muted small">
				What the code can't tell the AI reviewer: requirements, a spec, logs, screenshots, where to look. Sent with every request of the
				next run and kept for newer snapshots of this {isPr ? 'pull request' : 'branch'}.
			</p>
			<label className="context-label" htmlFor="context-notes">
				Notes
			</label>
			<textarea
				id="context-notes"
				className="context-notes"
				value={notes}
				maxLength={CONTEXT_LIMITS.notes}
				placeholder="e.g. This must keep working for customers on the old pricing plan. Pay attention to rounding."
				onChange={(e) => onNotes(e.target.value)}
			/>
			<div className="context-files-head">
				<span className="context-label">Files and images</span>
				{adding && <span className="spinner small" aria-label="Adding" />}
				<button className="btn small" disabled={full || adding} onClick={() => picker.current?.click()}>
					Add…
				</button>
				<input
					ref={picker}
					type="file"
					multiple
					hidden
					onChange={(e) => {
						void add([...(e.target.files ?? [])])
						e.target.value = ''
					}}
				/>
			</div>
			{images.length > 0 && (
				<ul className="context-images" aria-label="Images">
					{images.map((i) => (
						<li key={i.id} title={`${i.name} · ${Math.round(i.bytes / 1000)} KB`}>
							<Thumb image={i} />
							<button className="context-file-remove" aria-label={`Remove ${i.name}`} title="Remove" onClick={() => onRemoveImage(i.id)}>
								×
							</button>
						</li>
					))}
				</ul>
			)}
			{files.length > 0 && (
				<ul className="context-files">
					{files.map((f) => (
						<li key={f.id}>
							<span className="ellipsis" title={f.name}>
								{f.name}
							</span>
							<span className="muted small nowrap">{f.text.length.toLocaleString()} chars</span>
							<button className="context-file-remove" aria-label={`Remove ${f.name}`} title="Remove" onClick={() => onRemoveFile(f.id)}>
								×
							</button>
						</li>
					))}
				</ul>
			)}
			{!files.length && !images.length && (
				<div className="context-drop muted small">Drop or paste screenshots and text files here (Markdown, logs, specs, JSON…).</div>
			)}
			{problems.map((p, i) => (
				<div key={i} className="warn-text small">
					{p}
				</div>
			))}
			{(files.length > 0 || images.length > 0) && (
				<div className="muted small">
					{files.length} of {CONTEXT_LIMITS.files} files, {images.length} of {CONTEXT_LIMITS.images} images.
				</div>
			)}
			{total > CONTEXT_LIMITS.sent && (
				<div className="warn-text small">
					{total.toLocaleString()} characters of text; each request sends up to {CONTEXT_LIMITS.sent.toLocaleString()}: the notes first,
					then the files share the rest, and what's cut is marked.
				</div>
			)}
			{images.length > 0 && (
				<div className="muted small">
					Each image costs roughly 1,000–3,000 tokens per request. Models that don't accept images get the request without them, and the run
					says so.
				</div>
			)}
		</div>
	)
}
