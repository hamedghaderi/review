import { randomUUID } from 'node:crypto'
import {
	REVIEW_RULES,
	type AiRun,
	type AiScope,
	type AiUsage,
	type Comparison,
	type Discussion,
	type FileCoverage,
	type Finding,
	type FindingLevel,
	type ReviewRule,
	type RuleEvaluation,
	type RunMember,
	type SuppliedExcerpt,
	type FindingVerification,
	type PastDecision,
	type ReviewContext,
} from '../../shared/types.ts'
import type { LinkedIssue } from '../github.ts'
import type { RequestImage } from './provider.ts'
import type { ContextBatch, ContextLimits, ContextPackage, FileSource } from './context.ts'
import { capacityChars, CHARS_PER_TOKEN, fitToModel, packContext, prepareChange, settleFiles } from './context.ts'
import { applyBudget, findingKey, InvalidOutputError, isDuplicate, sameProblem, validateBatchOutput } from './findings.ts'
import { buildBackground } from './background.ts'
import { buildInput, DEFAULT_LEVELS, instructionsFor, withExternalTools, PROMPT_VERSION } from './prompt.ts'
import type { RelatedResult } from './related.ts'
import { classifyRisk } from './risk.ts'
import { routeFiles, unroutedReason } from './routing.ts'
import { buildEvidence, supportFor, uncoveredCi, type EvidenceIndex } from './evidence.ts'
import { buildVerifyRequest, MAX_VERIFIED, parseVerification } from './verify.ts'
import { buildMergeRequest, readGroups } from './merge.ts'
import { decisionFacts } from './decisions.ts'
import { importFacts, importSummary } from './imports.ts'
import type { FactsResult } from './facts.ts'
import {
	addLookups,
	emptyLookups,
	LOOKUPS_BY_RISK,
	LOOKUP_RESERVE,
	TOOL_DEFINITIONS,
	type ExternalTools,
	type LookupBudget,
	type ReviewTools,
} from './lookup.ts'
import { outputBudget, ProviderError, redactSecrets, type ReviewProvider } from './provider.ts'

export interface RunnerOptions {
	provider: ReviewProvider
	limits: ContextLimits
	provenance?: { connectionId: string; connectionLabel: string; endpoint: string } // stored with the run; no secrets
	concurrency: number
	maxAttempts: number // per batch, including the first try
	backoffMs: (attempt: number, error: ProviderError) => number
	/** A review team: each member checks only its rules, all members run in parallel, results merge into one run. */
	team?: { id: string; name: string; members: Array<TeamRunMember> }
	levels?: Array<FindingLevel> // the severity levels the reviewer may use (settings)
}

export interface TeamRunMember {
	id: string
	role: string
	provider: ReviewProvider
	rules: Array<ReviewRule>
	provenance: { connectionId: string; connectionLabel: string; endpoint: string }
}

/** Tokens one image is reserved, scaled to at most 1568px on its longest side (Anthropic counts up to ~3,300; OpenAI less). */
const IMAGE_TOKENS = 2500

interface Worker {
	id: string | null
	role: string | null
	provider: ReviewProvider
	rules: Array<ReviewRule>
	instructions: string
	member: RunMember | null
	stopped: boolean
	imagesRejected?: boolean // the model refused a request with images; its later requests go without them
	pkg?: ContextPackage // this reviewer's own requests, once built
	retryBatches?: Array<number> // a retry's requests to send: the ones that missed exactly this worker's rules
}

export interface RunInput {
	reviewId: string
	comparison: Comparison
	scope: AiScope
	loadSources: () => Promise<Array<FileSource>>
	/** Definitions and uses of the change's names elsewhere in the repository (skipped when the limits turn it off). */
	loadRelated?: (sources: Array<FileSource>, signal: AbortSignal) => Promise<RelatedResult>
	/** Linked issues and the conversation so far, for pull requests; the description is always included without it. */
	loadBackground?: (signal: AbortSignal) => Promise<{ issues: Array<LinkedIssue>; discussion: Discussion | null; notes: Array<string> }>
	/** Notes and text files you gave the reviewer for this review. */
	context?: ReviewContext | null
	/** The images of that context, sent with every request to models that accept them. */
	images?: Array<RequestImage>
	/** Dependency range checks and CI results, computed or read by the app. */
	loadFacts?: (sources: Array<FileSource>, signal: AbortSignal) => Promise<FactsResult>
	/** Read-only lookups in the reviewed commits, offered to the reviewer when the limits allow; one set per request. */
	tools?: (budget: LookupBudget) => ReviewTools
	/** MCP tools offered with the lookups (already part of `tools`); described in the instructions and the run's record. */
	external?: ExternalTools | null
	previousFindings: Array<Finding> // from earlier runs of the same review, used to mark repeats
	/** Findings the reviewer dismissed on earlier runs of the same pull request or branch, told to this run. */
	decisions?: Array<PastDecision>
	/**
	 * Re-asks rules of a finished run, on the requests that did not cover them, and merges the answers into that run.
	 * `providers` holds each owning reviewer's provider, by member id (null for a single-model run); `options.team` is ignored.
	 */
	retry?: { run: AiRun; rules: Array<ReviewRule>; providers: ReadonlyMap<string | null, ReviewProvider> }
}

export interface RunHandle {
	run: AiRun
	cancel: () => void
	done: Promise<AiRun>
}

export function defaultBackoff(attempt: number, error: ProviderError): number {
	return Math.min(30_000, error.retryAfterMs ?? 1000 * 2 ** attempt)
}

/**
 * Runs one AI review. `onUpdate` receives a fresh snapshot after every change; after cancellation no further
 * results are merged, and responses that arrive late are dropped.
 */
