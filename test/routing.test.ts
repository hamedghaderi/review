import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FileSource } from '../src/main/ai/context.ts'
import { createFakeProvider, emptyEvaluation } from '../src/main/ai/fake.ts'
import type { ProviderRequest } from '../src/main/ai/provider.ts'
import type { RelatedResult } from '../src/main/ai/related.ts'
import { startRun, type RunnerOptions, type TeamRunMember } from '../src/main/ai/runner.ts'
import { ProviderError } from '../src/main/ai/provider.ts'
import {
	runMembers,
	type AiRun,
	type ChangedFile,
	type Comparison,
	type FileStatus,
	type ReviewRule,
	type ReviewTeam,
} from '../src/shared/types.ts'

function source(path: string, status: FileStatus = 'modified', lines = 1): FileSource {
	const file: ChangedFile = {
		key: path,
		status,
		oldPath: status === 'added' ? null : path,
		newPath: path,
		additions: lines,
		deletions: 0,
		binary: false,
		similarity: null,
	}
	const diff = Array.from({ length: lines }, (_, i) => ({
		kind: 'add' as const,
		oldNo: null,
		newNo: i + 1,
		text: `const v${i} = ${'x'.repeat(60)}`,
	}))
	return {
		file,
		patch: { kind: 'text', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines, section: '', lines: diff }] },
		fullText: null,
	} as FileSource
}

// Big enough that a small context window needs several requests for it.
const SOURCES = [
	source('src/auth/login.ts', 'modified', 120),
	source('src/ui/Button.tsx'),
	source('config/app.yml'),
	source('test/login.test.ts'),
	source('README.md'),
	source('dist/app.min.js'),
]
const COMPARISON: Comparison = {
	id: 'a..b',
	repoId: 'r',
	baseRef: 'main',
	baseTipSha: 'a',
	baseSha: 'a',
	headSha: 'b',
	headRef: 'topic',
	target: null,
	pr: null,
	files: SOURCES.map((s) => s.file),
}
const RELATED: RelatedResult = {
	snippets: [],
	symbols: 0,
	notes: [],
	importers: [{ fileKey: 'src/auth/login.ts', path: 'src/auth/login.ts', importers: [], tests: ['test/login.test.ts'], stale: [] }],
}

const RESIDUE: Array<ReviewRule> = ['residue-1', 'residue-2', 'residue-3', 'residue-4', 'residue-5', 'residue-6']
const TEAM: Array<{ id: string; role: string; rules: Array<ReviewRule>; window: number }> = [
	{ id: 'defects', role: 'Defects', rules: ['bug', 'error-handling'], window: 200_000 },
	{ id: 'security', role: 'Security', rules: ['security'], window: 13_000 },
	{
		id: 'callers',
		role: 'Callers & structure',
		rules: ['breaking-change', 'file-split', 'over-engineered', 'convention', 'misleading-name'],
		window: 200_000,
	},
	{ id: 'tests', role: 'Tests & leftover code', rules: ['test-value', ...RESIDUE], window: 200_000 },
]

type Seen = Map<string, Array<ProviderRequest>>

function team(seen: Seen, fail: Set<string> = new Set()): Array<TeamRunMember> {
	return TEAM.map((m) => ({
		id: m.id,
		role: m.role,
		rules: m.rules,
		provenance: { connectionId: `c-${m.id}`, connectionLabel: 'Gateway', endpoint: 'http://x' },
		provider: createFakeProvider({
			model: `${m.id}-model`,
			limits: { contextWindow: m.window, maxOutputTokens: 2000 },
			script: (req) => {
				seen.set(m.id, [...(seen.get(m.id) ?? []), req])
				if (fail.has(m.id)) return new ProviderError('server', 'server error (500)')
				return {
					findings: [],
					evaluation: emptyEvaluation().filter((e) => m.rules.includes(e.rule)),
					unexplained_files: [],
					limitations: [],
				}
			},
		}),
	}))
}

function options(members: Array<TeamRunMember>): RunnerOptions {
	return {
		provider: members[0].provider,
		limits: { contextLines: 3, maxBatchChars: 160_000, maxRunChars: 2_000_000, relatedCode: true, lookups: false },
		concurrency: 2,
		maxAttempts: 1,
		backoffMs: () => 0,
		team: { id: 't', name: 'Team', members },
	}
}

const input = (retry?: { run: AiRun; rule: ReviewRule }) => ({
	reviewId: 'rev',
	comparison: COMPARISON,
	scope: { kind: 'all' as const },
	loadSources: async () => SOURCES,
	loadRelated: async () => RELATED,
	previousFindings: [],
	retry,
})

