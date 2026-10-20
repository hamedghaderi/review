import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import {
	BUGS_ONLY_RULES,
	DEFAULT_TEAM_ROLES,
	type AiRun,
	type AiScope,
	type Anchor,
	type CarriedRun,
	type CodeMessage,
	type CodeQuestion,
	type Comparison,
	type FileLinesResult,
	type FindingMessage,
	type FindingVerification,
	type FindingReproducer,
	type GoneFinding,
	type Finding,
	type ModelSelection,
	type PatchResult,
	type ReviewerChoice,
	type ReviewRule,
	type ReviewTeam,
	type PastDecision,
	type EarlierLimitations,
	type ReviewContext,
	type FindingLevel,
	type UsageKind,
	type PricedModel,
	type ReviewLimits,
	type RunEstimate,
	REVIEW_RULES,
} from '../../shared/types.ts'
import type { PersonaId } from '../../shared/personas.ts'
import { AppFail } from '../git.ts'
import type { ReviewStore } from '../store.ts'
import type { RunConfig } from './connections.ts'
import type { FileSource } from './context.ts'
import type { RelatedResult } from './related.ts'
import type { FactsResult } from './facts.ts'
import type { ExternalTools, LookupBudget, ReviewTools, SeenLines } from './lookup.ts'
import { DEFAULT_LEVELS, instructionsFor, PROMPT_VERSION } from './prompt.ts'
import { estimateRun, type EstimateReviewer } from './estimate.ts'
import type { ReviewerPrint } from './incremental.ts'
import type { Baseline } from './history.ts'
import { buildAskRequest, codeAround, MAX_QUESTION_CHARS, MAX_THREAD_MESSAGES, parseAnswer, seenAround } from './ask.ts'
import { Seen, unreadRefs, verificationTexts, withUnread } from './citations.ts'
import { buildVerifyRequest, parseVerification } from './verify.ts'
import { buildReproducerRequest, parseReproducer } from './reproduce.ts'
import { capacityChars } from './context.ts'
import { LOOKUPS_BY_RISK, TOOL_DEFINITIONS } from './lookup.ts'
import { outputBudget, type ModelLimits } from './provider.ts'
import { buildExplainRequest, EXPLAIN_LOOKUPS, MAX_CODE_MESSAGES, MAX_CODE_QUESTION_CHARS, parseExplain } from './explain.ts'
import type { ProviderRequest, RequestImage } from './provider.ts'
import type { UsageLog } from './usage.ts'
import type { BudgetCheck } from './budget.ts'
import { answeredRequests, defaultBackoff, startRun, type RunHandle, type RunInput, type RunnerOptions } from './runner.ts'

/** Resolves a model selection into a fixed run configuration (adapter + captured credential). */
export type RunConfigSource = (selection: ModelSelection) => Promise<RunConfig>
export type TeamSource = (teamId: string) => ReviewTeam
/** A model's limits and price as a run would use them, and the review limits; read without the credential. */
export interface ModelSource {
	info(selection: ModelSelection): { limits: ModelLimits; price: PricedModel | null } | null
	limits(): ReviewLimits
	label(connectionId: string): string
}
/** Where a run on these connections stands against the budgets (see checkBudget). */
export interface BudgetSource {
	check(connections: Array<{ id: string; label: string }>, ignoreCaps?: boolean): BudgetCheck
	active(): boolean // any budget is set
}

export interface ComparisonAccess {
	comparison: Comparison
	loadPatch(fileKey: string): Promise<PatchResult>
	loadFileLines(fileKey: string): Promise<FileLinesResult>
	findRelated?(sources: Array<FileSource>, signal: AbortSignal): Promise<RelatedResult>
	loadFacts?(sources: Array<FileSource>, signal: AbortSignal): Promise<FactsResult>
	/** Linked issues and the PR conversation; absent for branch reviews. */
	loadBackground?: RunInput['loadBackground']
	/** The notes and files you gave the reviewer for this review, as saved when the run starts. */
	reviewContext?(): ReviewContext | null
	/** The images in that context, read from disk when the run starts. */
	contextImages?(): Promise<Array<RequestImage>>
	/** Existing tests that import a changed file, at the head commit, to write a new test in their style. */
	testExamples?(fileKey: string): Promise<Array<{ path: string; text: string }>>
	/** Findings the reviewer dismissed on earlier runs of this pull request or branch, newest first. */
	pastDecisions?(): Array<PastDecision>
	/** What the newest finished run of this pull request or branch could not settle. */
	earlierLimitations?(): EarlierLimitations | null
	/** The newest finished run on an earlier snapshot of this pull request or branch, moved here; `pinned`: that run instead. */
	findingBaseline?(pinned: CarriedRun | null): Promise<Baseline | null>
	/** Read-only lookups in the comparison's two commits, for one review request, plus the run's MCP tools if any. */
	tools?(budget: LookupBudget, external?: ExternalTools | null): ReviewTools
	/** Connects the enabled MCP servers for one run; null when none is enabled. */
	openExternal?(signal: AbortSignal): Promise<ExternalTools | null>
}

const MAX_RUNS_PER_REVIEW = 50
const MAX_EARLIER_CHECKS = 5 // checks a finding keeps after Verify replaces them

/**
 * Owns the single active AI run. Every update is persisted against the run's own review, so results can never
 * land in a different comparison; switching comparisons cancels the run.
 */