export function startRun(input: RunInput, options: RunnerOptions, onUpdate: (run: AiRun) => void): RunHandle {
	const { provider } = options
	const retry = input.retry ?? null
	const levels = retry ? levelsOf(retry.run) : (options.levels ?? DEFAULT_LEVELS)
	// A retry repeats the original run's requests, so it offers lookups only if that run did.
	const lookups = !!input.tools && (retry ? retry.run.limitsUsed?.lookups === true : options.limits.lookups !== false)
	// A retry double-checks the new blocking findings it brings if the original run double-checked its own.
	const verify = retry ? retry.run.limitsUsed?.verify === true : options.limits.verify !== false
	const grouping = options.limits.groupDuplicates === true
	const controller = new AbortController()
	const now = (): string => new Date().toISOString()
	const run: AiRun = retry
		? reopen(retry.run, retry.rules)
		: {
				id: randomUUID(),
				reviewId: input.reviewId,
				repoId: input.comparison.repoId,
				baseSha: input.comparison.baseSha,
				headSha: input.comparison.headSha,
				provider: provider.id,
				providerLabel: provider.label,
				model: provider.model,
				fixture: provider.fixture,
				connectionId: options.provenance?.connectionId ?? null,
				connectionLabel: options.provenance?.connectionLabel ?? null,
				protocol: provider.protocol,
				endpoint: options.provenance?.endpoint ?? null,
				limitsUsed: null,
				notices: [],
				promptVersion: PROMPT_VERSION,
				scope: input.scope,
				status: 'running',
				startedAt: now(),
				finishedAt: null,
				coverage: { files: [], skippedRanges: [], supplied: [], batchesTotal: 0, batchesDone: 0, batchesFailed: 0, inputChars: 0 },
				findings: [],
				rejected: [],
				limitations: [],
				errors: [],
				usage: null,
				evaluation: REVIEW_RULES.map((rule) => ({ rule, requests: 0, answered: [], nearMisses: [], why: [], checkedBy: null })),
				unexplained: [],
				team: null,
				levels,
			}
	const description = input.comparison.pr?.body?.trim() || null
	const images = input.images ?? []
	// Images count against the context window as tokens, not characters; reserve their likely size as characters.
	const imageChars = images.length * IMAGE_TOKENS * CHARS_PER_TOKEN
	let background = buildBackground({ description, context: input.context ?? null, issues: [], discussion: null })
	const workers: Array<Worker> = retry
		? retryWorkers(run, retry.rules, retry.providers, lookups)
		: options.team
			? options.team.members.map((m) => ({
					id: m.id,
					role: m.role,
					provider: m.provider,
					rules: REVIEW_RULES.filter((r) => m.rules.includes(r)),
					instructions: instructionsFor(m.rules, m.role, levels, lookups),
					stopped: false,
					member: {
						id: m.id,
						role: m.role,
						connectionId: m.provenance.connectionId,
						connectionLabel: m.provenance.connectionLabel,
						provider: m.provider.id,
						model: m.provider.model,
						rules: REVIEW_RULES.filter((r) => m.rules.includes(r)),
						status: 'running',
						requestsDone: 0,
						requestsFailed: 0,
						requestsTotal: 0,
						usage: null,
						error: null,
					},
				}))
			: [
					{
						id: null,
						role: null,
						provider,
						rules: [...REVIEW_RULES],
						instructions: instructionsFor(null, null, levels, lookups),
						member: null,
						stopped: false,
					},
				]
	if (options.team && !retry) {
		run.team = { id: options.team.id, name: options.team.name, members: workers.map((w) => w.member!) }
		run.providerLabel = options.team.name
		run.model = `${workers.length} reviewers`
		run.fixture = workers.every((w) => w.provider.fixture)
		for (const w of workers) for (const r of w.rules) run.evaluation!.find((e) => e.rule === r)!.checkedBy = w.id
	}
	const external = lookups && input.external?.definitions.length ? input.external : null
	if (external) for (const w of workers) w.instructions = withExternalTools(w.instructions, external.servers)
	const toolChars = lookups ? JSON.stringify(TOOL_DEFINITIONS).length + (external ? JSON.stringify(external.definitions).length : 0) : 0
	let settled = false
	let evidence: EvidenceIndex | null = null // CI messages and test imports that findings are checked against
	const emit = (): void => {
		if (!settled) onUpdate(structuredClone(run))
	}
	const cancel = (): void => {
		if (run.status !== 'running') return
		// A cancelled retry leaves the run as it was, plus whatever answers had already arrived.
		if (!retry) run.status = 'cancelled'
		controller.abort()
	}

	const done = (async (): Promise<AiRun> => {
		try {
			const sources = await input.loadSources()
			if (controller.signal.aborted) return finish(null)
			if (input.loadBackground) {
				try {
					const b = await input.loadBackground(controller.signal)
					for (const n of b.notes) notice(n)
					background = buildBackground({ description, context: input.context ?? null, issues: b.issues, discussion: b.discussion })
				} catch (e) {
					if (controller.signal.aborted) return finish(null)
					notice(
						`Linked issues and the PR conversation could not be read, so only the description was sent: ${e instanceof Error ? e.message : String(e)}`,
					)
				}
			}
			if (retry) return await rerun(sources)
			// Excerpts are cut once, to fit the smallest member; each member then packs its own requests to fit its model.
			const fits = workers.map((w) => {
				const l = w.provider.limits
				const outputTokens = outputBudget(l)
				const fitted = fitToModel(
					options.limits,
					l,
					outputTokens,
					w.instructions.length + toolChars + background.chars + imageChars,
					lookups ? LOOKUP_RESERVE : 0,
				)
				if (!fitted) {
					throw new ProviderError(
						'context-exceeded',
						`${w.role ? `${w.role}: the` : 'The'} model's ${l.contextWindow.toLocaleString()}-token context window is too small for a review request. Choose a model with a larger context, or raise the context window setting for this endpoint if the server allows more.`,
					)
				}
				if (fitted.note) notice(w.role ? `${w.role}: ${fitted.note}` : fitted.note)
				if (w.member) w.member.maxBatchChars = fitted.limits.maxBatchChars
				return { w, limits: fitted.limits, outputTokens }
			})
			const tight = fits.reduce((a, b) => (b.limits.maxBatchChars < a.limits.maxBatchChars ? b : a))
			run.limitsUsed = {
				...tight.limits,
				lookups,
				verify,
				groupDuplicates: grouping,
				contextWindow: tight.w.provider.limits.contextWindow,
				outputTokens: tight.outputTokens,
			}
			let related: RelatedResult | null = null
			if (options.limits.relatedCode !== false && input.loadRelated) {
				try {
					related = await input.loadRelated(sources, controller.signal)
				} catch (e) {
					if (controller.signal.aborted) return finish(null)
					notice(
						`Related code could not be searched, so only the changed excerpts were sent: ${e instanceof Error ? e.message : String(e)}`,
					)
				}
			}
			let facts: FactsResult | null = null
			if (input.loadFacts) {
				try {
					facts = await input.loadFacts(sources, controller.signal)
					for (const n of facts.notes) notice(n)
				} catch (e) {
					if (controller.signal.aborted) return finish(null)
					notice(`Dependency and CI facts could not be gathered: ${e instanceof Error ? e.message : String(e)}`)
				}
			}
			const told = decisionFacts(input.decisions ?? [], sources)
			const allFacts = [...(facts?.facts ?? []), ...importFacts(related?.importers ?? []), ...told]
			const risk = classifyRisk(sources, related)
			evidence = buildEvidence(sources, facts?.annotations ?? [], related ? related.importers : null)
			const prepared = prepareChange(sources, tight.limits, allFacts)
			const keyOf = (x: FileSource): string => x.file.key
			const routed = new Set<string>()
			for (const { w, limits } of fits) {
				const files = options.team ? routeFiles(w.rules, sources, risk, related?.importers ?? []) : null
				for (const k of files ?? sources.map(keyOf)) routed.add(k)
				w.pkg = packContext(
					input.comparison,
					sources,
					prepared,
					limits,
					related?.snippets ?? [],
					allFacts,
					risk,
					files && { fileKeys: files, label: w.role },
				)
			}
			const pkgs = workers.map((w) => w.pkg!)
			const sum = (f: (p: ContextPackage) => number): number => pkgs.reduce((n, p) => n + f(p), 0)
			run.coverage = {
				files: settleFiles(
					prepared,
					pkgs,
					options.team ? { fileKeys: routed, reason: (k) => unroutedReason(sources.find((x) => keyOf(x) === k)) } : null,
					risk,
				),
				skippedRanges: [...prepared.skippedRanges, ...pkgs.flatMap((p) => p.skippedRanges)],
				supplied: workers.flatMap((w) => w.pkg!.supplied.map((x) => (w.id ? { ...x, memberId: w.id } : x))),
				batchesTotal: sum((p) => p.batches.length),
				batchesDone: 0,
				batchesFailed: 0,
				inputChars: sum((p) => p.inputChars),
				related: related && {
					symbols: related.symbols,
					sent: sum((p) => p.related.sent),
					chars: sum((p) => p.related.chars),
					omitted: sum((p) => p.related.omitted),
					notes: related.notes,
				},
				facts: [
					...(background.summary ? [{ kind: 'background' as const, text: background.summary }] : []),
					...(facts?.summary ?? []),
					...(related?.importers.length ? [{ kind: 'structure' as const, text: importSummary(related.importers) }] : []),
					...(told.length
						? [
								{
									kind: 'decisions' as const,
									text: `${told.reduce((n, f) => n + f.text.split('\n').length, 0)} finding${told.length === 1 && !told[0].text.includes('\n') ? '' : 's'} you dismissed on earlier runs, on ${told.length} changed file${told.length === 1 ? '' : 's'}, were told to the reviewer.`,
								},
							]
						: []),
				],
				lookups: lookups
					? { ...emptyLookups(), ...(input.external?.failures.length ? { externalUnavailable: input.external.failures } : {}) }
					: null,
			}
			const omitted = sum((p) => p.related.omitted)
			if (omitted)
				notice(
					`${omitted} related code snippet${omitted === 1 ? '' : 's'} did not fit the request or run limits and ${omitted === 1 ? 'was' : 'were'} not sent.`,
				)
			for (const w of workers) {
				if (w.member) w.member.requestsTotal = w.pkg!.batches.length
				// A member none of whose rules applies to any changed file has nothing to check.
				if (!w.pkg!.batches.length && options.team)
					for (const r of w.rules) evaluationOf(r).why.push('None of the changed files is a kind this rule applies to.')
			}
			emit()
			await Promise.all(workers.map((w) => runBatches(w.pkg!, w)))
			await mergeDuplicates()
			await verifyBlocking()
			const pkg = pkgs[0]
			return finish(pkg)
		} catch (error) {
			const message = redactSecrets(error instanceof Error ? error.message : String(error))
			run.errors.push(retry ? `${retryLabel(retry.rules)}${message}` : message)
			return finish(null)
		}
	})()

	/**
	 * Rebuilds the run's requests from the same commits and limits, and sends each one that missed a retried rule, once,
	 * asking only about the rules it missed. Reviewers run side by side; one reviewer's groups of requests run in turn.
	 */
	async function rerun(sources: Array<FileSource>): Promise<AiRun> {
		const limits = run.limitsUsed
		if (!limits)
			throw new Error('This run was recorded before its limits were saved, so its requests cannot be rebuilt. Run the review again.')
		let related: RelatedResult | null = null
		if (limits.relatedCode !== false && input.loadRelated) related = await input.loadRelated(sources, controller.signal)
		const facts = input.loadFacts ? await input.loadFacts(sources, controller.signal) : null
		if (controller.signal.aborted) return finish(null)
		const allFacts = [...(facts?.facts ?? []), ...importFacts(related?.importers ?? []), ...decisionFacts(input.decisions ?? [], sources)]
		const risk = classifyRisk(sources, related)
		evidence = buildEvidence(sources, facts?.annotations ?? [], related ? related.importers : null)
		// Team runs recorded before members got their own requests shared one set, sized for the smallest member.
		const shared = !run.team || legacySupplied(run)
		const owners = [...new Set(workers.map((w) => w.id))].map((id) => workers.filter((w) => w.id === id))
		// Every reviewer's requests are rebuilt and checked before any is sent, so a mismatch sends nothing.
		let pkg: ContextPackage | null = null
		for (const group of owners) {
			const w = group[0]
			const member = w.member
			const files = shared || !member ? null : routeFiles(member.rules, sources, risk, related?.importers ?? [])
			pkg = packContext(
				input.comparison,
				sources,
				prepareChange(sources, limits, allFacts),
				{ ...limits, maxBatchChars: shared ? limits.maxBatchChars : (member?.maxBatchChars ?? limits.maxBatchChars) },
				related?.snippets ?? [],
				allFacts,
				risk,
				files && { fileKeys: files, label: w.role },
			)
			const before = shared ? run.coverage.supplied : run.coverage.supplied.filter((x) => (x.memberId ?? null) === w.id)
			const strip = (xs: Array<SuppliedExcerpt>): string => JSON.stringify(xs.map(({ memberId: _m, ...x }) => x))
			if (strip(pkg.supplied) !== strip(before))
				throw new Error('The excerpts no longer match the ones this run sent, so the requests cannot be repeated. Run the review again.')
			for (const x of group) x.pkg = pkg
		}
		emit()
		await Promise.all(
			owners.map(async (group) => {
				for (const w of group) {
					// A fatal error (a revoked key, say) stops the reviewer's other groups too.
					if (group.some((x) => x.stopped)) break
					await runBatches(
						w.pkg!,
						w,
						w.pkg!.batches.filter((b) => w.retryBatches!.includes(b.index)),
					)
				}
			}),
		)
		await verifyBlocking()
		return finish(pkg)
	}

	async function runBatches(pkg: ContextPackage, w: Worker, batches = pkg.batches): Promise<void> {
		const queue = [...batches]
		const worker = async (): Promise<void> => {
			while (!w.stopped && !controller.signal.aborted) {
				const batch = queue.shift()
				if (!batch) return
				const outcome = await runBatch(batch, w)
				if (controller.signal.aborted || run.status !== 'running') return // late result of a cancelled run
				const prefix = w.role ? `${w.role}: ` : ''
				if (retry) {
					if (outcome.ok) merge(outcome.value, w, batch.index)
					settleRetried(batch.index, w, outcome.ok ? null : outcome.error.message)
					if (!outcome.ok && outcome.error instanceof ProviderError && outcome.error.fatal) w.stopped = true
				} else if (outcome.ok) {
					merge(outcome.value, w, batch.index)
					run.coverage.batchesDone++
					if (w.member) w.member.requestsDone++
					setBatchFiles(batch.fileKeys, batch.index, 'reviewed', null, w)
				} else {
					run.coverage.batchesFailed++
					if (w.member) {
						w.member.requestsFailed++
						w.member.error = outcome.error.message
					}
					run.errors.push(`${prefix}Request ${batch.index + 1}: ${outcome.error.message}`)
					setBatchFiles(batch.fileKeys, batch.index, 'failed', `${prefix}${outcome.error.message}`, w)
					if (outcome.error instanceof ProviderError && outcome.error.fatal) w.stopped = true
				}
				emit()
			}
		}
		await Promise.all(Array.from({ length: Math.min(options.concurrency, queue.length) }, worker))
		if (retry) return
		if (w.member && w.member.status === 'running')
			w.member.status = controller.signal.aborted
				? 'cancelled'
				: w.member.requestsDone === 0 && w.member.requestsTotal > 0
					? 'failed'
					: 'completed'
	}

	/** Adds one response to the run. Each member owns its rules, so the same problem from two members is merged, not repeated. */
	function merge(value: ReturnType<typeof validateBatchOutput>, w: Worker, batchIndex: number): void {
		const fresh: Array<Finding> = []
		for (const f of value.findings.map((x) => withSupport({ ...markRepeat(x), memberId: w.id }))) {
			// Two members quoting the same source on overlapping lines found one problem. One reviewer reporting two findings
			// there means two problems (it is told to report each once), so its own findings only merge on the same title.
			const dup = [...run.findings, ...fresh].find((e) => isDuplicate(e, f) || (w.id !== null && e.memberId !== w.id && sameProblem(e, f)))
			if (!dup) fresh.push(f)
			else if (w.id && dup.memberId !== w.id) {
				dup.alsoBy = [...new Set([...(dup.alsoBy ?? []), w.id])]
				run.rejected.push({ title: f.title, excerptId: f.excerptId, reason: `Same problem as "${dup.title}", also reported by ${w.role}` })
			} else run.rejected.push({ title: f.title, excerptId: f.excerptId, reason: `Duplicate of "${dup.title}"` })
		}
		// Findings over a limit are kept (so decisions and comment links stay valid) but marked, not listed as open.
		const budget = applyBudget(run.findings, fresh)
		run.findings.push(...budget.kept, ...budget.held)
		run.rejected.push(...value.rejected.map((r) => (w.role ? { ...r, reason: `${w.role}: ${r.reason}` } : r)))
		for (const e of value.evaluation) {
			const agg = run.evaluation!.find((x) => x.rule === e.rule)!
			agg.requests++
			agg.answered?.push(batchIndex)
			agg.nearMisses.push(...e.nearMisses.slice(0, Math.max(0, 20 - agg.nearMisses.length)))
			if (e.why && !agg.why.includes(e.why) && agg.why.length < 5) agg.why.push(e.why)
		}
		for (const u of value.unexplained) if (!run.unexplained!.some((x) => x.fileKey === u.fileKey)) run.unexplained!.push(u)
		run.outdatedDocs ??= []
		for (const d of value.outdatedDocs) if (!run.outdatedDocs.some((x) => x.path === d.path && x.line === d.line)) run.outdatedDocs.push(d)
		for (const l of value.limitations) {
			const text = w.role ? `${w.role}: ${l}` : l
			if (!run.limitations.includes(text)) run.limitations.push(text)
		}
	}

	type BatchOutcome = { ok: true; value: ReturnType<typeof validateBatchOutput> } | { ok: false; error: Error }

	async function runBatch(batch: ContextBatch, w: Worker): Promise<BatchOutcome> {
		for (let attempt = 0; ; attempt++) {
			const budget = lookups ? lookupBudget(batch, w) : null
			const tools = budget && input.tools ? input.tools(budget) : undefined
			const sendImages = images.length > 0 && !w.imagesRejected
			try {
				const response = await w.provider.review(
					{ instructions: w.instructions, input: buildInput(batch, background.sections), batch, tools, ...(sendImages ? { images } : {}) },
					controller.signal,
				)
				if (controller.signal.aborted) return { ok: false, error: new ProviderError('cancelled', 'Cancelled') }
				addUsage(response.usage, w)
				if (response.toolsRejected && run.coverage.lookups) {
					const why = `${w.role ? `${w.role}: the` : 'The'} endpoint did not accept lookups, so the reviewer could not open files or search: ${response.toolsRejected}`
					run.coverage.lookups.unavailable ??= why
					notice(why)
				}
				if (response.jsonFallback)
					notice(
						`${w.role ? `${w.role}: the` : 'The'} endpoint does not support native structured output; JSON mode was used and the output was validated against the same schema.`,
					)
				checkTruncation(batch, response.usage?.inputTokens ?? null, w)
				return { ok: true, value: validateBatchOutput(response.output, batch, input.comparison, run.id, w.rules, levels) }
			} catch (error) {
				const e = asProviderError(error)
				if (controller.signal.aborted || e.kind === 'cancelled') return { ok: false, error: e }
				// Many models and gateways refuse images outright; the request is sent again without them, once per reviewer.
				if (sendImages && (e.kind === 'bad-request' || e.kind === 'model-unavailable' || e.kind === 'unsupported')) {
					w.imagesRejected = true
					notice(`${w.role ? `${w.role}: the` : 'The'} model did not accept images, so its requests were sent without them: ${e.message}`)
					attempt--
					continue
				}
				if (!e.retryable || attempt + 1 >= options.maxAttempts) return { ok: false, error: e }
				await sleep(options.backoffMs(attempt, e), controller.signal)
				if (controller.signal.aborted) return { ok: false, error: new ProviderError('cancelled', 'Cancelled') }
			} finally {
				if (tools && run.coverage.lookups && !controller.signal.aborted) addLookups(run.coverage.lookups, tools.log)
			}
		}
	}

	/**
	 * What one request may look up: calls and characters by the riskiest file it carries, never more characters than
	 * are left of the member's context window after the request itself (every lookup result stays in the conversation).
	 * Null when too little is left.
	 */
	function lookupBudget(batch: ContextBatch, w: Worker): LookupBudget | null {
		const l = w.provider.limits
		const room =
			capacityChars(l.contextWindow, outputBudget(l), w.instructions.length + toolChars + background.chars + imageChars) - batch.chars
		const levels = batch.fileKeys.map((k) => run.coverage.files.find((f) => f.fileKey === k)?.risk?.level)
		// Files without a rating (older runs) count as high, the full budget they had before.
		const level = levels.some((x) => x === 'high' || x === undefined) ? 'high' : levels.includes('medium') ? 'medium' : 'low'
		const budget = LOOKUPS_BY_RISK[level]
		return room < 2000 ? null : { maxCalls: budget.maxCalls, maxChars: Math.min(budget.maxChars, room) }
	}

	/** The evidence the app found for a finding, checked when it arrives; the model never writes it. */
	function withSupport(f: Finding): Finding {
		const support = evidence ? supportFor(f, evidence) : []
		return support.length ? { ...f, support } : f
	}

	/**
	 * Folds findings that describe the same problem at different places under the most severe one, from one request to
	 * the model with the largest context window that did not fail. Every finding is kept. A failure leaves them as they
	 * are and says so. Retries skip it: grouping again could fold findings someone already acted on.
	 */
	async function mergeDuplicates(): Promise<void> {
		if (!grouping || retry || controller.signal.aborted || run.status !== 'running') return
		const open = run.findings.filter((f) => !f.heldBack && !f.mergedInto)
		if (open.length < 2) return
		const w = [...workers]
			.filter((x) => !x.stopped && x.member?.status !== 'failed')
			.sort((a, b) => b.provider.limits.contextWindow - a.provider.limits.contextWindow)[0]
		if (!w) return
		const { request, labels } = buildMergeRequest(open)
		if (open.length > labels.size) notice(`Only the first ${labels.size} of ${open.length} findings were checked for duplicates.`)
		for (let attempt = 0; ; attempt++) {
			try {
				const response = await w.provider.review(request, controller.signal)
				addUsage(response.usage, w)
				if (controller.signal.aborted || run.status !== 'running') return
				const groups = readGroups(response.output, labels)
				for (const g of groups) {
					g.primary.alsoAt = [
						...(g.primary.alsoAt ?? []),
						...g.others.map((o) => ({
							findingId: o.id,
							path: (o.anchor.side === 'old' ? o.anchor.oldPath : o.anchor.newPath) ?? o.anchor.fileKey,
							line: o.anchor.startLine,
							title: o.title,
						})),
					]
					for (const o of g.others) {
						o.mergedInto = g.primary.id
						o.mergedReason = g.reason
					}
				}
				if (groups.length) run.merged = { groups: groups.length, findings: groups.reduce((n, g) => n + g.others.length, 0) }
				emit()
				return
			} catch (error) {
				const e = asProviderError(error)
				if (controller.signal.aborted || e.kind === 'cancelled') return
				if (!e.retryable || attempt + 1 >= options.maxAttempts) {
					notice(`Findings could not be checked for duplicates, so each is listed on its own: ${e.message}`)
					return
				}
				await sleep(options.backoffMs(attempt, e), controller.signal)
			}
		}
	}

	/**
	 * Double-checks the blocking findings not checked yet, in a request that tries to prove each one wrong. In a team the
	 * check goes to another member, on a different model when there is one, so a model does not grade its own work.
	 * Runs after every review request is answered, so the run is still 'running' meanwhile.
	 */
	async function verifyBlocking(): Promise<void> {
		if (!verify || controller.signal.aborted || run.status !== 'running') return
		const todo = run.findings
			.filter((f) => f.severity === 'blocking' && !f.heldBack && !f.mergedInto && !f.verification)
			.flatMap((f) => {
				const w = workers.find((x) => x.id === (f.memberId ?? null))
				return w ? [{ f, w, checker: checkerFor(w) }] : []
			})
		const queue = todo.slice(0, MAX_VERIFIED)
		if (todo.length > queue.length)
			notice(
				`${todo.length - queue.length} blocking finding${todo.length - queue.length === 1 ? ' was' : 's were'} not double-checked: at most ${MAX_VERIFIED} are checked per run.`,
			)
		if (!queue.length) return
		const progress = (run.verification ??= { total: 0, done: 0, failed: 0 })
		progress.total += queue.length
		emit()
		const next = async (): Promise<void> => {
			for (let item = queue.shift(); item && !controller.signal.aborted; item = queue.shift()) {
				const result = await verifyOne(item.f, item.w, item.checker)
				if (controller.signal.aborted || run.status !== 'running') return
				item.f.verification = result
				if (result.error) progress.failed++
				else progress.done++
				emit()
			}
		}
		await Promise.all(Array.from({ length: Math.min(options.concurrency, queue.length) }, next))
	}

	/**
	 * Who double-checks a finding `w` raised: another member that did not fail, on a different model if any (the largest
	 * context window first, for room to look things up), else another member, else `w` itself (single model, retries).
	 */
	function checkerFor(w: Worker): Worker {
		const modelOf = (x: Worker): string => `${x.member?.connectionId ?? ''}\u0000${x.provider.model}`
		const others = workers.filter((x) => x.id !== w.id && !x.stopped && x.member?.status !== 'failed')
		const byWindow = (a: Worker, b: Worker): number => b.provider.limits.contextWindow - a.provider.limits.contextWindow
		return others.filter((x) => modelOf(x) !== modelOf(w)).sort(byWindow)[0] ?? others.sort(byWindow)[0] ?? w
	}

	async function verifyOne(f: Finding, raiser: Worker, w: Worker): Promise<FindingVerification> {
		// The excerpt and facts come from the requests of the member that raised it; the checker may not have had that file.
		const batch = raiser.pkg?.batches.find((b) => b.excerpts.some((e) => e.id === f.excerptId))
		const excerpt = batch?.excerpts.find((e) => e.id === f.excerptId)?.text ?? null
		const facts = (batch?.facts ?? []).filter((x) => x.fileKeys?.includes(f.anchor.fileKey))
		const failed = (why: string): FindingVerification => ({
			verdict: 'unsure',
			reason: `Not double-checked: ${why}`,
			level: null,
			checked: [],
			model: w.provider.model,
			memberId: w.id,
			error: true,
		})
		for (let attempt = 0; ; attempt++) {
			const draft = buildVerifyRequest(f, excerpt, facts, undefined)
			const l = w.provider.limits
			// Lookups get the full budget: a blocking finding is worth reading for. Never more than the window has left.
			const room = capacityChars(l.contextWindow, outputBudget(l), draft.instructions.length + toolChars) - draft.input.length
			const tools =
				lookups && input.tools && room >= 2000
					? input.tools({ maxCalls: LOOKUPS_BY_RISK.high.maxCalls, maxChars: Math.min(LOOKUPS_BY_RISK.high.maxChars, room) })
					: undefined
			try {
				const response = await w.provider.review(buildVerifyRequest(f, excerpt, facts, tools), controller.signal)
				addUsage(response.usage, w)
				return { ...parseVerification(response.output), model: w.provider.model, memberId: w.id }
			} catch (error) {
				const e = asProviderError(error)
				if (controller.signal.aborted || e.kind === 'cancelled') return failed('cancelled')
				if (!e.retryable || attempt + 1 >= options.maxAttempts) return failed(e.message)
				await sleep(options.backoffMs(attempt, e), controller.signal)
			} finally {
				if (tools && run.coverage.lookups && !controller.signal.aborted) addLookups(run.coverage.lookups, tools.log)
			}
		}
	}

	function evaluationOf(rule: ReviewRule): RuleEvaluation {
		return run.evaluation!.find((e) => e.rule === rule)!
	}

	/**
	 * Books a retried request. Its error is replaced by the newest one, and it only counts as done once every rule of
	 * its reviewer has been answered for it; until then the earlier error stays.
	 */
	function settleRetried(index: number, w: Worker, error: string | null): void {
		const label = `${w.role ? `${w.role}: ` : ''}Request ${index + 1}: `
		const at = run.errors.findIndex((e) => e.startsWith(label))
		if (error) {
			if (at >= 0) run.errors[at] = label + error
			else {
				run.errors.push(label + error)
				run.coverage.batchesFailed++
				if (w.member) w.member.requestsFailed++
			}
			if (w.member) w.member.error = error
			return
		}
		const owned = run.evaluation!.filter((e) => (e.checkedBy ?? null) === w.id)
		if (!owned.every((e) => e.answered?.includes(index))) return
		run.coverage.batchesDone++
		if (w.member) w.member.requestsDone++
		if (at >= 0) {
			run.errors.splice(at, 1)
			run.coverage.batchesFailed--
			if (w.member) w.member.requestsFailed--
		}
		if (w.member && w.member.requestsFailed === 0) w.member.error = null
	}

	function notice(text: string): void {
		if (!run.notices!.includes(text)) run.notices!.push(text)
	}

	/**
	 * Some local servers silently drop the start of a prompt that exceeds their context window. If the endpoint
	 * reports far fewer input tokens than we sent, treat the batch as not reviewed rather than trusting it.
	 */
	function checkTruncation(batch: ContextPackage['batches'][number], reportedInput: number | null, w: Worker): void {
		if (reportedInput === null || reportedInput <= 0) return
		const sentChars = batch.chars + w.instructions.length + background.chars + (w.imagesRejected ? 0 : imageChars)
		const minExpected = Math.floor(sentChars / (CHARS_PER_TOKEN * 3)) // generous: 9 chars/token is already implausible
		if (sentChars > 4000 && reportedInput < minExpected) {
			throw new ProviderError(
				'context-exceeded',
				`The endpoint reported ${reportedInput.toLocaleString()} input tokens for about ${Math.round(sentChars / CHARS_PER_TOKEN).toLocaleString()} sent; it probably truncated the request to fit its context window. Set the correct context window for this connection.`,
			)
		}
	}

	function markRepeat(f: Finding): Finding {
		const earlier = input.previousFindings.find((p) => findingKey(p) === findingKey(f) || isDuplicate(p, f))
		return earlier ? { ...f, repeatOf: earlier.id } : f
	}

	function addUsage(u: AiUsage | null, w: Worker): void {
		if (!u) return
		const targets = [(run.usage ??= emptyUsage()), ...(w.member ? [(w.member.usage ??= emptyUsage())] : [])]
		for (const t of targets) {
			t.inputTokens += u.inputTokens
			t.cachedInputTokens += u.cachedInputTokens
			t.outputTokens += u.outputTokens
			t.reasoningTokens += u.reasoningTokens
			t.totalTokens += u.totalTokens || u.inputTokens + u.outputTokens
		}
	}

	/** A file split across batches is 'reviewed' only once every batch that carries it succeeded. */
	function setBatchFiles(keys: Array<string>, index: number, state: 'reviewed' | 'failed', reason: string | null, w: Worker): void {
		for (const key of keys) {
			const cov = run.coverage.files.find((f) => f.fileKey === key)
			if (!cov) continue
			const slots = workers.flatMap((x) => (x.pkg?.batches ?? []).filter((b) => b.fileKeys.includes(key)).map((b) => `${b.index}:${x.id}`))
			const results = (fileResults[key] ??= {})
			results[`${index}:${w.id}`] = state
			const values = slots.map((k) => results[k])
			if (values.includes('failed')) {
				cov.state = values.includes('reviewed') ? 'partial' : 'failed'
				cov.reason = reason ?? cov.reason
			} else if (values.every((v) => v === 'reviewed')) {
				const partlySkipped = run.coverage.skippedRanges.some((r) => r.fileKey === key)
				cov.state = partlySkipped ? 'partial' : 'reviewed'
				if (partlySkipped) cov.reason = run.coverage.skippedRanges.find((r) => r.fileKey === key)?.reason ?? cov.reason
			}
		}
	}
	const fileResults: Record<string, Record<string, 'reviewed' | 'failed'>> = {}

	function finish(pkg: ContextPackage | null): AiRun {
		if (retry) return finishRetry(pkg)
		const cancelled = run.status === 'cancelled'
		for (const w of workers) if (w.member?.status === 'running') w.member.status = cancelled ? 'cancelled' : 'failed'
		for (const f of run.coverage.files) {
			if (f.state === 'pending') {
				f.state = cancelled ? 'cancelled' : 'failed'
				f.reason = cancelled ? 'Cancelled before this file was reviewed' : (f.reason ?? 'Not reviewed')
			}
		}
		if (!cancelled) run.status = overallStatus(run.coverage.files, pkg, run.errors)
		if (evidence && pkg) run.ciUncovered = uncoveredCi(run.findings, evidence)
		run.finishedAt = now()
		settled = true
		onUpdate(structuredClone(run))
		return structuredClone(run)
	}

	/** File coverage follows the rules: a file is reviewed once every rule was answered for every request carrying it. */
	function finishRetry(pkg: ContextPackage | null): AiRun {
		if (pkg) {
			for (const f of run.coverage.files) {
				// Each rule is answered in its own reviewer's requests; a rule whose reviewer was not given the file has no slot.
				const shared = legacySupplied(run)
				const slots = run.evaluation!.flatMap((e) => {
					const owner = e.checkedBy ?? null
					const mine = run.coverage.supplied.filter((s) => s.fileKey === f.fileKey && (shared || (s.memberId ?? null) === owner))
					return [...new Set(mine.map((s) => s.batch))].map((b) => e.answered?.includes(b) ?? false)
				})
				if (!slots.length) continue
				const skipped = run.coverage.skippedRanges.find((r) => r.fileKey === f.fileKey)
				if (slots.every(Boolean)) {
					f.state = skipped ? 'partial' : 'reviewed'
					f.reason = skipped?.reason ?? null
				} else if (slots.some(Boolean)) f.state = 'partial'
			}
		}
		for (const m of new Set(workers.flatMap((w) => (w.member ? [w.member] : []))))
			m.status = m.requestsDone === 0 && m.requestsTotal > 0 ? 'failed' : 'completed'
		// A retry that could not rebuild the requests leaves the run's status as it was.
		run.status = pkg ? overallStatus(run.coverage.files, pkg, run.errors) : retry!.run.status
		run.retrying = null
		if (evidence && pkg) run.ciUncovered = uncoveredCi(run.findings, evidence)
		run.finishedAt = now()
		settled = true
		onUpdate(structuredClone(run))
		return structuredClone(run)
	}

	emit()
	return { run: structuredClone(run), cancel, done }
}

