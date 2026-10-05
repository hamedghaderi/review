import { randomUUID } from 'node:crypto'
import {
	DEFAULT_TEAM_ROLES,
	type AiRun,
	type AiScope,
	type Comparison,
	type FileLinesResult,
	type FindingMessage,
	type ModelSelection,
	type PatchResult,
	type ReviewerChoice,
	type ReviewRule,
	type ReviewTeam,
	type PastDecision,
} from '../../shared/types.ts'
import { AppFail } from '../git.ts'
import type { ReviewStore } from '../store.ts'
import type { RunConfig } from './connections.ts'
import type { FileSource } from './context.ts'
import type { RelatedResult } from './related.ts'
import type { FactsResult } from './facts.ts'
import type { ExternalTools, LookupBudget, ReviewTools } from './lookup.ts'
import { buildAskRequest, MAX_QUESTION_CHARS, MAX_THREAD_MESSAGES, parseAnswer } from './ask.ts'
import { answeredRequests, defaultBackoff, startRun, type RunHandle, type RunInput, type RunnerOptions } from './runner.ts'

/** Resolves a model selection into a fixed run configuration (adapter + captured credential). */
export type RunConfigSource = (selection: ModelSelection) => Promise<RunConfig>
export type TeamSource = (teamId: string) => ReviewTeam

export interface ComparisonAccess {
	comparison: Comparison
	loadPatch(fileKey: string): Promise<PatchResult>
	loadFileLines(fileKey: string): Promise<FileLinesResult>
	findRelated?(sources: Array<FileSource>, signal: AbortSignal): Promise<RelatedResult>
	loadFacts?(sources: Array<FileSource>, signal: AbortSignal): Promise<FactsResult>
	/** Findings the reviewer dismissed on earlier runs of this pull request or branch, newest first. */
	pastDecisions?(): Array<PastDecision>
	/** Read-only lookups in the comparison's two commits, for one review request, plus the run's MCP tools if any. */
	tools?(budget: LookupBudget, external?: ExternalTools | null): ReviewTools
	/** Connects the enabled MCP servers for one run; null when none is enabled. */
	openExternal?(signal: AbortSignal): Promise<ExternalTools | null>
}

const MAX_RUNS_PER_REVIEW = 50

/**
 * Owns the single active AI run. Every update is persisted against the run's own review, so results can never
 * land in a different comparison; switching comparisons cancels the run.
 */
export class AiController {
	private active: { handle: RunHandle; repoId: string; reviewId: string; connectionIds: Array<string> } | null = null
	private teams: TeamSource | null = null
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

	runsFor(repoId: string, reviewId: string): Array<AiRun> {
		return this.store.read().repos[repoId]?.aiRuns?.[reviewId] ?? []
	}