export class AiController {
	// `background`: an automatic review's label ("owner/name#12"); opening other reviews does not cancel it.
	private active: { handle: RunHandle; repoId: string; reviewId: string; connectionIds: Array<string>; background: string | null } | null =
		null
	private teams: TeamSource | null = null
	private levels: (() => Array<FindingLevel>) | null = null
	private usage: UsageLog | null = null
	private models: ModelSource | null = null
	private budget: BudgetSource | null = null
	private onDemandBusy = new Set<string>() // "verify:", "test:" and "check:<finding id>" requests under way
	private starting = false
	private store: ReviewStore
	private resolveRun: RunConfigSource
	private concurrency: number
	private notify: (run: AiRun) => void

	constructor(store: ReviewStore, resolveRun: RunConfigSource, notify: (run: AiRun) => void, options: { concurrency?: number } = {}) {
		this.store = store
		this.resolveRun = resolveRun
		this.notify = notify
		this.concurrency = options.concurrency ?? 2
	}

	/** Runs still marked running were interrupted by a crash or forced quit; record that instead of leaving them open. */
	recoverInterrupted(): Promise<void> {
		return this.store.update((d) => {
			for (const repo of Object.values(d.repos)) {
				for (const runs of Object.values(repo.aiRuns ?? {})) {
					for (const run of runs) {
						if (run.status !== 'running') continue
						run.status = 'cancelled'
						run.finishedAt ??= new Date().toISOString()
						run.errors.push('Interrupted: the app closed while this review was running')
						for (const f of run.coverage.files) {
							if (f.state === 'pending') {
								f.state = 'cancelled'
								f.reason = 'Interrupted before this file was reviewed'
							}
						}
					}
				}
			}
		})
	}

	attachTeams(teams: TeamSource): void {
		this.teams = teams
	}

	attachLevels(levels: () => Array<FindingLevel>): void {
		this.levels = levels
	}

	attachUsage(usage: UsageLog): void {
		this.usage = usage
	}

	attachModels(models: ModelSource): void {
		this.models = models
	}

	attachBudget(budget: BudgetSource): void {
		this.budget = budget
	}

	/**
	 * What a run with `choice` over `scope` would send and cost, from its requests packed as the run packs them. Reads
	 * only the diff and the files it changes: no related code, CI results, conversation or credentials.
	 */
	async estimate(
		access: ComparisonAccess,
		scope: AiScope,
		choice: ReviewerChoice,
		carried: ReadonlySet<string> = new Set(),
	): Promise<RunEstimate> {
		if (!this.models) throw new AppFail('ai-unavailable', 'AI review is not available.')
		const levels = this.levels?.() ?? DEFAULT_LEVELS
		const members: Array<{
			role: string | null
			rules: ReadonlyArray<ReviewRule> | null
			persona: PersonaId | null
			selection: ModelSelection
		}> =
			choice.kind === 'model'
				? ((roles) =>
						roles.length
							? roles.map((r) => ({ role: r.role, rules: r.rules, persona: choice.persona ?? null, selection: choice.selection }))
							: [{ role: null, rules: null, persona: choice.persona ?? null, selection: choice.selection }])(passRoles(choice))
				: (this.teams?.(choice.teamId).members ?? []).map((m) => ({
						role: m.role,
						rules: m.rules,
						persona: m.persona ?? null,
						selection: { connectionId: m.connectionId, modelId: m.modelId },
					}))
		const limits = this.models.limits()
		const reviewers: Array<EstimateReviewer> = []
		for (const m of members) {
			const info = this.models.info(m.selection)
			if (!info) throw new AppFail('ai-unavailable', `${m.role ? `${m.role}: ` : ''}“${m.selection.modelId}” is not offered any more.`)
			reviewers.push({
				role: m.role,
				model: m.selection.modelId,
				// A focused pass or team member gets only the files its rules apply to; one model gets them all.
				rules: m.role ? m.rules : null,
				limits: info.limits,
				price: info.price,
				instructionChars: instructionsFor(m.role ? m.rules : null, m.role, levels, limits.lookups !== false, m.persona).length,
			})
		}
		const keys =
			scope.kind === 'file' ? [scope.fileKey] : scope.kind === 'files' ? scope.fileKeys : access.comparison.files.map((f) => f.key)
		const estimate = estimateRun(access.comparison, await loadSources(access, keys), limits, reviewers, carried)
		const connections = [...new Map(members.map((m) => [m.selection.connectionId, m.selection])).keys()].map((id) => ({
			id,
			label: this.models!.label(id),
		}))
		// Budgets can only count what has a price; with one set, say which models they can't limit.
		const unbudgeted = this.budget?.active() ? [...new Set(reviewers.filter((r) => !r.price).map((r) => r.model))] : []
		return { ...estimate, over: this.budget?.check(connections).over ?? [], unbudgeted }
	}

	/** A fixed configuration whose provider books every response to the usage history. */
	private async configFor(selection: ModelSelection, kind: UsageKind, repoId: string): Promise<RunConfig> {
		const config = await this.resolveRun(selection)
		if (!this.usage) return config
		const repo = this.store.read().repos[repoId]
		const ctx = {
			kind,
			repoId,
			repo: repo?.githubResolved ?? (repo ? basename(repo.root) : null),
			connectionId: config.connectionId,
			connection: config.connectionLabel,
		}
		return { ...config, provider: this.usage.meter(config.provider, ctx) }
	}