/** A team run from before members got their own requests: one shared set, so supplied excerpts name no member. */
function legacySupplied(run: AiRun): boolean {
	return !!run.team && !run.coverage.supplied.some((s) => s.memberId)
}

function asProviderError(error: unknown): ProviderError {
	return error instanceof ProviderError
		? error
		: error instanceof InvalidOutputError
			? new ProviderError('invalid-output', error.message)
			: new ProviderError('network', redactSecrets(error instanceof Error ? error.message : String(error)))
}

function retryLabel(rules: Array<ReviewRule>): string {
	return `Retry of ${rules.join(', ')}: `
}

/** The rules a retry error was about, from its label. */
function retryLabelRules(error: string): Array<string> {
	return /^Retry of ([^:]+): /.exec(error)?.[1].split(', ') ?? []
}

/** The run, running again: per-rule request indexes are filled in for older runs, and the rules' last retry errors are dropped. */
function reopen(previous: AiRun, rules: Array<ReviewRule>): AiRun {
	const run = structuredClone(previous)
	run.status = 'running'
	run.retrying = rules
	run.finishedAt = null
	run.errors = run.errors.filter((e) => !retryLabelRules(e).some((r) => rules.includes(r as ReviewRule)))
	for (const e of run.evaluation ?? []) e.answered ??= answeredRequests(previous, e) ?? undefined
	return run
}

