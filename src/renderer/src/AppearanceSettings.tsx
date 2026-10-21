import { APPEARANCES, THEMES } from '../../shared/theme.ts'
import { useTheme } from './theme.ts'

/** Settings · Appearance: light or dark (or follow the system), and the colour theme, each previewed in its own colours. */
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
						onClick={() => setTheme({ ...theme, appearance: a.id })}
					>
						{a.label}
					</button>
				))}
			</div>
			<h3>Theme</h3>
			<div className="theme-grid" role="radiogroup" aria-label="Colour theme">
				{THEMES.map((t) => (
					<button
						key={t.id}
						role="radio"
						aria-checked={theme.theme === t.id}
						className={`theme-card${theme.theme === t.id ? ' on' : ''}`}
						onClick={() => setTheme({ ...theme, theme: t.id })}
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
