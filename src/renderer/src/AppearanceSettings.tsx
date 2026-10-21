import { useEffect, useRef, useState } from 'react'
import { APPEARANCES, CODE_FONTS, CODE_SIZES, THEMES, UI_FONTS, UI_SCALES, fontStack } from '../../shared/theme.ts'
import { useTheme } from './theme.ts'

const CODE_SIZE_OPTIONS = Array.from({ length: CODE_SIZES.max - CODE_SIZES.min + 1 }, (_, i) => CODE_SIZES.min + i)

/**
 * Settings · Appearance: light or dark (or follow the system), fonts and sizes, and the colour theme, each previewed
 * in its own colours.
 */
export function AppearanceSettings() {
	const [theme, setTheme] = useTheme()
	if (!theme) return null
	return (
		<div className="form appearance">
			<h3>Appearance</h3>
			<div className="seg" role="radiogroup" aria-label="Light or dark">
				{APPEARANCES.map((a) => (
					<button
						key={a.id}
						role="radio"
						aria-checked={theme.appearance === a.id}
						className={theme.appearance === a.id ? 'on' : ''}
						onClick={() => setTheme({ appearance: a.id })}
					>
						{a.label}
					</button>
				))}
			</div>
			<h3>Text</h3>
			<div className="font-grid">
				<FontField
					label="Code font"
					value={theme.codeFont}
					options={CODE_FONTS}
					defaultLabel="Default (SF Mono, Menlo, Consolas)"
					onCommit={(codeFont) => setTheme({ codeFont })}
				/>
				<label className="field">
					<span>Code size</span>
					<select value={theme.codeSize} onChange={(e) => setTheme({ codeSize: Number(e.target.value) })}>
						{CODE_SIZE_OPTIONS.map((n) => (
							<option key={n} value={n}>
								{n} px{n === 12 ? ' (default)' : ''}
							</option>
						))}
					</select>
				</label>
				<FontField
					label="Interface font"
					value={theme.uiFont}
					options={UI_FONTS}
					defaultLabel="Default (system font)"
					onCommit={(uiFont) => setTheme({ uiFont })}
				/>
				<label className="field">
					<span>Interface size</span>
					<select value={theme.uiScale} onChange={(e) => setTheme({ uiScale: Number(e.target.value) })}>
						{UI_SCALES.map((n) => (
							<option key={n} value={n}>
								{n}%{n === 100 ? ' (default)' : ''}
							</option>
						))}
					</select>
				</label>
			</div>
			<pre
				className="font-sample"
				style={{ fontFamily: fontStack(theme.codeFont, 'var(--mono-default)'), fontSize: theme.codeSize }}
				aria-label="Code font sample"
			>
				{'const ok = items.filter((x) => x.id !== 0) // 0O 1lI {}[]'}
			</pre>
			<p className="muted small">
				Choose Other… to type any font installed on this computer; one that isn’t installed falls back to the default. The interface size is
				the same as View › Zoom (⌘+ and ⌘−).
			</p>
			<h3>Theme</h3>
			<div className="theme-grid" role="radiogroup" aria-label="Colour theme">
				{THEMES.map((t) => (
					<button
						key={t.id}
						role="radio"
						aria-checked={theme.theme === t.id}
						className={`theme-card${theme.theme === t.id ? ' on' : ''}`}
						onClick={() => setTheme({ theme: t.id })}
					>
						<span className="theme-preview" data-theme={t.id} aria-hidden="true">
							<span className="theme-line del">- return null</span>
							<span className="theme-line add">+ return theme</span>
							<span className="theme-chip">Publish</span>
						</span>
						<span className="theme-name">{t.label}</span>
						<span className="muted small">{t.description}</span>
					</button>
				))}
			</div>
			<p className="muted small">Also in View › Theme, and in ⌘P: type “theme” or “dark”.</p>
		</div>
	)
}

const OTHER = '\u0000other' // the "Other…" choice; can't clash with a font name, which never has control characters

/**
 * A font: the default, one of the suggestions, or "Other…" to type any installed font, which is saved once you stop
 * typing so the app doesn't re-render on every letter.
 */
function FontField(props: {
	label: string
	value: string
	options: ReadonlyArray<string>
	defaultLabel: string
	onCommit(value: string): void
}) {
	const { value, onCommit } = props
	const [other, setOther] = useState(() => value !== '' && !props.options.includes(value))
	const [text, setText] = useState(other ? value : '')
	const input = useRef<HTMLInputElement>(null)
	useEffect(() => {
		if (!other || text.trim() === value) return
		const t = window.setTimeout(() => onCommit(text.trim()), 400)
		return () => window.clearTimeout(t)
	}, [other, text, value, onCommit])
	return (
		<div className="field font-field">
			<label className="field">
				<span>{props.label}</span>
				<select
					value={other ? OTHER : value}
					onChange={(e) => {
						if (e.target.value === OTHER) {
							setOther(true)
							window.setTimeout(() => input.current?.focus())
							return
						}
						setOther(false)
						setText('')
						onCommit(e.target.value)
					}}
				>
					<option value="">{props.defaultLabel}</option>
					{props.options.map((f) => (
						<option key={f} value={f}>
							{f}
						</option>
					))}
					<option value={OTHER}>Other…</option>
				</select>
			</label>
			{other && (
				<input
					ref={input}
					value={text}
					placeholder="Font name, as installed"
					aria-label={`${props.label} name`}
					spellCheck={false}
					onChange={(e) => setText(e.target.value)}
				/>
			)}
		</div>
	)
}