/**
 * One worker per owning reviewer and set of missed rules: a request is sent once, asking only about the retried rules
 * it did not answer, so a rule it did answer is not counted twice.
 */
function retryWorkers(
	run: AiRun,
	rules: Array<ReviewRule>,
	providers: ReadonlyMap<string | null, ReviewProvider>,
	lookups: boolean,
): Array<Worker> {
	const evaluations = REVIEW_RULES.filter((r) => rules.includes(r)).map((r) => run.evaluation!.find((e) => e.rule === r)!)
	const workers: Array<Worker> = []
	for (const owner of [...new Set(evaluations.map((e) => e.checkedBy ?? null))]) {
		const member = owner ? (run.team?.members.find((m) => m.id === owner) ?? null) : null
		const provider = providers.get(owner)
		if (!provider) throw new Error(`No reviewer was given for ${member?.role ?? 'this run'}.`)
		if (member) member.status = 'running'
		const mine = evaluations.filter((e) => (e.checkedBy ?? null) === owner)
		const groups = new Map<string, { rules: Array<ReviewRule>; batches: Array<number> }>()
		for (let i = 0; i < (member ? member.requestsTotal : run.coverage.batchesTotal); i++) {
			const missed = mine.filter((e) => !e.answered?.includes(i)).map((e) => e.rule as ReviewRule)
			if (!missed.length) continue
			const group = groups.get(missed.join()) ?? { rules: missed, batches: [] }
			group.batches.push(i)
			groups.set(missed.join(), group)
		}
		for (const g of groups.values())
			workers.push({
				id: member?.id ?? null,
				role: member?.role ?? null,
				provider,
				rules: g.rules,
				instructions: instructionsFor(g.rules, member?.role ?? null, levelsOf(run), lookups),
				member,
				stopped: false,
				retryBatches: g.batches,
			})
	}
	return workers
}

