import { RISK_ORDER, type FileRisk, type RiskLevel } from '../../shared/types.ts'
import type { FileSource } from './context.ts'
import { wantedNames, type RelatedResult } from './related.ts'

/**
 * How risky each changed file is, decided by the app before any model runs, from its path and the kind of change:
 * the area it is in (auth, money, database schema, deployment), names it removes or redefines, callers of those in
 * other files, and size. It orders the review (riskiest first, so a run limit drops low-risk files) and tells the
 * reviewer where to look hardest. It is an estimate from text patterns, never evidence of a problem.
 */

// Areas where a mistake costs most. Matched against whole path segments and words in file names.
const AREAS: Array<{ re: RegExp; why: string; weight: number }> = [
	{
		re: /(^|[/_.-])(auth\w*|login|logout|sessions?|passwords?|passwd|tokens?|jwt|oauth\d?|saml|sso|permissions?|acl|rbac|roles?|polic(y|ies)|guards?|middlewares?|crypto|encrypt\w*|secrets?|credentials?|sanitiz\w*|csrf|cors|security)([/_.-]|$)/i,
		why: 'security-sensitive area',
		weight: 3,
	},
	{
		re: /(^|[/_.-])(payments?|billing|invoices?|checkout|pric(e|es|ing)|refunds?|charges?|wallets?|ledgers?|tax(es)?|subscriptions?)([/_.-]|$)/i,
		why: 'handles money',
		weight: 3,
	},
	{ re: /(^|\/)(migrations?|migrate)\/|\.sql$|(^|\/)schema\.(prisma|rb|sql|graphql)$/i, why: 'database migration or schema', weight: 3 },
	{
		re: /(^|\/)(\.github\/workflows|\.gitlab-ci|\.circleci|k8s|kubernetes|helm|terraform|deploy)(\/|\.|$)|(^|\/)(Dockerfile|docker-compose[\w.-]*|Jenkinsfile|Procfile)$|\.tf$/i,
		why: 'build or deployment configuration',
		weight: 2,
	},
]

const MANIFEST =
	/(^|\/)(package\.json|composer\.json|requirements[\w.-]*\.txt|pyproject\.toml|setup\.py|go\.mod|Cargo\.toml|Gemfile|[\w.-]+\.csproj|pom\.xml|build\.gradle(\.kts)?)$/

// Files whose mistakes rarely reach users: their own kind decides, whatever folder they are in.
const LOW_KINDS: Array<{ re: RegExp; why: string; kind: FileKind }> = [
	{
		re: /(^|\/)(node_modules|vendor|bower_components|dist|build|out|coverage|target|\.next|\.nuxt|__generated__|generated)\/|\.min\.(js|css)$|\.map$|\.snap$|\.(png|jpe?g|gif|webp|ico|icns|svg|pdf|woff2?|ttf|otf)$/i,
		why: 'generated, vendored or binary asset',
		kind: 'generated',
	},
	{
		re: /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|go\.sum)$/,
		why: 'lock file (versions are checked as dependency facts)',
		kind: 'lock',
	},
	{
		re: /(^|\/)(tests?|__tests__|specs?|fixtures?|__mocks__)\/|\.(test|spec)\.\w+$|_test\.(go|py)$|(^|\/)test_\w+\.py$|Tests?\.(php|java|kt|cs)$/,
		why: 'test file',
		kind: 'test',
	},
	{
		re: /\.(md|mdx|rst|txt|adoc)$|(^|\/)(docs?|documentation)\/|(^|\/)(LICENSE|CHANGELOG|AUTHORS)(\.\w+)?$/i,
		why: 'documentation',
		kind: 'docs',
	},
]

const CODE =
	/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|py|rb|go|rs|java|kt|kts|scala|groovy|cs|fs|vb|php|swift|m|mm|c|h|cc|cpp|cxx|hpp|hh|dart|ex|exs|erl|hs|clj|cljs|lua|pl|pm|r|jl|sh|bash|zsh|ps1|sql)$/i

export type FileKind = 'code' | 'test' | 'docs' | 'lock' | 'generated' | 'other'

/** What a file is, by its path: the low-risk kinds first, then source code, else configuration and data. */
export function fileKind(path: string): FileKind {
	return LOW_KINDS.find((k) => k.re.test(path))?.kind ?? (CODE.test(path) ? 'code' : 'other')
}

