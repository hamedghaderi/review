import type { ReactNode } from 'react'

/**
 * Comment text as it is written for GitHub, shown the way GitHub shows the few forms the app itself writes: label chips
 * (`<kbd>SHOULD FIX</kbd>`), **bold**, `code` and a collapsed `<details><summary>…</summary>…</details>`. Everything else
 * stays plain text. Nothing is parsed as HTML, so text in a comment can never add markup or run anything.
 */
const DETAILS = /<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g
const INLINE = /<kbd>([^<\n]{1,80})<\/kbd>|\*\*([^*\n]{1,300})\*\*|`([^`\n]{1,300})`/g

// `flat`: for previews inside a button, a collapsed section shows only its title.
export function RichText({ text, className, flat = false }: { text: string; className?: string; flat?: boolean }) {
	const out: Array<ReactNode> = []
	let at = 0
	let k = 0
	for (const m of text.matchAll(DETAILS)) {
		out.push(...inline(text.slice(at, m.index), `t${k}`))
		out.push(
			flat ? (
				<span key={`d${k}`}>▸ {inline(m[1].trim(), `s${k}`)}</span>
			) : (
				<details key={`d${k}`}>
					<summary>{inline(m[1].trim(), `s${k}`)}</summary>
					{inline(m[2].trim(), `b${k}`)}
				</details>
			),
		)
		at = m.index + m[0].length
		k++
	}
	out.push(...inline(text.slice(at), `t${k}`))
	return <div className={`rich ${className ?? ''}`}>{out}</div>
}

function inline(s: string, key: string): Array<ReactNode> {
	const out: Array<ReactNode> = []
	let at = 0
	let i = 0
	for (const m of s.matchAll(INLINE)) {
		if (m.index > at) out.push(s.slice(at, m.index))
		const k = `${key}-${i++}`
		out.push(m[1] !== undefined ? <kbd key={k}>{m[1]}</kbd> : m[2] !== undefined ? <b key={k}>{m[2]}</b> : <code key={k}>{m[3]}</code>)
		at = m.index + m[0].length
	}
	if (at < s.length) out.push(s.slice(at))
	return out
}