/**
 * Indexes of the requests whose answer covered a rule. Runs recorded before `answered` existed are reconstructed from
 * their per-request errors; null when that does not add up (e.g. a cancelled run that had answers).
 */
export function answeredRequests(run: AiRun, e: RuleEvaluation): Array<number> | null {
	if (e.answered) return e.answered
	if (e.requests === 0) return []
	if (run.status === 'cancelled' || run.status === 'running') return null
	const m = e.checkedBy ? run.team?.members.find((x) => x.id === e.checkedBy) : undefined
	const total = m ? m.requestsTotal : run.coverage.batchesTotal
	const prefix = m ? `${m.role}: ` : ''
	const failed = new Set(
		run.errors.flatMap((x) => {
			const hit = x.startsWith(prefix) ? /^Request (\d+): /.exec(x.slice(prefix.length)) : null
			return hit ? [Number(hit[1]) - 1] : []
		}),
	)
	const answered = Array.from({ length: total }, (_, i) => i).filter((i) => !failed.has(i))
	return answered.length === e.requests ? answered : null
}

/** completed = every reviewable file in scope was fully reviewed; partial = some were; failed = none were. */
export function overallStatus(files: Array<FileCoverage>, pkg: ContextPackage | null, errors: Array<string>): AiRun['status'] {
	if (!pkg) return 'failed'
	const reviewable = files.filter((f) => f.state !== 'not-reviewable')
	const reviewed = reviewable.filter((f) => f.state === 'reviewed' || f.state === 'partial')
	if (reviewable.length === 0) return errors.length ? 'failed' : 'completed'
	if (reviewed.length === 0) return 'failed'
	return reviewable.every((f) => f.state === 'reviewed') && errors.length === 0 ? 'completed' : 'partial'
}

function emptyUsage(): AiUsage {
	return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(done, ms)
		function done(): void {
			signal.removeEventListener('abort', done)
			clearTimeout(t)
			resolve()
		}
		signal.addEventListener('abort', done, { once: true })
	})
}

/** The levels a run was allowed to use; runs before configurable levels had the first three. */
export function levelsOf(run: AiRun): Array<FindingLevel> {
	return run.levels ?? ['blocking', 'should_fix', 'pre_existing']
}
