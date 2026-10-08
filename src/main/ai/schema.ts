import { z } from 'zod'
import { FINDING_LEVELS, REVIEW_RULES, TEST_PATTERNS } from '../../shared/types.ts'

// Runtime validation schema. Length, content and budget limits are enforced afterwards in findings.ts.
// `default` is stripped from the wire schema (strict modes reject it); it only lets validation accept answers without the field.
export const modelFindingSchema = z.object({
	excerpt_id: z.string().describe('Identifier of the supplied excerpt that contains the problem, e.g. "E3".'),
	file_path: z.string().describe('Path of the file on the chosen side, exactly as shown in the excerpt header.'),
	side: z.enum(['old', 'new']).describe('"new" for added or unchanged lines in the head version, "old" for deleted lines.'),
	start_line: z.int().describe('First line number on the chosen side (inclusive).'),
	end_line: z.int().describe('Last line number on the chosen side (inclusive).'),
	category: z
		.enum(['bug', 'security', 'error-handling', 'breaking-change', 'file-split', 'over-engineered', 'convention', 'test-value', 'residue'])
		.describe('The one rule this finding falls under.'),
	signature: z.int().nullable().describe('For category "residue": the signature number 1-6. Otherwise null.'),
	test_pattern: z
		.enum(TEST_PATTERNS)
		.nullable()
		.describe('For category "test-value": how the test fails to protect what it claims. Otherwise null.'),
	severity: z.enum(FINDING_LEVELS).describe('One of the levels the instructions allow.'),
	title: z.string().describe('Concise summary, at most about 12 words.'),
	body: z
		.string()
		.describe(
			'The comment a reviewer would post: the result someone can see first, then a plain explanation, the evidence, and one question or change.',
		),
	reasoning: z.string().describe('One sentence: why this was flagged.'),
	disproof: z
		.string()
		.nullable()
		.describe('For severity "blocking": the smallest concrete check that would prove this concern false. Otherwise null.'),
	background: z
		.string()
		.nullable()
		.describe(
			'Plain-text context (max ~80 words) only when the finding needs a domain term, code outside the excerpts, or removed behavior. Otherwise null.',
		),
	evidence: z.string().describe('Verbatim source text copied from the cited lines, without line numbers or diff markers.'),
})

export const ruleEvaluationSchema = z.object({
	rule: z.enum(REVIEW_RULES),
	near_misses: z
		.array(
			z.object({
				excerpt_id: z.string().nullable(),
				line: z.int().nullable(),
				note: z.string().describe('What you saw and did not report, in one sentence.'),
			}),
		)
		.describe('Cases you looked at under this rule and did not report. Empty if none.'),
	why: z.string().describe('One sentence: why nothing more was reported under this rule ("none observed" is fine).'),
})

export const reviewOutputSchema = z.object({
	findings: z.array(modelFindingSchema),
	evaluation: z.array(ruleEvaluationSchema).describe('Exactly one entry for every rule, in the order given, even when nothing was found.'),
	unexplained_files: z
		.array(z.object({ file_path: z.string(), why: z.string() }))
		.describe('Changed files in this request whose change you could not connect to the purpose of the change. Empty if none.'),
	limitations: z
		.array(z.string())
		.describe('Places where the supplied context was insufficient to decide whether something is a problem. Empty if none.'),
	outdated_docs: z
		.array(z.object({ doc_path: z.string(), line: z.int().nullable(), why: z.string() }))
		.default([])
		.describe('Project docs (.review/*.md) that this change makes wrong without updating them. Empty if none.'),
})

export type ModelFinding = z.infer<typeof modelFindingSchema>
export type ReviewOutput = z.input<typeof reviewOutputSchema> // outdated_docs may be missing from older or partial answers

export const SCHEMA_NAME = 'code_review_findings'

/**
 * The wire schema sent to providers: the same shape as `reviewOutputSchema`, restricted to the JSON Schema subset
 * accepted by every supported structured-output implementation (no `$schema`, no numeric bounds, every property
 * required, `additionalProperties: false`).
 */
export const REVIEW_JSON_SCHEMA: Record<string, unknown> = portable(z.toJSONSchema(reviewOutputSchema, { target: 'draft-7' }))

function portable(node: unknown): Record<string, unknown> {
	if (Array.isArray(node)) return node.map(portable) as unknown as Record<string, unknown>
	if (!node || typeof node !== 'object') return node as Record<string, unknown>
	const out: Record<string, unknown> = {}
	for (const [k, v] of Object.entries(node)) {
		if (k === '$schema' || k === 'default' || k === 'minimum' || k === 'maximum' || k === 'exclusiveMinimum' || k === 'exclusiveMaximum')
			continue
		out[k] = portable(v)
	}
	return out
}

/** The answer to a question about one finding. */
export const answerSchema = z.object({
	answer: z.string().describe('The reply to the question, in plain words, citing the code where it helps.'),
	verdict: z
		.enum(['holds', 'wrong', 'unsure'])
		.describe(
			'"holds": the finding is still right. "wrong": the question or the code shows it is not a problem. "unsure": it cannot be settled from the supplied code.',
		),
	level: z.enum(FINDING_LEVELS).nullable().describe('The level you would give the finding now, or null if it is wrong.'),
})
export type ModelAnswer = z.infer<typeof answerSchema>
export const ANSWER_SCHEMA_NAME = 'finding_answer'
export const ANSWER_JSON_SCHEMA: Record<string, unknown> = portable(z.toJSONSchema(answerSchema, { target: 'draft-7' }))

/** The double-check of one blocking finding. */
export const verifySchema = z.object({
	verdict: z
		.enum(['holds', 'wrong', 'unsure'])
		.describe('"holds": traced through the code. "wrong": the code shows it cannot happen. "unsure": the code read does not settle it.'),
	reason: z.string().describe('One to three sentences naming the files and lines that decide it.'),
	level: z.enum(FINDING_LEVELS).nullable().describe('The level you would give the finding now, or null if it is wrong.'),
	checked: z.array(z.string()).describe('Files and line ranges read to decide, like "src/cart.ts:12-30".'),
})
export type ModelVerification = z.infer<typeof verifySchema>
export const VERIFY_SCHEMA_NAME = 'finding_verification'
export const VERIFY_JSON_SCHEMA: Record<string, unknown> = portable(z.toJSONSchema(verifySchema, { target: 'draft-7' }))

/** Findings that describe the same underlying problem. */
export const mergeSchema = z.object({
	groups: z.array(
		z.object({
			findings: z.array(z.string()).describe('The ids of the findings in this group, e.g. ["F2", "F5"].'),
			primary: z.string().describe('The id of the finding that explains the problem best.'),
			reason: z.string().describe('One sentence naming the shared cause.'),
		}),
	),
})
export type ModelGroups = z.infer<typeof mergeSchema>
export const MERGE_SCHEMA_NAME = 'finding_groups'
export const MERGE_JSON_SCHEMA: Record<string, unknown> = portable(z.toJSONSchema(mergeSchema, { target: 'draft-7' }))
