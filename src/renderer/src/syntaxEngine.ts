import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages, bundledLanguagesInfo } from 'shiki/langs'
import { KIND_THEME, kindOf, languageFor, type LineTokens } from './syntax.ts'

/**
 * Shiki, for the syntax worker (issue #237). Kept apart from syntax.ts so the app's own bundle doesn't carry Shiki and
 * its grammars; only the worker loads them, each grammar the first time a file needs it.
 */

const NAMES = new Map<string, string>()
for (const l of bundledLanguagesInfo) {
	NAMES.set(l.id, l.id)
	for (const a of l.aliases ?? []) NAMES.set(a, l.id)
}

/** A Shiki grammar's id from its name or one of its aliases. */
export const knownLanguage = (name: string): string | undefined => NAMES.get(name)

// Past these, code is left plain: generated files and minified lines aren't worth the time or the page's size.
export const LIMITS = { chars: 1_000_000, lineLength: 2_000 }
const CHUNK = 400 // lines tokenized between pauses, so a newer request needn't wait for a whole large file

let highlighter: Promise<HighlighterCore> | null = null
const loaded = new Map<string, Promise<boolean>>()

// The JavaScript engine, not Oniguruma's WebAssembly, which the page's content security policy doesn't allow. A
// grammar pattern it can't run is skipped rather than failing the whole file.
const start = (): Promise<HighlighterCore> =>
	(highlighter ??= createHighlighterCore({
		themes: [KIND_THEME],
		langs: [],
		engine: createJavaScriptRegexEngine({ forgiving: true }),
	}))

async function load(h: HighlighterCore, lang: string): Promise<boolean> {
	let p = loaded.get(lang)
	if (!p) {
		const grammar = bundledLanguages[lang as keyof typeof bundledLanguages]
		p = grammar
			? h.loadLanguage(grammar).then(
					() => true,
					() => false,
				)
			: Promise.resolve(false)
		loaded.set(lang, p)
	}
	return p
}

/**
 * Each line's tokens, read as the file at `path` is (by its name), or null to leave it plain: no grammar for it, too
 * big, or `pause` (awaited between chunks of lines) returned false because the answer is no longer wanted.
 */
export async function tokenize(path: string, lines: Array<string>, pause?: () => Promise<boolean>): Promise<Array<LineTokens> | null> {
	const lang = languageFor(path, knownLanguage)
	if (!lang || lines.reduce((n, l) => n + l.length + 1, 0) > LIMITS.chars) return null
	const h = await start()
	if (!(await load(h, lang))) return null
	const out: Array<LineTokens> = []
	let grammarState: ReturnType<HighlighterCore['getLastGrammarState']> | undefined
	for (let i = 0; i < lines.length; i += CHUNK) {
		const chunk = lines.slice(i, i + CHUNK)
		const r = h.codeToTokens(chunk.join('\n'), {
			lang,
			theme: KIND_THEME.name,
			grammarState,
			tokenizeMaxLineLength: LIMITS.lineLength,
		})
		grammarState = r.grammarState
		for (let j = 0; j < chunk.length; j++) out.push((r.tokens[j] ?? []).flatMap((t) => [t.content.length, kindOf(t.color)]))
		if (pause && !(await pause())) return null
	}
	return out
}