	/**
	 * Who would review with `choice`, without resolving credentials, to tell whether an earlier run's results can be
	 * carried into it. Null when the choice can't be used (the team is gone).
	 */
	reviewerPrint(choice: ReviewerChoice): ReviewerPrint | null {
		const levels = this.levels?.() ?? DEFAULT_LEVELS
		const l = this.models?.limits()
		const depth = l ? { relatedCode: l.relatedCode !== false, lookups: l.lookups !== false, verify: l.verify !== false } : null
		if (choice.kind === 'model') {
			const { connectionId, modelId } = choice.selection
			const persona = choice.persona ?? null
			const roles = passRoles(choice)
			return {
				promptVersion: PROMPT_VERSION,
				levels,
				depth,
				workers: roles.length
					? roles.map((r) => ({ connectionId, model: modelId, persona, rules: [...r.rules] }))
					: [{ connectionId, model: modelId, persona, rules: [...REVIEW_RULES] }],
			}
		}
		let team: ReviewTeam
		try {
			if (!this.teams) return null
			team = this.teams(choice.teamId)
		} catch {
			return null
		}
		return {
			promptVersion: PROMPT_VERSION,
			levels,
			depth,
			workers: team.members.map((m) => ({ connectionId: m.connectionId, model: m.modelId, persona: m.persona ?? null, rules: m.rules })),
		}
	}

	runsFor(repoId: string, reviewId: string): Array<AiRun> {
		return this.store.read().repos[repoId]?.aiRuns?.[reviewId] ?? []
	}

	/** Whether a run is starting or running, so an automatic review can wait for its turn. */
	get busy(): boolean {
		return !!this.active || this.starting
	}

	private assertIdle(): void {
		if (this.active?.background)
			throw new AppFail(
				'ai-busy',
				`An automatic review of ${this.active.background} is running. Try again when it finishes, or cancel it from that review.`,
			)
		if (this.active || this.starting) throw new AppFail('ai-busy', 'An AI review is already running.')
	}

	/** The finished run, once the active run with this id ends; null when it is not the active run. */
	whenDone(runId: string): Promise<AiRun> | null {
		return this.active?.handle.run.id === runId ? this.active.handle.done : null
	}

	async start(
		access: ComparisonAccess,
		reviewId: string,
		scope: AiScope,
		choice: ModelSelection | ReviewerChoice,
		// overBudget: you were told a daily or monthly budget is reached and chose to start anyway.
		options: { background?: string; carried?: RunInput['carried']; overBudget?: boolean } = {},
	): Promise<AiRun> {
		this.assertIdle()
		this.starting = true
		const reviewer: ReviewerChoice = 'kind' in choice ? choice : { kind: 'model', selection: choice }
		let config: RunConfig
		let team: {
			id: string
			name: string
			members: Array<{
				id: string
				role: string
				rules: ReviewTeam['members'][number]['rules']
				persona: PersonaId | null
				config: RunConfig
			}>
		} | null = null
		try {
			if (reviewer.kind === 'model') {
				config = await this.configFor(reviewer.selection, 'review', access.comparison.repoId)
				const roles = passRoles(reviewer)
				const only = reviewer.bugsOnly ? BUGS_ONLY_RULES : null
				if (roles.length)
					team = {
						id: only ? 'bugs-only' : 'focused-passes',
						name: only ? (reviewer.passes ? 'Bugs & security, focused passes' : 'Bugs & security only') : 'Focused passes',
						members: roles.map((r) => ({
							id: r.id,
							role: r.role,
							rules: [...r.rules],
							persona: reviewer.persona ?? null,
							config,
						})),
					}
			} else {
				if (!this.teams) throw new AppFail('ai-unavailable', 'Review teams are not available.')
				const t = this.teams(reviewer.teamId)
				if (!t.members.length) throw new AppFail('invalid-input', `${t.name} has no members.`)
				// Every member's credential and model are captured before anything is sent, so a bad member fails the start, not the run.
				const members = []
				for (const m of t.members) {
					try {
						members.push({
							id: m.id,
							role: m.role,
							rules: m.rules,
							persona: m.persona ?? null,
							config: await this.configFor({ connectionId: m.connectionId, modelId: m.modelId }, 'review', access.comparison.repoId),
						})
					} catch (e) {
						throw new AppFail('ai-unavailable', `${m.role}: ${e instanceof Error ? e.message : String(e)}`)
					}
				}
				team = { id: t.id, name: t.name, members }
				config = members[0].config
			}
		} catch (e) {
			this.starting = false
			if (e instanceof AppFail) throw e
			throw new AppFail('ai-unavailable', e instanceof Error ? e.message : String(e))
		}
		const used = team ? team.members.map((m) => m.config) : [config]
		const budget = this.budget?.check(connectionsOf(used), options.overBudget === true) ?? null
		if (budget?.over.length && !options.overBudget) {
			this.starting = false
			throw new AppFail('over-budget', budget.over.join(' '))
		}
		return this.launch(
			access,
			reviewId,
			{
				scope,
				previousFindings: this.runsFor(access.comparison.repoId, reviewId).flatMap((r) => r.findings),
				carried: options.carried ?? null,
			},
			{
				...this.runOptions(config),
				budget: budget?.limit ?? null,
				persona: reviewer.kind === 'model' ? (reviewer.persona ?? null) : null,
				team: team
					? {
							id: team.id,
							name: team.name,
							members: team.members.map((m) => ({
								id: m.id,
								role: m.role,
								rules: m.rules,
								persona: m.persona,
								provider: m.config.provider,
								provenance: { connectionId: m.config.connectionId, connectionLabel: m.config.connectionLabel, endpoint: m.config.endpoint },
							})),
						}
					: undefined,
			},
			team ? team.members.map((m) => m.config.connectionId) : [config.connectionId],
			options.background ?? null,
		)
	}

