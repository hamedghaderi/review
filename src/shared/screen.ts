import type { Finding } from './types.ts'

/**
 * What in a finding's text a person should read before it is posted. The text is the model's, and the model read
 * pull request text that anyone can write, so a reply can steer it into posting a link, pinging people or asking
 * readers for a password. Automatic review never posts a finding with a reason here (it stays in the app), and the
 * card shows the reasons. These are signs, not proof: a finding that trips one may be fine, and one that trips none
 * is still the model's word.
 */
export function screenFinding(
	f: Pick<Finding, 'title' | 'evidence' | 'anchor' | 'body' | 'disproof' | 'background' | 'problem' | 'consequence' | 'suggestion'>,
	repo: string | null,
): Array<string> {
	const raw = [f.title, f.body ?? [f.problem, f.consequence, f.suggestion].filter(Boolean).join('\n'), f.disproof, f.background]
		.filter(Boolean)
		.join('\n')
	// Code isn't rendered as links, mentions or HTML on GitHub, so those checks skip it.
	const prose = raw.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ')
	const out: Array<string> = []
	const home = repo ? `https://github.com/${repo.toLowerCase()}/` : null
	const links = [...prose.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>()\]]+/gi)].map((m) => m[0])
	const targets = [...prose.matchAll(/\]\(\s*<?([^)\s>]*)/g)].map((m) => m[1])
	if ([...links, ...targets].some((u) => !home || !u.toLowerCase().startsWith(home))) out.push('a link outside this repository')
	if (/!\[[^\]]*\]\(/.test(prose)) out.push('an image')
	if (/<\s*(img|a|iframe|script|svg|video|audio|picture|source|object|embed|form|input|link|meta|style)\b/i.test(prose))
		out.push('HTML that loads or links to something')
	const mention = /(^|[^\w`.@/-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?![\w-])/.exec(prose)
	if (mention) out.push(`an @mention (@${mention[2]})`)
	if (
		/\b(send|share|paste|e-?mail|dm|give|provide|enter|reply with|reveal|tell)\b[^.\n]{0,60}\b(passwords?|passphrases?|passcodes?|api[ _-]?keys?|tokens?|secrets?|credentials?|private keys?|ssh keys?|2fa|otp|one-time codes?|recovery codes?|seed phrases?|cookies?)\b/i.test(
			raw,
		)
	)
		out.push('a request for a password, token or other secret')
	if (/\|\s*(ba|z)?sh\b|\bsudo\s|\b(curl|wget)\s+(-\S+\s+)*https?:/i.test(raw)) out.push('a command to download or run something')
	if (
		/\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(instructions|prompt|rules|above)\b|\bsystem prompt\b|\bas an (ai|assistant|llm|language model)\b/i.test(
			raw,
		)
	)
		out.push('text about the AI’s own instructions')
	if (!aboutTheCode(f, raw)) out.push('nothing that names the code it cites')
	return out
}

const KEYWORDS = new Set(
	'return const let var function func def class new this self true false null nil none undefined import from export public private protected static void int string bool boolean async await else elif for while switch case break continue try catch finally throw raise and not with yield type interface enum struct impl package'.split(
		' ',
	),
)

/** The text names something from the cited lines (an identifier of three or more characters) or the file. */
function aboutTheCode(f: Pick<Finding, 'evidence' | 'anchor'>, text: string): boolean {
	const lower = text.toLowerCase()
	const path = (f.anchor.side === 'old' ? f.anchor.oldPath : f.anchor.newPath) ?? f.anchor.newPath ?? f.anchor.oldPath ?? ''
	const file = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
	if (file && lower.includes(file)) return true
	const names = [...new Set(((f.evidence ?? '').match(/[A-Za-z_$][\w$]{2,}/g) ?? []).map((n) => n.toLowerCase()))].filter(
		(n) => !KEYWORDS.has(n),
	)
	// Nothing to name (only punctuation and keywords): don't hold it back for that.
	return !names.length || names.some((n) => lower.includes(n))
}
