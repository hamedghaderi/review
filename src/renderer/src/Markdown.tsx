import type { ReactNode } from 'react'

/**
 * Markdown the AI wrote, shown with the GitHub look (`md-body`): headings, paragraphs, lists (nested by indent), quotes,
 * fenced code, rules, and inline code, bold, italics and web links. Nothing is parsed as HTML, so the text can never add
 * markup or run anything. A reference to one of `paths` (`src/a.ts` or `src/a.ts:12`) becomes a link that opens it.
 */
export function Markdown({ text, paths, onOpenPath }: { text: string; paths?: ReadonlySet<string>; onOpenPath?(path: string): void }) {
	const links: Links | undefined = paths && onOpenPath ? { paths, open: onOpenPath } : undefined
	return <div className="md-body selectable">{blocks(text.replace(/\r\n?/g, '\n').split('\n'), links, 'b')}</div>
}

interface Links {
	paths: ReadonlySet<string>
	open(path: string): void
}

const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/
const FENCE = /^\s*(```|~~~)/

function blocks(lines: Array<string>, links: Links | undefined, key: string): Array<ReactNode> {
	const out: Array<ReactNode> = []
	const span = (s: string, k: string) => inline(s, links, k)
	let i = 0
	while (i < lines.length) {
		const line = lines[i]
		const k = `${key}${i}`
		if (!line.trim()) {
			i++
			continue
		}
		const fence = FENCE.exec(line)
		if (fence) {
			const code: Array<string> = []
			i++
			while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++])
			i++
			out.push(
				<pre key={k}>
					<code>{code.join('\n')}</code>
				</pre>,
			)
			continue
		}
		const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line)
		if (heading) {
			const Tag = `h${Math.max(2, Math.min(4, heading[1].length))}` as 'h2' // the view has its own title, so no h1
			out.push(<Tag key={k}>{span(heading[2], k)}</Tag>)
			i++
			continue
		}
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
			out.push(<hr key={k} />)
			i++
			continue
		}
		if (/^\s*>/.test(line)) {
			const quoted: Array<string> = []
			while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ''))
			out.push(<blockquote key={k}>{blocks(quoted, links, k)}</blockquote>)
			continue
		}
		const item = LIST_ITEM.exec(line)
		if (item) {
			const indent = item[1].length
			const ordered = /\d/.test(item[2])
			const items: Array<Array<string>> = []
			while (i < lines.length) {
				const m = LIST_ITEM.exec(lines[i])
				if (m && m[1].length <= indent) {
					if (/\d/.test(m[2]) !== ordered) break
					items.push([m[3]])
					i++
					continue
				}
				// A blank line ends the list unless the next line is indented under it; an indented line belongs to the item.
				if (!lines[i].trim()) {
					const next = lines[i + 1] ?? ''
					if (!next.trim() || indentOf(next) <= indent) break
					items[items.length - 1].push('')
					i++
					continue
				}
				if (indentOf(lines[i]) <= indent) break
				items[items.length - 1].push(lines[i].slice(Math.min(indentOf(lines[i]), indent + 2)))
				i++
			}
			const List = ordered ? 'ol' : 'ul'
			out.push(
				<List key={k} start={ordered ? Number(item[2].slice(0, -1)) || 1 : undefined}>
					{items.map((body, j) => (
						<li key={j}>{body.length === 1 ? span(body[0], `${k}.${j}`) : blocks(body, links, `${k}.${j}.`)}</li>
					))}
				</List>,
			)
			continue
		}
		const para: Array<string> = []
		while (
			i < lines.length &&
			lines[i].trim() &&
			!FENCE.test(lines[i]) &&
			!/^#{1,6}\s/.test(lines[i]) &&
			!/^\s*>/.test(lines[i]) &&
			!(para.length && LIST_ITEM.test(lines[i]))
		)
			para.push(lines[i++].trim())
		out.push(<p key={k}>{span(para.join(' '), k)}</p>)
	}
	return out
}

function indentOf(line: string): number {
	return /^\s*/.exec(line)![0].length
}

const INLINE =
	/`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|(?<![\w])_([^_\n]+)_(?![\w])|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|((?:[\w.-]+\/)*[\w.-]+\.\w+(?::\d+(?:-\d+)?)?)/g

function inline(text: string, links: Links | undefined, key: string): Array<ReactNode> {
	const out: Array<ReactNode> = []
	let at = 0
	let n = 0
	for (const m of text.matchAll(INLINE)) {
		const k = `${key}-${n++}`
		const [whole, code, bold, bold2, em, em2, label, url, path] = m
		let node: ReactNode
		if (code !== undefined) node = <PathOr key={k} text={code} links={links} code />
		else if (bold !== undefined || bold2 !== undefined) node = <strong key={k}>{inline(bold ?? bold2, links, k)}</strong>
		else if (em !== undefined || em2 !== undefined) node = <em key={k}>{inline(em ?? em2, links, k)}</em>
		else if (label !== undefined)
			node = (
				<a key={k} href={url} target="_blank" rel="noreferrer">
					{label}
				</a>
			)
		else if (path !== undefined && path.includes('/')) node = <PathOr key={k} text={path} links={links} />
		else continue
		out.push(text.slice(at, m.index), node)
		at = m.index + whole.length
	}
	out.push(text.slice(at))
	return out
}

/** A reference to a changed file becomes a link that opens it; anything else shows as written. */
function PathOr({ text, links, code = false }: { text: string; links?: Links; code?: boolean }) {
	const path = text.replace(/:\d+(?:-\d+)?$/, '')
	const shown = code ? <code>{text}</code> : text
	if (!links?.paths.has(path)) return <>{shown}</>
	return (
		<button className="link md-path" title={`Open ${path}`} onClick={() => links.open(path)}>
			{shown}
		</button>
	)
}