	/**
	 * Asks a finished run's rules again, only on the requests that did not cover them, each with the reviewer that owned
	 * it (same connection and model). The answers merge into the same run.
	 */
	async retryRules(access: ComparisonAccess, reviewId: string, runId: string, rules: Array<ReviewRule>): Promise<AiRun> {
		this.assertIdle()
		const { comparison } = access
		const runs = this.runsFor(comparison.repoId, reviewId)
		const at = runs.findIndex((r) => r.id === runId)
		const run = runs[at]
		if (!run) throw new AppFail('not-found', 'That AI review run no longer exists.')
		if (run.status === 'running') throw new AppFail('ai-busy', 'That AI review is still running.')
		if (run.baseSha !== comparison.baseSha || run.headSha !== comparison.headSha)
			throw new AppFail('invalid-input', 'That run reviewed different commits. Run the review again.')
		const asked = [...new Set(rules)]
		if (!asked.length) throw new AppFail('invalid-input', 'Choose a rule to retry.')
		if (!run.limitsUsed)
			throw new AppFail('invalid-input', 'This run does not record which requests covered each rule. Run the review again.')
		// Each owning reviewer's connection and model, by member id (null for a single-model run).
		const owners = new Map<string | null, { connectionId: string; modelId: string }>()
		const wanted: Array<ReviewRule> = []
		// Several rules at once (Retry all) skip the ones with nothing left to ask; one rule says why it cannot be retried.
		let skipped: AppFail | null = null
		for (const rule of asked) {
			const ev = run.evaluation?.find((e) => e.rule === rule)
			const answered = ev && answeredRequests(run, ev)
			const member = ev?.checkedBy ? run.team?.members.find((m) => m.id === ev.checkedBy) : undefined
			const connectionId = member?.connectionId ?? run.connectionId
			const why =
				!ev || !answered
					? new AppFail('invalid-input', 'This run does not record which requests covered each rule. Run the review again.')
					: answered.length >= (member ? member.requestsTotal : run.coverage.batchesTotal)
						? new AppFail('invalid-input', `${rule} was already checked in every request.`)
						: !connectionId
							? new AppFail('invalid-input', 'This run does not record its connection. Run the review again.')
							: null
			if (why) {
				skipped ??= why
				continue
			}
			wanted.push(rule)
			owners.set(member?.id ?? null, { connectionId: connectionId!, modelId: member?.model ?? run.model })
		}
		if (!wanted.length) throw skipped!
		this.starting = true
		const configs = new Map<string | null, RunConfig>()
		try {
			for (const [id, selection] of owners) {
				try {
					configs.set(id, await this.configFor(selection, 'review', comparison.repoId))
				} catch (e) {
					const role = id ? run.team?.members.find((m) => m.id === id)?.role : null
					const message = e instanceof Error ? e.message : String(e)
					throw e instanceof AppFail && !role ? e : new AppFail('ai-unavailable', role ? `${role}: ${message}` : message)
				}
			}
		} catch (e) {
			this.starting = false
			throw e
		}
		const first = configs.values().next().value!
		return this.launch(
			access,
			reviewId,
			{
				scope: run.scope,
				previousFindings: runs.slice(0, at).flatMap((r) => r.findings),
				retry: { run, rules: wanted, providers: new Map([...configs].map(([id, c]) => [id, c.provider])) },
			},
			// A retry only stops at the per-run budget: a daily or monthly cap already reached would stop it at its first answer.
			{ ...this.runOptions(first), budget: this.budget?.check(connectionsOf([...configs.values()]), true).limit ?? null },
			[...new Set([...configs.values()].map((c) => c.connectionId))],
		)
	}

	/**
	 * Asks the model that raised a finding (same connection and model, or the team member that raised it) a question
	 * about it. The question is saved first, so it shows while the answer is pending; a failed answer is saved as an
	 * error message instead of being lost.
	 */
	async ask(
		access: ComparisonAccess,
		reviewId: string,
		findingId: string,
		question: string,
		picked: ModelSelection | null = null,
	): Promise<AiRun> {
		const { comparison } = access
		const repoId = comparison.repoId
		const text = question.trim()
		if (!text) throw new AppFail('invalid-input', 'Write a question first.')
		if (text.length > MAX_QUESTION_CHARS) throw new AppFail('invalid-input', `Questions are limited to ${MAX_QUESTION_CHARS} characters.`)
		const run = this.runsFor(repoId, reviewId).find((r) => r.findings.some((x) => x.id === findingId))
		const finding = run?.findings.find((x) => x.id === findingId)
		if (!run || !finding) throw new AppFail('not-found', 'That finding no longer exists.')
		if (run.status === 'running') throw new AppFail('ai-busy', 'Wait for this review run to finish before asking about its findings.')
		if ((finding.thread?.length ?? 0) >= MAX_THREAD_MESSAGES)
			throw new AppFail('invalid-input', 'This conversation is full. Add your conclusion to the comment instead.')
		// The model you picked for questions; without one, the model that raised the finding.
		const member = finding.memberId ? run.team?.members.find((m) => m.id === finding.memberId) : undefined
		const connectionId = picked?.connectionId ?? member?.connectionId ?? run.connectionId
		const modelId = picked?.modelId ?? member?.model ?? run.model
		if (!connectionId) throw new AppFail('invalid-input', 'This run does not record which model raised the finding. Run the review again.')
		let config: RunConfig
		try {
			config = await this.configFor({ connectionId, modelId }, 'question', repoId)
		} catch (e) {
			throw new AppFail(
				'ai-unavailable',
				`${picked ? 'The model' : 'The model that raised this finding'} (${modelId}) is not available: ${e instanceof Error ? e.message : String(e)}`,
			)
		}
		const history = finding.thread ?? []
		await this.addMessage(repoId, reviewId, run.id, findingId, { id: randomUUID(), role: 'you', text, at: new Date().toISOString() })
		const fileKey = finding.anchor.fileKey
		const inChange = comparison.files.some((x) => x.key === fileKey)
		const patch = inChange ? await access.loadPatch(fileKey).catch(() => null) : null
		const lines = inChange && finding.anchor.side === 'new' ? await access.loadFileLines(fileKey).catch(() => null) : null
		let reply: FindingMessage
		try {
			const response = await config.provider.review(
				buildAskRequest(
					{ finding, question: text, history, patch, fileLines: lines?.kind === 'text' ? lines.lines : null },
					modelId !== (member?.model ?? run.model),
				),
				AbortSignal.timeout(180_000),
			)
			const a = parseAnswer(response.output)
			reply = {
				id: randomUUID(),
				role: 'ai',
				text: a.answer,
				at: new Date().toISOString(),
				verdict: a.verdict,
				level: a.level,
				model: modelId,
			}
		} catch (e) {
			const why = e instanceof Error ? e.message : String(e)
			reply = { id: randomUUID(), role: 'ai', text: `No answer: ${why}`, at: new Date().toISOString(), model: modelId, error: true }
		}
		return this.addMessage(repoId, reviewId, run.id, findingId, reply)
	}

