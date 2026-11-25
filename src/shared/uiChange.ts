/**
 * A pull request that changes the UI and shows none of it (issue #320): its UI files, by extension and path, and whether
 * any text on it carries an image or a video. No AI. A reminder in the PR header, never a finding.
 */

// Markup, styles and server templates. A .tsx file can be pure logic; extensions are a first cut, kept until it's noisy.
const UI_FILE = /\.(tsx|jsx|vue|svelte|astro|html?|css|scss|sass|less|styl|blade\.php|erb|twig|hbs|handlebars|ejs|njk|liquid)$/i
const NOT_UI = /(^|\/)(__tests__|__snapshots__|tests?|spec|e2e|stories)\/|\.(test|spec|stories|story)\.[^/]+$/i

export function uiFiles(paths: ReadonlyArray<string>): Array<string> {
	return paths.filter((p) => UI_FILE.test(p) && !NOT_UI.test(p))
}

// Markdown or HTML images, video tags, and media pasted into GitHub (a pasted video is a bare attachment link).
// shortcut: an image inside a code block counts too; rare enough to ignore until someone sees it.
const MEDIA =
	/!\[[^\]]*\][([]|<(img|video|picture)\b|https:\/\/(github\.com\/user-attachments\/assets\/|(private-)?user-images\.githubusercontent\.com\/)/i

export function showsMedia(texts: ReadonlyArray<string | null | undefined>): boolean {
	return texts.some((t) => !!t && MEDIA.test(t))
}