const WIDELY_USED = 5 // importers (tests not counted) that make a module shared
const LARGE = 300
const SIZEABLE = 100

export { RISK_ORDER }

export function classifyRisk(sources: Array<FileSource>, related: RelatedResult | null): Array<FileRisk> {
	const names = wantedNames(sources)
	// Callers in other files, from the related-code search: uses of names the change removes or redefines.
	const callers = new Map<string, Set<string>>()
	if (related) {
		for (const s of related.snippets) {
			if (s.priority !== 0) continue
			for (const key of s.fileKeys) {
				if (s.path === key) continue
				const set = callers.get(key) ?? new Set()
				set.add(s.path)
				callers.set(key, set)
			}
		}
	}
	return sources.map(({ file, patch }) => {
		const path = file.newPath ?? file.oldPath ?? file.key
		const low = LOW_KINDS.find((k) => k.re.test(path))
		if (low) return { fileKey: file.key, level: 'low', reasons: [low.why] }
		const reasons: Array<string> = []
		let score = CODE.test(path) ? 1 : 0
		const spaced = [path, file.oldPath].flatMap((p) => (p ? [splitCamel(p)] : []))
		for (const a of AREAS) {
			if (spaced.some((p) => a.re.test(p))) {
				score += a.weight
				reasons.push(a.why)
			}
		}
		if (MANIFEST.test(path)) {
			score += 2
			reasons.push('dependency manifest')
		}
		const removed: Array<string> = []
		const redefined: Array<string> = []
		for (const [n, d] of names.defined) {
			if (!d.fileKeys.has(file.key)) continue
			if (d.kind === 'removed') removed.push(n)
			else if (d.kind === 'signature') redefined.push(n)
		}
		if (removed.length) {
			score += 3
			reasons.push(`removes or renames ${list(removed)}`)
		}
		if (redefined.length) {
			score += 2
			reasons.push(`changes the definition of ${list(redefined)}`)
		}
		const imp = related?.importers?.find((x) => x.fileKey === file.key)
		if (imp?.stale.length) {
			score += 3
			reasons.push(`${imp.stale.length} file${imp.stale.length === 1 ? ' still imports' : 's still import'} the path it removes`)
		}
		if (imp && imp.importers.length >= WIDELY_USED) {
			score += 1
			reasons.push(`imported by ${imp.importers.length} files`)
		}
		const used = callers.get(file.key)?.size ?? 0
		if (used) {
			score += 2
			reasons.push(`${used} other file${used === 1 ? '' : 's'} use${used === 1 ? 's' : ''} what it changes`)
		}
		if (file.status === 'deleted' && CODE.test(path)) {
			score += 2
			reasons.push('deletes a source file')
		}
		const churn = patch.kind === 'text' ? (file.additions ?? 0) + (file.deletions ?? 0) : 0
		if (churn > LARGE) {
			score += 2
			reasons.push(`large change (${churn} lines)`)
		} else if (churn > SIZEABLE) {
			score += 1
			reasons.push(`${churn} changed lines`)
		}
		const level: RiskLevel = score >= 3 ? 'high' : score >= 1 ? 'medium' : 'low'
		if (!reasons.length) reasons.push(level === 'low' ? 'not source code' : 'source code')
		return { fileKey: file.key, level, reasons }
	})
}

/** The sources, riskiest first; files of equal risk keep the comparison's order. */
export function byRisk(sources: Array<FileSource>, risk: Array<FileRisk>): Array<FileSource> {
	const rank = new Map(risk.map((r) => [r.fileKey, RISK_ORDER[r.level]]))
	return sources
		.map((s, i) => ({ s, i }))
		.sort((a, b) => (rank.get(a.s.file.key) ?? 1) - (rank.get(b.s.file.key) ?? 1) || a.i - b.i)
		.map((x) => x.s)
}

/** `src/PaymentService.php` → `src/Payment-Service.php`, so area words inside camel-case names are found. */
function splitCamel(path: string): string {
	return path.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
}

function list(names: Array<string>): string {
	const shown = names.slice(0, 3).map((n) => `\`${n}\``)
	return names.length > 3 ? `${shown.join(', ')} and ${names.length - 3} more` : shown.join(', ')
}