	/**
	 * Double-checks one finding of any level on demand: the request the run sends for blocking findings, with the code
	 * around it rebuilt from the diff, as Ask AI reads it. The verdict replaces the one shown; earlier ones are kept.
	 */
	verify(access: ComparisonAccess, reviewId: string, findingId: string, picked: ModelSelection | null = null): Promise<AiRun> {
		return this.onDemand(
			access,
			reviewId,
			findingId,
			picked,
			'verify',
			async (c): Promise<FindingVerification> => {
				const who = { model: c.modelId, memberId: c.memberId, onDemand: true }
				try {
					const tools = c.tools(buildVerifyRequest(c.finding, null, [], undefined, c.around))
					const response = await c.config.provider.review(
						buildVerifyRequest(c.finding, null, [], tools, c.around),
						AbortSignal.timeout(300_000),
					)
					return checkedCitations({ ...parseVerification(response.output), ...who }, c.seen, tools)
				} catch (e) {
					const why = e instanceof Error ? e.message : String(e)
					return { verdict: 'unsure', reason: `Not double-checked: ${why}`, level: null, checked: [], ...who, error: true }
				}
			},
			(f, result) => {
				const prev = f.verification
				const earlier = prev ? [(({ earlier: _, ...x }) => x)(prev), ...(prev.earlier ?? [])].slice(0, MAX_EARLIER_CHECKS) : []
				f.verification = { ...result, ...(earlier.length ? { earlier } : {}) }
			},
		)
	}

	/**
	 * Asks whether a finding of the earlier snapshot that run `runId` did not raise again is still in the code: the
	 * double-check, told the code changed since and given the code about where the finding would be now. The model you
	 * picked for questions answers, else the run's. The verdict is saved on the gone finding; nothing else changes.
	 */
	checkFixed(
		access: ComparisonAccess,
		reviewId: string,
		runId: string,
		findingId: string,
		picked: ModelSelection | null = null,
	): Promise<AiRun> {
		const since = this.runsFor(access.comparison.repoId, reviewId).find((r) => r.id === runId)?.history?.from.headSha ?? null
		return this.onDemand(
			access,
			reviewId,
			findingId,
			picked,
			'verify',
			async (c): Promise<FindingVerification> => {
				const who = { model: c.modelId, memberId: null, onDemand: true }
				try {
					const tools = c.tools(buildVerifyRequest(c.finding, null, [], undefined, c.around, since))
					const response = await c.config.provider.review(
						buildVerifyRequest(c.finding, null, [], tools, c.around, since),
						AbortSignal.timeout(300_000),
					)
					return checkedCitations({ ...parseVerification(response.output), ...who }, c.seen, tools)
				} catch (e) {
					const why = e instanceof Error ? e.message : String(e)
					return { verdict: 'unsure', reason: `Not checked: ${why}`, level: null, checked: [], ...who, error: true }
				}
			},
			(_, result, gone) => {
				if (gone) gone.check = result
			},
			runId,
		)
	}

	/**
	 * Writes a test that should fail on the head commit while the finding holds, in the style of the tests that import
	 * its file. It replaces the one shown. The test is only stored on the finding: nothing is written to disk or run.
	 */
	writeTest(access: ComparisonAccess, reviewId: string, findingId: string, picked: ModelSelection | null = null): Promise<AiRun> {
		return this.onDemand(
			access,
			reviewId,
			findingId,
			picked,
			'test',
			async (c): Promise<FindingReproducer> => {
				const at = new Date().toISOString()
				try {
					const examples = (await access.testExamples?.(c.finding.anchor.fileKey).catch(() => [])) ?? []
					const tools = c.tools(buildReproducerRequest(c.finding, c.around, examples, undefined))
					const response = await c.config.provider.review(
						buildReproducerRequest(c.finding, c.around, examples, tools),
						AbortSignal.timeout(300_000),
					)
					return { ...parseReproducer(response.output), model: c.modelId, at }
				} catch (e) {
					const why = e instanceof Error ? e.message : String(e)
					return { path: null, code: null, asserts: `No test written: ${why}`, model: c.modelId, at, error: true }
				}
			},
			(f, result) => {
				f.reproducer = result
			},
		)
	}