	async start(access: ComparisonAccess, reviewId: string, scope: AiScope, choice: ModelSelection | ReviewerChoice): Promise<AiRun> {
		if (this.active || this.starting) throw new AppFail('ai-busy', 'An AI review is already running.')
		this.starting = true
		const reviewer: ReviewerChoice = 'kind' in choice ? choice : { kind: 'model', selection: choice }
		let config: RunConfig
		let team: {
			id: string
			name: string
			members: Array<{ id: string; role: string; rules: ReviewTeam['members'][number]['rules']; config: RunConfig }>
		} | null = null
		try {
			if (reviewer.kind === 'model') {
				config = await this.resolveRun(reviewer.selection)
				// Focused passes: the same model as each default role, so every pass gets only its rules and files.
				if (reviewer.passes)
					team = {
						id: 'focused-passes',
						name: 'Focused passes',
						members: DEFAULT_TEAM_ROLES.map((r) => ({ id: r.id, role: r.role, rules: [...r.rules], config })),
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
							config: await this.resolveRun({ connectionId: m.connectionId, modelId: m.modelId }),
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
		return this.launch(
			access,
			reviewId,
			{ scope, previousFindings: this.runsFor(access.comparison.repoId, reviewId).flatMap((r) => r.findings) },
			{
				...this.runOptions(config),
				team: team
					? {
							id: team.id,
							name: team.name,
							members: team.members.map((m) => ({
								id: m.id,
								role: m.role,
								rules: m.rules,
								provider: m.config.provider,
								provenance: { connectionId: m.config.connectionId, connectionLabel: m.config.connectionLabel, endpoint: m.config.endpoint },
							})),
						}
					: undefined,
			},
			team ? team.members.map((m) => m.config.connectionId) : [config.connectionId],
		)
	}

	/**
	 * Asks a finished run's rules again, only on the requests that did not cover them, each with the reviewer that owned
	 * it (same connection and model). The answers merge into the same run.
	 */
	async retryRules(access: ComparisonAccess, reviewId: string, runId: string, rules: Array<ReviewRule>): Promise<AiRun> {
		if (this.active || this.starting) throw new AppFail('ai-busy', 'An AI review is already running.')
		const { comparison } = access
		const runs = this.runsFor(comparison.repoId, reviewId)
		const at = runs.findIndex((r) => r.id === runId)
		const run = runs[at]
		if (!run) throw new AppFail('not-found', 'That AI review run no longer exists.')
		if (run.status === 'running') throw new AppFail('ai-busy', 'That AI review is still running.')
		if (run.baseSha !== comparison.baseSha || run.headSha !== comparison.headSha)
			throw new AppFail('invalid-input', 'That run reviewed different commits. Run the review again.')
		const wanted = [...new Set(rules)]
		if (!wanted.length) throw new AppFail('invalid-input', 'Choose a rule to retry.')
		if (!run.limitsUsed)
			throw new AppFail('invalid-input', 'This run does not record which requests covered each rule. Run the review again.')
		// Each owning reviewer's connection and model, by member id (null for a single-model run).
		const owners = new Map<string | null, { connectionId: string; modelId: string }>()
		for (const rule of wanted) {
			const ev = run.evaluation?.find((e) => e.rule === rule)
			const answered = ev && answeredRequests(run, ev)
			if (!ev || !answered)
				throw new AppFail('invalid-input', 'This run does not record which requests covered each rule. Run the review again.')
			const member = ev.checkedBy ? run.team?.members.find((m) => m.id === ev.checkedBy) : undefined
			if (answered.length >= (member ? member.requestsTotal : run.coverage.batchesTotal))
				throw new AppFail('invalid-input', `${rule} was already checked in every request.`)
			const connectionId = member?.connectionId ?? run.connectionId
			if (!connectionId) throw new AppFail('invalid-input', 'This run does not record its connection. Run the review again.')
			owners.set(member?.id ?? null, { connectionId, modelId: member?.model ?? run.model })
		}
		this.starting = true
		const configs = new Map<string | null, RunConfig>()
		try {
			for (const [id, selection] of owners) {
				try {
					configs.set(id, await this.resolveRun(selection))
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
			this.runOptions(first),
			[...new Set([...configs.values()].map((c) => c.connectionId))],
		)
	}

	/**
	 * Asks the model that raised a finding (same connection and model, or the team member that raised it) a question
	 * about it. The question is saved first, so it shows while the answer is pending; a failed answer is saved as an
	 * error message instead of being lost.
	 */
	async ask(access: ComparisonAccess, reviewId: string, findingId: string, question: string): Promise<AiRun> {
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
		const member = finding.memberId ? run.team?.members.find((m) => m.id === finding.memberId) : undefined
		const connectionId = member?.connectionId ?? run.connectionId
		const modelId = member?.model ?? run.model
		if (!connectionId) throw new AppFail('invalid-input', 'This run does not record which model raised the finding. Run the review again.')
		let config: RunConfig
		try {
			config = await this.resolveRun({ connectionId, modelId })
		} catch (e) {
			throw new AppFail(
				'ai-unavailable',
				`The model that raised this finding (${modelId}) is not available: ${e instanceof Error ? e.message : String(e)}`,
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
				buildAskRequest({ finding, question: text, history, patch, fileLines: lines?.kind === 'text' ? lines.lines : null }),
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
			maxAttempts: 3,
			backoffMs: defaultBackoff,
		}
	}

	private async launch(
		access: ComparisonAccess,
		reviewId: string,
		input: Pick<RunInput, 'scope' | 'previousFindings' | 'retry'>,
		options: RunnerOptions,
		connectionIds: Array<string>,
	): Promise<AiRun> {
		const { comparison } = access
		const repoId = comparison.repoId
		const keys = input.scope.kind === 'file' ? [input.scope.fileKey] : comparison.files.map((f) => f.key)
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
		const handle = startRun(
			{
				...input,
				reviewId,
				comparison,
				loadSources: () => loadSources(access, keys),
				loadRelated: access.findRelated?.bind(access),
				loadFacts: access.loadFacts?.bind(access),
				tools: tools ? (budget) => tools.call(access, budget, external) : undefined,
				external,
				decisions: access.pastDecisions?.() ?? [],
			},
			options,
			(run) => void this.persist(repoId, run),
		)
		this.active = { handle, repoId, reviewId, connectionIds }
		this.starting = false
		void handle.done.finally(() => {
			if (this.active?.handle === handle) this.active = null
			void external?.close()
		})
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

	/** Cancels the active run unless it belongs to `reviewId`. Called whenever a repository or comparison is opened. */
	cancelUnless(reviewId: string | null): void {
		if (this.active && this.active.reviewId !== reviewId) this.active.handle.cancel()
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
