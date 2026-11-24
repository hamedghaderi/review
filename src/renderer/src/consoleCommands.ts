import { FINDING_LEVELS, type FindingLevel, type ReviewEvent } from '../../shared/types.ts'

/**
 * The Console's commands (issue #299). Every one is a Review action: nothing here runs a shell or the code under review.
 * Commands that change something on GitHub open the dialog their button opens, filled in, and go no further.
 */
export type Command =
	| { name: 'help' }
	| { name: 'clear' }
	| { name: 'review'; scope: 'all' | 'changed' }
	| { name: 'stop' }
	| { name: 'findings'; filter: 'open' | 'all' | FindingLevel }
	| { name: 'runs' }
	| { name: 'conclude' }
	| { name: 'ask'; question: string }
	| { name: 'open'; path: string; line: number | null }
	| { name: 'submit'; event: ReviewEvent | null }
	| { name: 'resolve' }

export interface CommandHelp {
	name: string
	usage: string
	about: string
	ai?: boolean // sends a request to a model
}

export const COMMANDS: ReadonlyArray<CommandHelp> = [
	{
		name: 'review',
		usage: 'review [changed]',
		about: 'Start the AI review of every file, or only the files changed since the last run',
		ai: true,
	},
	{ name: 'findings', usage: 'findings [all | blocking | should_fix | …]', about: 'List the newest run’s findings; open ones by default' },
	{ name: 'runs', usage: 'runs', about: 'List this review’s AI runs' },
	{ name: 'ask', usage: 'ask <question>', about: 'Ask about the change, in the conversation under the conclusion', ai: true },
	{ name: 'conclude', usage: 'conclude', about: 'Write the conclusion on the change from the newest run', ai: true },
	{ name: 'open', usage: 'open <path>[:line]', about: 'Open a file, at a line' },
	{ name: 'stop', usage: 'stop', about: 'Stop the running AI review' },
	{ name: 'approve', usage: 'approve', about: 'Open the submit dialog, set to Approve' },
	{ name: 'request-changes', usage: 'request-changes', about: 'Open the submit dialog, set to Request changes' },
	{ name: 'comment', usage: 'comment', about: 'Open the submit dialog, set to Comment' },
	{ name: 'submit', usage: 'submit', about: 'Open the submit dialog' },
	{ name: 'resolve', usage: 'resolve', about: 'Open the list of your threads the newest run found fixed' },
	{ name: 'clear', usage: 'clear', about: 'Clear the console' },
	{ name: 'help', usage: 'help', about: 'List the commands' },
]

const ALIASES: Record<string, string> = { rerun: 'review', cancel: 'stop', publish: 'submit', reject: 'request-changes', '?': 'help' }