	/**
	 * Sends one request about a finding of a finished run and saves its result on the finding. The model you picked for
	 * questions answers, else the one that raised the finding. It gets the code around the finding and, when the run had
	 * them, lookups; MCP tools are never offered, because whether the run's text came from outsiders (which turns them
	 * off) is not stored. `goneFrom`: the finding is one run `goneFrom` did not raise again (see FindingHistory), asked
	 * about where it would be now; the run's model answers it, since the one that raised it ran on another snapshot.
	 */
	private async onDemand<T>(
		access: ComparisonAccess,
		reviewId: string,
		findingId: string,
		picked: ModelSelection | null,
		kind: 'verify' | 'test',
		ask: (c: {
			finding: Finding
			config: RunConfig
			modelId: string
			memberId: string | null
			around: Array<string>
			seen: Array<SeenLines> // the lines `around` shows
			tools: (draft: ProviderRequest) => ReviewTools | undefined
		}) => Promise<T>,
		save: (f: Finding, result: T, gone: GoneFinding | null) => void,
		goneFrom: string | null = null,
	): Promise<AiRun> {
		const { comparison } = access
		const repoId = comparison.repoId
		const goneIn = (r: AiRun | undefined) => (goneFrom ? r?.history?.gone.find((g) => g.finding.id === findingId) : undefined)
		const runs = this.runsFor(repoId, reviewId)
		const run = goneFrom ? runs.find((r) => r.id === goneFrom) : runs.find((r) => r.findings.some((x) => x.id === findingId))
		const gone = goneIn(run)
		const finding = goneFrom
			? gone && { ...gone.finding, anchor: gone.at ?? gone.finding.anchor }
			: run?.findings.find((x) => x.id === findingId)
		if (!run || !finding) throw new AppFail('not-found', 'That finding no longer exists.')
		if (run.status === 'running') throw new AppFail('ai-busy', 'Wait for this review run to finish first.')
		const busy = `${goneFrom ? 'check' : kind}:${findingId}`
		if (this.onDemandBusy.has(busy))
			throw new AppFail(
				'ai-busy',
				kind === 'verify' ? 'This finding is already being checked.' : 'A test for this finding is already being written.',
			)
		const member = finding.memberId && !goneFrom ? run.team?.members.find((m) => m.id === finding.memberId) : undefined
		const connectionId = picked?.connectionId ?? member?.connectionId ?? run.connectionId
		const modelId = picked?.modelId ?? member?.model ?? run.model
		if (!connectionId) throw new AppFail('invalid-input', 'This run does not record which model raised the finding. Run the review again.')
		let config: RunConfig
		try {
			config = await this.configFor({ connectionId, modelId }, kind, repoId)
		} catch (e) {
			throw new AppFail('ai-unavailable', `The model (${modelId}) is not available: ${e instanceof Error ? e.message : String(e)}`)
		}
		this.onDemandBusy.add(busy)
		let result: T
		try {
			const fileKey = finding.anchor.fileKey
			const inChange = comparison.files.some((f) => f.key === fileKey)
			const patch = inChange ? await access.loadPatch(fileKey).catch(() => null) : null
			const lines = inChange && finding.anchor.side === 'new' ? await access.loadFileLines(fileKey).catch(() => null) : null
			const l = config.provider.limits
			result = await ask({
				finding,
				config,
				modelId,
				memberId: picked ? null : (member?.id ?? null),
				around: codeAround(finding, patch, lines?.kind === 'text' ? lines.lines : null),
				seen: seenAround(finding, patch, lines?.kind === 'text' ? lines.lines : null),
				// Lookups get what the window has left after the request, never more than a high-risk review request gets.
				tools: (draft) => {
					const room =
						capacityChars(l.contextWindow, outputBudget(l), draft.instructions.length + JSON.stringify(TOOL_DEFINITIONS).length) -
						draft.input.length
					return run.limitsUsed?.lookups === true && access.tools && room >= 2000
						? access.tools({ maxCalls: LOOKUPS_BY_RISK.high.maxCalls, maxChars: Math.min(LOOKUPS_BY_RISK.high.maxChars, room) }, null)
						: undefined
				},
			})
		} finally {
			this.onDemandBusy.delete(busy)
		}
		let saved: AiRun | null = null
		await this.store.update((d) => {
			const r = d.repos[repoId]?.aiRuns?.[reviewId]?.find((x) => x.id === run.id)
			const g = goneIn(r)
			const f = goneFrom ? g?.finding : r?.findings.find((x) => x.id === findingId)
			if (!r || !f) return
			save(f, result, g ?? null)
			saved = r
		})
		if (!saved) throw new AppFail('not-found', 'That finding no longer exists.')
		const out = structuredClone(saved as AiRun)
		this.notify(out)
		return out
	}