const filesOf = (reqs: Array<ProviderRequest> | undefined): Array<string> =>
	[...new Set((reqs ?? []).flatMap((r) => r.batch.fileKeys))].sort()

test('team members get only the files their rules apply to, each in requests sized for its own model', async () => {
	const seen: Seen = new Map()
	const run = await startRun(input(), options(team(seen)), () => {}).done
	assert.equal(run.status, 'completed', run.errors.join('; '))

	assert.deepEqual(filesOf(seen.get('defects')), ['config/app.yml', 'src/auth/login.ts', 'src/ui/Button.tsx'])
	// Low-risk configuration, tests and docs are not security's business.
	assert.deepEqual(filesOf(seen.get('security')), ['src/auth/login.ts', 'src/ui/Button.tsx'])
	assert.deepEqual(filesOf(seen.get('callers')), ['config/app.yml', 'src/auth/login.ts', 'src/ui/Button.tsx'])
	// Tests, the changed code they import, and text residue can sit in: code and docs.
	assert.deepEqual(filesOf(seen.get('tests')), ['README.md', 'src/auth/login.ts', 'src/ui/Button.tsx', 'test/login.test.ts'])

	// Generated files go to nobody, and say why.
	const generated = run.coverage.files.find((f) => f.fileKey === 'dist/app.min.js')!
	assert.equal(generated.state, 'not-reviewable')
	assert.match(generated.reason ?? '', /Generated, vendored or binary/)

	// The small model gets small requests; the others are not cut down to its size.
	const member = (id: string) => run.team!.members.find((m) => m.id === id)!
	assert.ok(member('security').maxBatchChars! < member('defects').maxBatchChars!)
	assert.equal(run.limitsUsed?.maxBatchChars, member('security').maxBatchChars, 'excerpts are cut for the smallest member')
	assert.ok(member('security').requestsTotal > 1, 'the small model needs several requests')
	assert.equal(member('defects').requestsTotal, 1, 'a big model gets the whole change in one request')
	assert.equal(
		run.coverage.batchesTotal,
		TEAM.reduce((n, m) => n + member(m.id).requestsTotal, 0),
	)

	// Excerpt ids mean the same lines for every member.
	const ids = (id: string) => new Map(seen.get(id)!.flatMap((r) => r.batch.excerpts.map((e) => [e.id, `${e.file.key}:${e.new?.start}`])))
	for (const [id, where] of ids('security')) assert.equal(ids('defects').get(id), where)
	assert.ok(run.coverage.supplied.every((s) => s.memberId))

	// A member's overview says which files went to others instead of calling them missing.
	const overview = seen.get('security')![0].batch.overview
	assert.match(overview, /README\.md \(\+1 -0\) \[checked by other team members: not one this reviewer's rules apply to\]/)
	for (const f of run.coverage.files.filter((x) => x.fileKey !== 'dist/app.min.js')) assert.equal(f.state, 'reviewed', f.fileKey)
})

test('a failed member is retried on its own requests, rebuilt the same way', async () => {
	const seen: Seen = new Map()
	const first = await startRun(input(), options(team(seen, new Set(['security']))), () => {}).done
	assert.equal(first.status, 'partial')
	assert.equal(first.coverage.files.find((f) => f.fileKey === 'src/auth/login.ts')!.state, 'partial')
	assert.equal(first.coverage.files.find((f) => f.fileKey === 'README.md')!.state, 'reviewed', 'security was never given it')

	const again: Seen = new Map()
	const security = team(again).find((m) => m.id === 'security')!
	const run = await startRun(
		input({ run: first, rules: ['security'], providers: new Map([['security', security.provider]]) }),
		{ ...options([security]), provider: security.provider, team: undefined },
		() => {},
	).done
	assert.equal(run.status, 'completed', run.errors.join('; '))
	assert.equal(again.get('security')!.length, first.team!.members.find((m) => m.id === 'security')!.requestsTotal)
	assert.deepEqual(filesOf(again.get('security')), ['src/auth/login.ts', 'src/ui/Button.tsx'])
	for (const f of run.coverage.files.filter((x) => x.fileKey !== 'dist/app.min.js')) assert.equal(f.state, 'reviewed', f.fileKey)
})

test('a single reviewer still gets every file in shared requests', async () => {
	const seen: ProviderRequest[] = []
	const provider = createFakeProvider({
		script: (req) => {
			seen.push(req)
			return { findings: [], evaluation: emptyEvaluation(), unexplained_files: [], limitations: [] }
		},
	})
	const run = await startRun(input(), { ...options(team(new Map())), provider, team: undefined }, () => {}).done
	assert.equal(run.status, 'completed', run.errors.join('; '))
	assert.deepEqual(filesOf(seen), SOURCES.map((s) => s.file.key).sort())
	assert.ok(run.coverage.supplied.every((s) => s.memberId === undefined))
})

/** A team whose Defects member reports one blocking bug on login.ts; records which member is asked to double-check it. */
function crossTeam(models: Record<string, string>, checkedBy: Array<string>, fail: Set<string> = new Set()): Array<TeamRunMember> {
	return TEAM.map((m) => ({
		id: m.id,
		role: m.role,
		rules: m.rules,
		provenance: { connectionId: 'c-shared', connectionLabel: 'Gateway', endpoint: 'http://x' },
		provider: createFakeProvider({
			model: models[m.id],
			limits: { contextWindow: m.window, maxOutputTokens: 2000 },
			script: (req) => {
				if (req.schema?.name === 'finding_verification') {
					checkedBy.push(m.id)
					return { verdict: 'holds', reason: 'Traced through login.ts.', level: 'blocking', checked: ['src/auth/login.ts:1-5'] }
				}
				if (fail.has(m.id)) return new ProviderError('auth', 'rejected the API key (401)')
				const e = req.batch.excerpts.find((x) => x.file.key === 'src/auth/login.ts')
				const findings =
					m.id === 'defects' && e
						? [
								{
									excerpt_id: e.id,
									file_path: 'src/auth/login.ts',
									side: 'new' as const,
									start_line: 1,
									end_line: 1,
									category: 'bug' as const,
									signature: null,
									test_pattern: null,
									severity: 'blocking' as const,
									title: 'Login accepts any password',
									body: 'Anyone can sign in: the check is skipped.',
									reasoning: 'The comparison was removed.',
									disproof: 'Sign in with a wrong password and expect a rejection.',
									background: null,
									evidence: e.lines[0].text,
								},
							]
						: []
				return { findings, evaluation: emptyEvaluation().filter((x) => m.rules.includes(x.rule)), unexplained_files: [], limitations: [] }
			},
		}),
	}))
}

test('double-check in a team: another member on a different model checks the finding, not the one that raised it', async () => {
	const checkedBy: Array<string> = []
	const members = crossTeam({ defects: 'model-a', security: 'model-b', callers: 'model-c', tests: 'model-d' }, checkedBy)
	const run = await startRun(input(), options(members), () => {}).done
	assert.equal(run.status, 'completed', run.errors.join('; '))
	const f = run.findings.find((x) => x.title === 'Login accepts any password')!
	assert.equal(f.memberId, 'defects')
	// Of the other members, the ones on a different model with the largest context window; the first of those.
	assert.deepEqual(checkedBy, ['callers'])
	assert.equal(f.verification?.memberId, 'callers')
	assert.equal(f.verification?.model, 'model-c')
	assert.equal(f.verification?.verdict, 'holds')
	assert.ok(run.team!.members.find((m) => m.id === 'callers')!.usage!.inputTokens > 0)
})

test('double-check in a team: a member whose review failed is not asked; with one model for all, another member still checks', async () => {
	const failed: Array<string> = []
	const fails = crossTeam({ defects: 'm', security: 'n', callers: 'n', tests: 'n' }, failed, new Set(['callers']))
	const run = await startRun(input(), options(fails), () => {}).done
	assert.equal(run.findings[0].verification?.memberId, 'tests', 'callers failed, tests is next on a different model')
	assert.deepEqual(failed, ['tests'])

	const same: Array<string> = []
	const run2 = await startRun(input(), options(crossTeam({ defects: 'm', security: 'm', callers: 'm', tests: 'm' }, same)), () => {}).done
	assert.equal(same.length, 1)
	assert.notEqual(same[0], 'defects', 'the same model, but not the member that raised it')
	assert.equal(run2.findings[0].verification?.memberId, same[0])
})

/** The team above with "everyone checks bugs" on; Defects and Callers both report the same bug in Button.tsx. */
function bugTeam(seen: Seen, fail: Set<string> = new Set()): Array<TeamRunMember> {
	const saved: ReviewTeam = {
		id: 't',
		name: 'Team',
		everyoneChecksBugs: true,
		members: TEAM.map((m) => ({ id: m.id, role: m.role, connectionId: `c-${m.id}`, modelId: `${m.id}-model`, rules: m.rules })),
	}
	return runMembers(saved).map((m) => ({
		id: m.id,
		role: m.role,
		rules: m.rules,
		provenance: { connectionId: m.connectionId, connectionLabel: 'Gateway', endpoint: 'http://x' },
		provider: createFakeProvider({
			model: m.modelId,
			limits: { contextWindow: TEAM.find((x) => x.id === m.id)!.window, maxOutputTokens: 2000 },
			script: (req) => {
				seen.set(m.id, [...(seen.get(m.id) ?? []), req])
				if (fail.has(m.id)) return new ProviderError('server', 'server error (500)')
				const e = req.batch.excerpts.find((ex) => ex.file.newPath === 'src/ui/Button.tsx')
				const findings =
					e && (m.id === 'defects' || m.id === 'callers')
						? [
								{
									excerpt_id: e.id,
									file_path: 'src/ui/Button.tsx',
									side: 'new' as const,
									start_line: 1,
									end_line: 1,
									category: 'bug' as const,
									signature: null,
									test_pattern: null,
									severity: 'should_fix' as const,
									title: 'Button submits the form twice',
									body: 'Clicking once can send the order twice.',
									reasoning: 'The handler is attached on every render.',
									disproof: null,
									background: null,
									evidence: e.lines[0].text,
								},
							]
						: []
				return { findings, evaluation: emptyEvaluation().filter((x) => m.rules.includes(x.rule)), unexplained_files: [], limitations: [] }
			},
		}),
	}))
}

/**
 * Defects lets one place go in each of login.ts (high risk) and Button.tsx, under "bug"; whoever is asked to check a
 * near miss answers with `verdict`, and with "problem" describes it as a finding on login.ts.
 */
function nearMissTeam(verdict: 'safe' | 'problem' | 'unsure', asked: Array<{ member: string; input: string }>): Array<TeamRunMember> {
	return TEAM.map((m, i) => ({
		id: m.id,
		role: m.role,
		rules: m.rules,
		provenance: { connectionId: 'c-shared', connectionLabel: 'Gateway', endpoint: 'http://x' },
		provider: createFakeProvider({
			model: `model-${i}`,
			limits: { contextWindow: m.window, maxOutputTokens: 2000 },
			script: (req) => {
				if (req.schema?.name === 'near_miss_check') {
					asked.push({ member: m.id, input: req.input })
					const e = req.batch.excerpts[0]
					return {
						verdict,
						reason: 'The webhook handler calls this too and retries it (src/webhook.ts:40).',
						checked: ['src/webhook.ts:30-50'],
						finding:
							verdict === 'problem'
								? {
										excerpt_id: e.id,
										file_path: 'src/auth/login.ts',
										side: 'new',
										start_line: 2,
										end_line: 2,
										category: 'error-handling',
										signature: null,
										test_pattern: null,
										severity: 'should_fix',
										title: 'A retried webhook sends the refund twice',
										body: 'A customer can be refunded twice when the webhook is retried.',
										reasoning: 'The webhook path does not check for an earlier refund.',
										disproof: null,
										background: null,
										evidence: e.lines[1].text,
										raised_before: null,
									}
								: null,
					}
				}
				const evaluation = emptyEvaluation().filter((x) => m.rules.includes(x.rule))
				if (m.id === 'defects') {
					const near = ['src/auth/login.ts', 'src/ui/Button.tsx'].flatMap((path) => {
						const e = req.batch.excerpts.find((ex) => ex.file.newPath === path)
						return e ? [{ excerpt_id: e.id, line: 1, note: `Only the checkout page calls ${path}, once per order.` }] : []
					})
					evaluation.find((x) => x.rule === 'bug')!.near_misses = near
				}
				return { findings: [], evaluation, unexplained_files: [], limitations: [] }
			},
		}),
	}))
}

test('everyone checks bugs: only members that lack "bug" get it, and turning it off changes nothing', () => {
	const members = TEAM.map((m) => ({ id: m.id, role: m.role, connectionId: 'c', modelId: 'm', rules: m.rules }))
	assert.equal(runMembers({ id: 't', name: 'T', members }), members)
	const on = runMembers({ id: 't', name: 'T', members, everyoneChecksBugs: true })
	assert.deepEqual(
		on.map((m) => m.rules.filter((r) => r === 'bug').length),
		[1, 1, 1, 1],
	)
	assert.equal(on[0], members[0], 'the member that already owns it is unchanged')
	assert.deepEqual(on[1].rules, ['bug', 'security'])
})

test('everyone checks bugs: each member answers "bug" on its own requests, and a bug two members find is listed once', async () => {
	const seen: Seen = new Map()
	const run = await startRun(input(), options(bugTeam(seen)), () => {}).done
	assert.equal(run.status, 'completed', run.errors.join('; '))
	const bug = run.evaluation!.filter((e) => e.rule === 'bug')
	assert.deepEqual(bug.map((e) => e.checkedBy).sort(), ['callers', 'defects', 'security', 'tests'])
	for (const e of bug) assert.equal(e.requests, run.team!.members.find((m) => m.id === e.checkedBy)!.requestsTotal, e.checkedBy!)
	// Every other rule still has one owner.
	const others = run.evaluation!.filter((e) => e.rule !== 'bug').map((e) => e.rule)
	assert.equal(others.length, new Set(others).size)
	// "bug" applies to configuration too, so the tests member now reads it.
	assert.ok(filesOf(seen.get('tests')).includes('config/app.yml'))
	const found = run.findings.filter((f) => f.title === 'Button submits the form twice')
	assert.equal(found.length, 1)
	assert.deepEqual([found[0].memberId, ...(found[0].alsoBy ?? [])].sort(), ['callers', 'defects'])
	assert.ok(run.rejected.some((r) => /Same problem as "Button submits the form twice", also reported by/.test(r.reason)))
})

test('everyone checks bugs: retrying "bug" asks only the member that missed it', async () => {
	const first = await startRun(input(), options(bugTeam(new Map(), new Set(['security']))), () => {}).done
	assert.equal(first.status, 'partial')
	const again: Seen = new Map()
	const security = bugTeam(again).find((m) => m.id === 'security')!
	const run = await startRun(
		input({ run: first, rules: ['bug'], providers: new Map([['security', security.provider]]) }),
		{ ...options([security]), provider: security.provider, team: undefined },
		() => {},
	).done
	assert.deepEqual([...again.keys()], ['security'])
	assert.equal(again.get('security')!.length, first.team!.members.find((m) => m.id === 'security')!.requestsTotal)
	const total = (id: string) => run.team!.members.find((m) => m.id === id)!.requestsTotal
	for (const e of run.evaluation!.filter((x) => x.rule === 'bug')) assert.equal(e.answered!.length, total(e.checkedBy!), e.checkedBy!)
	// Its own rule was not asked again, so it is still missing.
	assert.equal(run.evaluation!.find((e) => e.rule === 'security')!.answered!.length, 0)
})

test('near misses on high-risk files are challenged by another member; a problem it traces becomes a finding', async () => {
	const asked: Array<{ member: string; input: string }> = []
	const run = await startRun(input(), options(nearMissTeam('problem', asked)), () => {}).done
	assert.equal(run.status, 'completed', run.errors.join('; '))
	// Only login.ts is rated high risk, so only its near miss is checked, by a member other than Defects.
	assert.equal(asked.length, 1)
	assert.notEqual(asked[0].member, 'defects')
	assert.match(asked[0].input, /The reviewer's note: Only the checkout page calls src\/auth\/login\.ts/)
	const bug = run.evaluation!.find((e) => e.rule === 'bug')!
	const login = bug.nearMisses.find((m) => m.fileKey === 'src/auth/login.ts')!
	const button = bug.nearMisses.find((m) => m.fileKey === 'src/ui/Button.tsx')!
	assert.equal(button.check, undefined)
	assert.equal(login.check?.verdict, 'problem')
	assert.equal(login.check?.memberId, asked[0].member)
	const f = run.findings.find((x) => x.id === login.check!.findingId)!
	assert.equal(f.title, 'A retried webhook sends the refund twice')
	assert.equal(f.memberId, asked[0].member)
	assert.deepEqual(f.fromNearMiss, { rule: 'bug', note: login.note, memberId: 'defects' })
	assert.deepEqual(f.anchor.startLine, 2)
	assert.equal(run.verification?.total, 1)
	assert.equal(run.verification?.done, 1)
})

test('a near miss the check finds safe adds no finding; with double-checking off nothing is checked', async () => {
	const asked: Array<{ member: string; input: string }> = []
	const run = await startRun(input(), options(nearMissTeam('safe', asked)), () => {}).done
	assert.equal(run.findings.length, 0)
	const login = run.evaluation!.find((e) => e.rule === 'bug')!.nearMisses.find((m) => m.fileKey === 'src/auth/login.ts')!
	assert.equal(login.check?.verdict, 'safe')
	assert.equal(login.check?.findingId, null)

	const none: Array<{ member: string; input: string }> = []
	const base = options(nearMissTeam('problem', none))
	const off = await startRun(input(), { ...base, limits: { ...base.limits, verify: false } }, () => {}).done
	assert.equal(none.length, 0)
	assert.equal(off.findings.length, 0)
})