/** The command a line asks for, an error saying why it is not one, or null for an empty line. */
export function parseCommand(line: string): { ok: true; command: Command } | { ok: false; error: string } | null {
	const text = line.trim()
	if (!text) return null
	const space = text.search(/\s/)
	const word = (space < 0 ? text : text.slice(0, space)).toLowerCase()
	const rest = space < 0 ? '' : text.slice(space).trim()
	const name = ALIASES[word] ?? word
	const arg = rest.replace(/^-+/, '').toLowerCase()
	const ok = (command: Command) => ({ ok: true as const, command })
	const no = (error: string) => ({ ok: false as const, error })
	switch (name) {
		case 'help':
		case 'clear':
		case 'stop':
		case 'runs':
		case 'conclude':
		case 'resolve':
			return rest ? no(`“${name}” takes nothing after it.`) : ok({ name })
		case 'review':
			if (!arg || arg === 'all') return ok({ name, scope: 'all' })
			if (arg === 'changed') return ok({ name, scope: 'changed' })
			return no('“review” takes “changed” or nothing.')
		case 'findings': {
			if (!arg || arg === 'open') return ok({ name, filter: 'open' })
			if (arg === 'all') return ok({ name, filter: 'all' })
			const level = arg.replace(/-/g, '_')
			if ((FINDING_LEVELS as ReadonlyArray<string>).includes(level)) return ok({ name, filter: level as FindingLevel })
			return no(`“findings” takes all, open or a level: ${FINDING_LEVELS.join(', ')}.`)
		}
		case 'ask': {
			const question = rest.replace(/^["“'](.*)["”']$/s, '$1').trim()
			return question ? ok({ name, question }) : no('Ask what? Type the question after “ask”.')
		}
		case 'open': {
			const m = /^(.+?)(?::(\d+)|\s+(\d+))?$/.exec(rest)
			if (!m) return no('Open what? Type a path after “open”, with :line if you like.')
			const n = m[2] ?? m[3]
			return ok({ name, path: m[1].trim(), line: n ? Number(n) : null })
		}
		case 'approve':
			return rest ? no('“approve” takes nothing after it.') : ok({ name: 'submit', event: 'APPROVE' })
		case 'request-changes':
			return rest ? no('“request-changes” takes nothing after it.') : ok({ name: 'submit', event: 'REQUEST_CHANGES' })
		case 'comment':
			return rest ? no('“comment” takes nothing after it.') : ok({ name: 'submit', event: 'COMMENT' })
		case 'submit':
			return rest ? no('“submit” takes nothing after it.') : ok({ name: 'submit', event: null })
		default:
			return no(
				looksLikeShell(text)
					? `No command “${word}”. This console is not a shell: Review never runs commands on your machine. “help” lists what it can do.`
					: `No command “${word}”.`,
			)
	}
}

// Words people type into a terminal out of habit. Sent on as a question they would cost a request and answer nothing.
const SHELL_WORDS = new Set(
	'ls cd pwd cat less head tail grep rg find git gh npm npx pnpm yarn node python python3 pip make docker kubectl curl wget rm mv cp mkdir touch echo sudo ssh vim nano code open brew cargo go java tsc jest vitest'.split(
		' ',
	),
)

/** A line that reads as a shell command rather than a question: a known command word, flags, pipes or redirects. */
export function looksLikeShell(text: string): boolean {
	const t = text.trim()
	if (t.endsWith('?')) return false // a question, even one about a command
	const first = t.split(/\s+/)[0]
	if (SHELL_WORDS.has(first)) return true
	if (/[|;]|&&|\$\(|(^|\s)>{1,2}\s/.test(t)) return true // pipes, chains, substitution, redirects
	return /(^|\s)--?[a-z]/i.test(t) && /^[a-z0-9._/-]+$/.test(first) // a lowercase word with flags: "deploy --prod"
}

/**
 * What Enter would run, shown in grey after what you typed. A command keeps what you typed; one word that starts a
 * command completes it; a shell command is answered that this is not a shell; anything else becomes a question about the
 * change, which says which model it goes to. Enter runs the suggestion, so nothing is sent to a model without it being on
 * screen first.
 */
export function suggest(line: string, askModel: string | null): { run: string; hint: string; ai: boolean } | null {
	const text = line.trim()
	if (!text) return null
	const parsed = parseCommand(text)
	if (parsed?.ok) {
		const help = COMMANDS.find((c) => c.name === commandName(parsed.command, text))
		return { run: text, hint: aiHint(help, askModel) ?? help?.about ?? '', ai: !!help?.ai }
	}
	const word = text.toLowerCase()
	if (!/\s/.test(text)) {
		const match = COMMANDS.find((c) => c.name.startsWith(word)) ?? COMMANDS.find((c) => c.name.includes(word))
		if (match && parseCommand(match.name)?.ok) return { run: match.name, hint: aiHint(match, askModel) ?? match.about, ai: !!match.ai }
		if (match) return { run: `${match.name} `, hint: match.usage, ai: false }
	}
	// A known command with the wrong arguments says so rather than becoming a question, and so does a shell command.
	if (parsed && !parsed.ok && !parsed.error.startsWith('No command')) return { run: text, hint: parsed.error, ai: false }
	if (looksLikeShell(text)) return { run: text, hint: 'Not a shell: Review never runs commands. “help” lists what it can do', ai: false }
	return { run: `ask ${text}`, hint: askHint(askModel), ai: true }
}

function commandName(c: Command, text: string): string {
	if (c.name !== 'submit') return c.name
	const w = text.trim().split(/\s/)[0].toLowerCase()
	return ALIASES[w] ?? w
}

function askHint(model: string | null): string {
	return model ? `Asks ${model} about the change · one request` : 'Choose a model for questions first'
}

function aiHint(help: CommandHelp | undefined, model: string | null): string | null {
	if (help?.name === 'ask') return askHint(model)
	if (help?.name === 'conclude') return model ? `${help.about} · asks ${model}, one request` : 'Choose a model for questions first'
	return null
}
