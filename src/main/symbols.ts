import { grepCommit } from './git.ts'
import { IDENT, type Side, type SymbolHit, type SymbolKind, type SymbolLookup } from '../shared/types.ts'

/**
 * Names in code, found by text: the definition patterns and `git grep` on one commit (the object database, never the
 * working tree). Shared by the AI reviewer's related code and go to definition / find uses in the diff. A match can be
 * a different thing with the same name. The patterns cover the common definition forms of JS/TS, Python, Go, Rust,
 * Java, Kotlin, C#, PHP and Ruby; anything they miss simply isn't found.
 */
export { IDENT }
// An import names a thing without using it, so it tells the reviewer nothing about how it is called.
export const IMPORT =
	/^\s*(import\b|export\s*\{|export\s+\*|from\s+\S+\s+import\b|use\s|using\s|require\b|#include\b|[\w{},\s]+=\s*require\()/

// Each pattern captures the defined name in group 1.
const DEFINITIONS: Array<RegExp> = [
	// function / def / fn / func (with a Go receiver) / fun / class / interface / trait / struct / enum / type / record…
	/\b(?:function\*?|def|fn|func|fun|sub|class|interface|trait|struct|enum|type|record|module|protocol|object|impl)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/,
	// const foo = (…) => / = async function / = x =>
	/\b(?:const|let|var|val)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
	// methods: name(args) {  — with optional modifiers, generics and a return type. Not a call in a Go or Rust
	// condition (`if ok(x) {`), whose keyword would otherwise read as a return type.
	/^\s*(?:(?:public|private|protected|internal|static|async|override|abstract|final|virtual|export|default|readonly|open|suspend|synchronized|get|set)\s+)*(?:(?!(?:if|for|while|switch|match|return|else|when|guard|unless|until|elif|case|new|await|throw|yield|go|defer|select|loop)\s)[\w$<>[\],.?]+\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\([^;]*\)\s*(?::\s*[^{;=]+|->\s*[^{;]+|throws\s+[^{;]+)?\s*\{\s*$/,
	// a method whose parameters continue on the next lines: `async name(`, with at least one modifier, so a bare
	// multi-line call isn't one
	/^\s*(?:(?:public|private|protected|internal|static|async|override|abstract|final|virtual|readonly|open|suspend|synchronized|get|set)\s+)+([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(\s*$/,
	// class fields: name = (…) => / private name = async function
	/^\s*(?:(?:public|private|protected|static|readonly|override)\s+)*([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
]

// A line that is a comment: `// the function foo` or ` * class Foo` names a thing without defining it.
const COMMENT = /^\s*(?:\/\/|\/\*|\*|#(?!include|define|if|else|endif|pragma)|--|<!--|"""|''')/

export const NOT_NAMES = new Set(
	`if else for while do switch case catch try finally return throw new delete typeof instanceof in of with yield await async
	function def fn func fun class interface struct enum type const let var val import export from default extends implements
	super this self cls true false null nil none undefined void static public private protected get set constructor init
	print println printf len str int float bool list dict map filter reduce push pop shift then catch finally resolve reject
	console log warn error info debug require module exports string number boolean object array promise date json math
	String Number Boolean Object Array Promise Map Set WeakMap Error Date JSON Math RegExp Symbol React Fragment useState
	useEffect useMemo useCallback useRef describe it test expect assert should beforeEach afterEach toBe toEqual equal`.split(/\s+/),
)

/** The name a line defines, or null. */
export function definedName(text: string): string | null {
	if (COMMENT.test(text)) return null
	for (const re of DEFINITIONS) {
		const m = re.exec(text)
		if (m && !NOT_NAMES.has(m[1])) return m[1]
	}
	return null
}

export const SKIP_DIRS =
	/(^|\/)(node_modules|vendor|bower_components|dist|build|out|coverage|target|\.next|\.nuxt|__pycache__|\.venv|venv)\//
const SKIP_FILES =
	/(\.min\.(js|css)|\.map|\.snap|\.svg|\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|go\.sum)$/

// Only source files count as definitions or uses; a name in a README, a manifest or config is prose, not a caller.
const CODE =
	/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|py|pyi|rb|go|rs|java|kt|kts|scala|groovy|cs|fs|vb|php|swift|m|mm|c|h|cc|cpp|cxx|hpp|hh|dart|ex|exs|erl|hrl|hs|clj|cljs|lua|pl|pm|r|jl|sh|bash|zsh|ps1|sql)$/i

/** Not a source file, or vendored, built or generated. */
export function skipPath(p: string): boolean {
	return !CODE.test(p) || SKIP_DIRS.test(p) || SKIP_FILES.test(p)
}

const LOOKUP_GREP_LIMIT = 8 * 1024 * 1024
export const MAX_SYMBOL_HITS: Record<SymbolKind, number> = { definition: 50, uses: 300 }

/**
 * Where `name` is defined, or used, at one commit. `fileKey` and `inDiff` are left empty; the caller knows what changed.
 * Lines over 400 characters (minified or generated) and files `skipPath` rejects are left out.
 */
export async function findSymbol(root: string, sha: string, name: string, side: Side, kind: SymbolKind): Promise<SymbolLookup> {
	const r = await grepCommit(root, sha, [name], { word: true, maxBytes: LOOKUP_GREP_LIMIT, timeoutMs: 30_000 })
	if (r.failed) throw new Error(`git grep failed: ${r.failed}`)
	const all: Array<SymbolHit> = r.hits
		.filter((h) => !skipPath(h.path) && h.text.length <= 400)
		.filter((h) => (kind === 'definition' ? definedName(h.text) === name : definedName(h.text) !== name && !IMPORT.test(h.text)))
		.map((h) => ({ ...h, text: h.text.trim(), fileKey: null, inDiff: false }))
	const max = MAX_SYMBOL_HITS[kind]
	return { name, side, kind, hits: all.slice(0, max), truncated: r.truncated || all.length > max }
}