	/**
	 * Asks `selection`'s model a question about lines of code you selected (or a whole file), with the change around them
	 * and, when the limits allow, lookups in the reviewed commits. `questionId` continues an earlier conversation about
	 * the same lines. The question is saved first; a failed answer is saved as an error message instead of being lost.
	 */
	async askCode(
		access: ComparisonAccess,
		reviewId: string,
		anchor: Anchor,
		question: string,
		questionId: string | null,
		selection: ModelSelection,
	): Promise<Array<CodeQuestion>> {
		const repoId = access.comparison.repoId
		const text = question.trim()
		if (!text) throw new AppFail('invalid-input', 'Write a question first.')
		if (text.length > MAX_CODE_QUESTION_CHARS)
			throw new AppFail('invalid-input', `Questions are limited to ${MAX_CODE_QUESTION_CHARS} characters.`)
		if (!access.comparison.files.some((f) => f.key === anchor.fileKey))
			throw new AppFail('not-found', 'That file is not part of this change.')
		const earlier = questionId ? this.questionsFor(repoId, reviewId).find((q) => q.id === questionId) : undefined
		if (questionId && !earlier) throw new AppFail('not-found', 'That conversation no longer exists.')
		if ((earlier?.messages.length ?? 0) >= MAX_CODE_MESSAGES)
			throw new AppFail('invalid-input', 'This conversation is full. Select the lines again to start a new one.')
		let config: RunConfig
		try {
			config = await this.configFor(selection, 'explain', repoId)
		} catch (e) {
			throw new AppFail('ai-unavailable', e instanceof Error ? e.message : String(e))
		}
		const id = earlier?.id ?? randomUUID()
		const at = earlier?.anchor ?? anchor
		const history = earlier?.messages ?? []
		await this.addCodeMessage(repoId, reviewId, id, at, { id: randomUUID(), role: 'you', text, at: new Date().toISOString() })
		const patch = await access.loadPatch(at.fileKey).catch(() => null)
		const lines = await access.loadFileLines(at.fileKey).catch(() => null)
		// The full file is only one side; the old side's lines come from the excerpt and the diff.
		const fileLines = lines?.kind === 'text' && at.side !== 'old' ? lines.lines : null
		const tools = config.limits.lookups !== false && access.tools ? access.tools(EXPLAIN_LOOKUPS) : undefined
		const pr = access.comparison.pr ? { title: access.comparison.pr.title, body: access.comparison.pr.body } : null
		let reply: CodeMessage
		try {
			const response = await config.provider.review(
				buildExplainRequest({ anchor: at, question: text, history, patch, fileLines, pr, tools }),
				AbortSignal.timeout(180_000),
			)
			reply = { id: randomUUID(), role: 'ai', text: parseExplain(response.output), at: new Date().toISOString(), model: selection.modelId }
		} catch (e) {
			const why = e instanceof Error ? e.message : String(e)
			reply = {
				id: randomUUID(),
				role: 'ai',
				text: `No answer: ${why}`,
				at: new Date().toISOString(),
				model: selection.modelId,
				error: true,
			}
		}
		return this.addCodeMessage(repoId, reviewId, id, at, reply)
	}

	questionsFor(repoId: string, reviewId: string): Array<CodeQuestion> {
		return this.store.read().repos[repoId]?.reviews[reviewId]?.questions ?? []
	}

	async deleteCodeQuestion(repoId: string, reviewId: string, questionId: string): Promise<Array<CodeQuestion>> {
		await this.store.update((d) => {
			const r = d.repos[repoId]?.reviews[reviewId]
			if (r?.questions) r.questions = r.questions.filter((q) => q.id !== questionId)
		})
		return structuredClone(this.questionsFor(repoId, reviewId))
	}

	/** Appends to a conversation about code in the stored review, creating it on the first message. */
	private async addCodeMessage(repoId: string, reviewId: string, id: string, anchor: Anchor, m: CodeMessage): Promise<Array<CodeQuestion>> {
		await this.store.update((d) => {
			const r = d.repos[repoId]?.reviews[reviewId]
			if (!r) return
			const list = (r.questions ??= [])
			const q = list.find((x) => x.id === id)
			if (q) q.messages.push(m)
			else list.push({ id, anchor, messages: [m] })
		})
		return structuredClone(this.questionsFor(repoId, reviewId))
	}

	/** Appends to a finding's thread in the stored run (never a stale copy), then notifies. */
	private async addMessage(repoId: string, reviewId: string, runId: string, findingId: string, m: FindingMessage): Promise<AiRun> {
		let saved: AiRun | null = null
		await this.store.update((d) => {
			const run = d.repos[repoId]?.aiRuns?.[reviewId]?.find((r) => r.id === runId)
			const f = run?.findings.find((x) => x.id === findingId)
			if (!run || !f) return
			f.thread = [...(f.thread ?? []), m]
			saved = run
		})
		if (!saved) throw new AppFail('not-found', 'That finding no longer exists.')
		const run = structuredClone(saved as AiRun)
		this.notify(run)
		return run
	}

	private runOptions(config: RunConfig): RunnerOptions {
		return {
			provider: config.provider,
			limits: config.limits,
			levels: config.levels,
			provenance: { connectionId: config.connectionId, connectionLabel: config.connectionLabel, endpoint: config.endpoint },
			concurrency: this.concurrency,
			maxAttempts: 5,
			backoffMs: defaultBackoff,
		}
	}

	private async launch(
		access: ComparisonAccess,
		reviewId: string,
		input: Pick<RunInput, 'scope' | 'previousFindings' | 'retry' | 'carried'>,
		options: RunnerOptions,
		connectionIds: Array<string>,
		background: string | null = null,
	): Promise<AiRun> {
		const { comparison } = access
		const repoId = comparison.repoId
		const keys =
			input.scope.kind === 'file'
				? [input.scope.fileKey]
				: input.scope.kind === 'files'
					? input.scope.fileKeys
					: comparison.files.map((f) => f.key)
		// MCP tools ride on the lookups, so they are only connected when the run offers lookups.
		const lookups = input.retry ? input.retry.run.limitsUsed?.lookups === true : options.limits.lookups !== false
		let external: ExternalTools | null = null
		if (lookups && access.tools && access.openExternal) {
			try {
				external = await access.openExternal(AbortSignal.timeout(30_000))
			} catch (e) {
				external = null
				console.warn('MCP servers could not be connected:', e)
			}
		}
		const tools = access.tools
		// An image that can't be read (removed from disk) leaves the run without images rather than failing it.
		const images = await (access.contextImages?.() ?? Promise.resolve([])).catch((e: unknown) => {
			console.warn('Context images could not be read:', e)
			return []
		})
		// A retry compares with the run its run was compared with, and only if it was.
		const pinned = input.retry ? (input.retry.run.history?.from ?? null) : null
		const history =
			input.retry && !pinned
				? null
				: await (access.findingBaseline?.(pinned) ?? Promise.resolve(null)).catch((e: unknown) => {
						console.warn('The earlier snapshot could not be compared:', e)
						return null
					})
		const handle = startRun(
			{
				...input,
				history,
				reviewId,
				comparison,
				loadSources: () => loadSources(access, keys),
				loadRelated: access.findRelated?.bind(access),
				loadFacts: access.loadFacts?.bind(access),
				loadBackground: access.loadBackground?.bind(access),
				context: access.reviewContext?.() ?? null,
				images,
				tools: tools ? (budget, mcp) => tools.call(access, budget, mcp ? external : null) : undefined,
				external,
				automatic: background !== null,
				decisions: access.pastDecisions?.() ?? [],
				earlier: input.retry ? (input.retry.run.earlier ?? null) : (access.earlierLimitations?.() ?? null),
			},
			options,
			(run) => void this.persist(repoId, background ? { ...run, auto: true } : run),
		)
		this.active = { handle, repoId, reviewId, connectionIds, background }
		this.starting = false
		void handle.done.finally(() => {
			if (this.active?.handle === handle) this.active = null
			void external?.close()
		})
		if (background) handle.run.auto = true
		await this.persist(repoId, handle.run)
		return handle.run
	}

