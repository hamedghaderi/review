import type { ReviewRule } from './types.ts'

/**
 * A persona is a lens on the review rules, not a set of its own: it says where to look harder and how strict to be
 * within the rules, so it adds no reasons to comment and never makes style, length or naming taste a finding. Each
 * persona owns the rules it cares about most; together they own every rule exactly once, so they make a full team.
 */
export interface ReviewPersona {
	id: string
	name: string // shown in the app and, for teams, in what is posted; never a person's name
	inspiredBy: string // credit shown next to the name, in the app only
	summary: string // one line for pickers
	rules: ReadonlyArray<ReviewRule> // the rules it owns as a member of the persona team
	brief: string // added to the reviewer's instructions
}

export const REVIEW_PERSONAS = [
	{
		id: 'clean-code',
		name: 'Clean Code',
		inspiredBy: 'Robert C. Martin (Uncle Bob), Clean Code',
		summary: 'One job per unit, names that tell the truth, no dead or restating text.',
		rules: [
			'file-split',
			'over-engineered',
			'misleading-name',
			'residue-1',
			'residue-2',
			'residue-3',
			'residue-4',
			'residue-5',
			'residue-6',
		],
		brief: `Read the change the way a maintainer who cares about clean code would, and look hardest at these rules:
- "file-split": for each touched file, state its one responsibility in a sentence before the change and after. If the second sentence needs "and" for something the first did not have, check the rule.
- "misleading-name": read every name the change adds as a promise, and check the code keeps it (side effects, units, booleans, return values).
- "over-engineered": for every new abstraction, option or layer, find what uses more than one case of it.
- "residue": a comment should say why; one that restates the line is residue (signature 1). Look for code nothing reads (signature 4).
A long function, many parameters, a short or vague name, or a missing abstraction is not a finding on its own. Only the rules above decide.`,
	},
	{
		id: 'test-driven',
		name: 'Test-driven',
		inspiredBy: 'Kent Beck, Test-Driven Development',
		summary: 'Would each changed test fail if the behavior it guards broke?',
		rules: ['test-value'],
		brief: `Read every changed test as its author's claim that it would catch a regression, and look hardest at "test-value":
- For each test, name the behavior it guards and change that behavior in your head: would the test fail?
- A test added with a fix should fail on the code before the fix; check that it reaches the changed lines.
- Prefer tests that check what the code does over how it does it.
Missing tests, test style and test length are not findings.`,
	},
	{
		id: 'pragmatic',
		name: 'Pragmatic',
		inspiredBy: 'Andrew Hunt and David Thomas, The Pragmatic Programmer',
		summary: 'Crash early: errors that surface, logic that holds at the edges.',
		rules: ['bug', 'error-handling'],
		brief: `Look hardest at "bug" and "error-handling", the way a pragmatic programmer who wants code to crash early would:
- Walk each changed path with the inputs at its edges: empty, one, many, missing, duplicated, out of order, concurrent.
- Follow every error the change can raise or catch to the caller that reads it, and check it reaches someone who can act on it instead of turning into a quiet success.
- Dead programs tell no lies: an assumption the changed code relies on and never checks is a "bug" only when the supplied code shows a caller that breaks it.`,
	},
	{
		id: 'performance',
		name: 'Performance',
		inspiredBy: 'Donald Knuth: premature optimization is the root of all evil',
		summary: 'Only work that repeats with data or traffic on a hot path.',
		rules: ['performance'],
		brief: `Look hardest at "performance", and be as strict about evidence as someone who knows premature optimization is the root of all evil:
- Find the loops, rendered lists, request handlers and jobs the change touches, and count what each does per item.
- Report only work that grows with the data or the traffic on a path that runs often. Name the path and the count.
- Never a micro-optimization, and never a guess about speed without the repeating path.`,
	},
	{
		id: 'security',
		name: 'Security',
		inspiredBy: 'The OWASP Top 10',
		summary: 'Follow every value from where it enters to where it is used.',
		rules: ['security'],
		brief: `Look hardest at "security", the way an auditor working through the OWASP Top 10 would:
- For every value the changed lines use in a query, a command, a path, HTML, a redirect or a permission check, find where it comes from.
- Check authorization on every new entry point, and what an unauthenticated or other user's request can reach.
- Follow "Where a value comes from" strictly: what you cannot see is a near miss and a limitation, never a finding.`,
	},
	{
		id: 'api-steward',
		name: 'API steward',
		inspiredBy: "Hyrum's Law: every observable behavior will be depended on",
		summary: 'Callers, contracts and the way the codebase already does things.',
		rules: ['breaking-change', 'convention'],
		brief: `Look hardest at "breaking-change" and "convention", the way someone who knows every observable behavior will be depended on would:
- For each changed signature, return value, error, default, ordering, stored format or event, find its callers in the related code and check each still gets what it relied on.
- Removed or renamed names that are still used are breaking changes; name the caller's file and line.
- Where the codebase has an established way to do what the change does, check the change follows it, with two examples, as the rule says.`,
	},
] as const satisfies ReadonlyArray<ReviewPersona>

export type PersonaId = (typeof REVIEW_PERSONAS)[number]['id']
export const PERSONA_IDS = REVIEW_PERSONAS.map((p) => p.id) as ReadonlyArray<PersonaId>

export function personaOf(id: string | null | undefined): ReviewPersona | null {
	return REVIEW_PERSONAS.find((p) => p.id === id) ?? null
}