	/** Cancels the active run if it uses this connection (disconnected, endpoint changed or key replaced). */
	cancelForConnection(connectionId: string): void {
		if (this.active?.connectionIds.includes(connectionId)) this.active.handle.cancel()
	}

	cancel(runId: string): boolean {
		if (!this.active || this.active.handle.run.id !== runId) return false
		this.active.handle.cancel()
		return true
	}

	/**
	 * Cancels the active run unless it belongs to `reviewId`. Called whenever a repository or comparison is opened. An
	 * automatic review runs in the background, so it keeps going; cancel it from its own review.
	 */
	cancelUnless(reviewId: string | null): void {
		if (this.active && !this.active.background && this.active.reviewId !== reviewId) this.active.handle.cancel()
	}

	async flush(): Promise<void> {
		const a = this.active
		if (!a) return
		a.handle.cancel()
		await a.handle.done.catch(() => {})
		await this.store.flush()
	}

	/** Stores first, then notifies, so a finding is always saved before the renderer can link a comment to it. */
	private persist(repoId: string, run: AiRun): Promise<void> {
		return this.store
			.update((d) => {
				const repo = d.repos[repoId]
				if (!repo) return
				const list = (repo.aiRuns[run.reviewId] ??= [])
				const i = list.findIndex((r) => r.id === run.id)
				if (i >= 0) list[i] = run
				else list.push(run)
				// ponytail: oldest unreferenced runs are dropped past 50 per review; archive instead if history matters
				const review = repo.reviews[run.reviewId]
				const used = new Set<string>([
					...Object.keys(review?.findingDecisions ?? {}),
					...(review?.comments ?? []).flatMap((c) => (c.findingId ? [c.findingId] : [])),
					...(review?.drafts ?? []).flatMap((x) => (x.findingId ? [x.findingId] : [])),
				])
				const referencedIds = new Set(list.flatMap((r) => r.findings.map((f) => f.repeatOf).filter((x): x is string => !!x)))
				for (let i = 0; list.length > MAX_RUNS_PER_REVIEW && i < list.length - 1;) {
					const r = list[i]
					if (r.findings.some((f) => used.has(f.id) || referencedIds.has(f.id))) i++
					else list.splice(i, 1)
				}
			})
			.then(() => this.notify(run))
			.catch((e) => console.error('[ai] could not persist run', e instanceof Error ? e.message : e))
	}
}

/**
 * The passes one model runs as. Focused passes: the same model as each default role, so every pass gets only its rules
 * and files. Bugs only: one pass (or the passes that own them) with just those rules, so only they are asked and shown.
 * None: one request set with every rule.
 */
/** An on-demand check with the references in its answer to lines it was never shown or looked up (see citations.ts). */
function checkedCitations(v: FindingVerification, around: Array<SeenLines>, tools: ReviewTools | undefined): FindingVerification {
	return withUnread(v, unreadRefs(verificationTexts(v), new Seen().lines([...around, ...(tools?.log.seen ?? [])])))
}

/** Each connection a run uses, once. */
function connectionsOf(configs: Array<RunConfig>): Array<{ id: string; label: string }> {
	return [...new Map(configs.map((c) => [c.connectionId, { id: c.connectionId, label: c.connectionLabel }])).values()]
}

function passRoles(
	reviewer: Extract<ReviewerChoice, { kind: 'model' }>,
): Array<{ id: string; role: string; rules: ReadonlyArray<ReviewRule> }> {
	const only = reviewer.bugsOnly ? BUGS_ONLY_RULES : null
	return reviewer.passes
		? DEFAULT_TEAM_ROLES.map((r) => ({ ...r, rules: r.rules.filter((x) => !only || only.includes(x)) })).filter((r) => r.rules.length)
		: only
			? [{ id: 'bugs-only', role: 'Bugs & security', rules: only }]
			: []
}

async function loadSources(access: ComparisonAccess, keys: Array<string>): Promise<Array<FileSource>> {
	const out: Array<FileSource> = []
	for (const key of keys) {
		const file = access.comparison.files.find((f) => f.key === key)
		if (!file) continue
		const patch = await access.loadPatch(key)
		const fullText = patch.kind === 'text' && file.oldPath && file.newPath ? await access.loadFileLines(key) : null
		out.push({ file, patch, fullText })
	}
	return out
}
