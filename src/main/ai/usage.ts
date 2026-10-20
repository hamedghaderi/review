import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { addCost } from '../../shared/cost.ts'
import type {
	AiCost,
	AiUsage,
	SpendTotals,
	UsageGroup,
	UsageKind,
	UsagePeriod,
	UsageRecord,
	UsageSummary,
	UsageTotals,
} from '../../shared/types.ts'
import { JsonStore } from '../store.ts'
import type { Spent } from './budget.ts'
import { addUsage, ProviderError, type ProviderErrorKind, type ReviewProvider } from './provider.ts'

const KEEP_DAYS = 400 // a year of months, plus the one in progress

// Failures that come after the model answered, so the request was billed though no usage came back.
const ANSWERED: ReadonlySet<ProviderErrorKind> = new Set(['refusal', 'incomplete', 'invalid-output', 'timeout'])

interface UsageFile {
	version: 1
	records: Array<UsageRecord>
}

/** Who a metered provider's requests are booked to. */
export interface UsageContext {
	kind: UsageKind
	repoId: string | null
	repo: string | null
	connectionId: string
	connection: string
}

/** The usage history: one record per model for each run, retry and on-demand request, in its own file. */
export class UsageLog {
	private file: JsonStore<UsageFile>

	constructor(dir: string) {
		this.file = new JsonStore<UsageFile>(join(dir, 'ai-usage.json'), empty, migrate)
	}

	load(): Promise<void> {
		return this.file.load()
	}

	flush(): Promise<unknown> {
		return this.file.flush()
	}

	/**
	 * The same provider, booking every response to one new record (created with the first response). Each response is
	 * written as it arrives, so a run the app never finishes is still counted.
	 */
	meter(provider: ReviewProvider, ctx: UsageContext): ReviewProvider {
		const id = randomUUID()
		const book = (usage: AiUsage | null): void => void this.add(id, ctx, provider, usage).catch(() => {})
		return {
			...provider,
			review: async (request, signal) => {
				try {
					const response = await provider.review(request, signal)
					book(response.usage)
					return response
				} catch (e) {
					if (e instanceof ProviderError && ANSWERED.has(e.kind)) book(null)
					throw e
				}
			},
		}
	}

	summary(by: UsagePeriod, now = new Date()): UsageSummary {
		return summarizeUsage(this.file.read().records, by, now)
	}

	/** What was spent today and this month, in local time, overall and by connection. */
	spent(now = new Date()): Spent {
		return spentBy(this.file.read().records, now)
	}

	private add(id: string, ctx: UsageContext, provider: ReviewProvider, usage: AiUsage | null): Promise<void> {
		return this.file.update((f) => {
			const cutoff = Date.now() - KEEP_DAYS * 86_400_000
			f.records = f.records.filter((r) => Date.parse(r.at) >= cutoff)
			let r = f.records.find((x) => x.id === id)
			if (!r) {
				r = {
					id,
					at: new Date().toISOString(),
					...ctx,
					provider: provider.id,
					model: provider.model,
					requests: 0,
					unreported: 0,
					usage: null,
					cost: { usd: 0, estimated: false, unpriced: false },
				}
				f.records.push(r)
			}
			r.requests++
			if (!usage) r.unreported++
			r.usage = addUsage(r.usage, usage)
			r.cost = addCost(r.cost, usage, provider.price ?? null)
		})
	}
}

/** The last 30 days by day, or the last 12 months by month, in local time, with the totals split four ways. */
export function summarizeUsage(records: Array<UsageRecord>, by: UsagePeriod, now: Date): UsageSummary {
	const keys: Array<string> = []
	for (let i = 0; i < (by === 'day' ? 30 : 12); i++) {
		const d =
			by === 'day' ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - i) : new Date(now.getFullYear(), now.getMonth() - i, 1)
		keys.push(periodKey(d, by))
	}
	const inWindow = records.filter((r) => keys.includes(periodKey(new Date(r.at), by)))
	const group = (
		key: (r: UsageRecord) => string,
		label: (r: UsageRecord) => string,
		detail: (r: UsageRecord) => string | null = () => null,
	) => {
		const groups = new Map<string, UsageGroup>()
		// Newest first, so a group is labelled as it was last named.
		for (const r of [...inWindow].sort((a, b) => b.at.localeCompare(a.at))) {
			const g = groups.get(key(r)) ?? { key: key(r), label: label(r), detail: detail(r), totals: emptyTotals() }
			addTotals(g.totals, r)
			groups.set(g.key, g)
		}
		return [...groups.values()].sort(
			(a, b) =>
				b.totals.cost.usd - a.totals.cost.usd ||
				b.totals.inputTokens + b.totals.outputTokens - (a.totals.inputTokens + a.totals.outputTokens),
		)
	}
	const total = emptyTotals()
	for (const r of inWindow) addTotals(total, r)
	return {
		by,
		periods: keys.map((key) => {
			const totals = emptyTotals()
			for (const r of inWindow) if (periodKey(new Date(r.at), by) === key) addTotals(totals, r)
			return { key, totals }
		}),
		total,
		connections: group(
			(r) => r.connectionId,
			(r) => r.connection,
		),
		models: group(
			(r) => `${r.connectionId}\u0000${r.model}`,
			(r) => r.model,
			(r) => r.connection,
		),
		repos: group(
			(r) => r.repoId ?? '',
			(r) => r.repo ?? 'No repository',
		),
		kinds: group(
			(r) => r.kind,
			(r) => r.kind,
		),
		oldest: records.reduce<string | null>((a, r) => (!a || r.at < a ? r.at : a), null),
	}
}

export function spentBy(records: Array<UsageRecord>, now: Date): Spent {
	const empty = (): SpendTotals => ({ usd: 0, unpriced: false, inputTokens: 0, outputTokens: 0 })
	const out: Spent = { today: { ...empty(), connections: {} }, month: { ...empty(), connections: {} } }
	const add = (t: SpendTotals, r: UsageRecord): void => {
		t.usd += r.cost.usd
		t.unpriced ||= r.cost.unpriced
		t.inputTokens += r.usage?.inputTokens ?? 0
		t.outputTokens += r.usage?.outputTokens ?? 0
	}
	const periods = [
		{ totals: out.today, by: 'day' as const, key: periodKey(now, 'day') },
		{ totals: out.month, by: 'month' as const, key: periodKey(now, 'month') },
	]
	for (const r of records)
		for (const p of periods) {
			if (periodKey(new Date(r.at), p.by) !== p.key) continue
			add(p.totals, r)
			add((p.totals.connections[r.connectionId] ??= empty()), r)
		}
	return out
}

/** "2026-10-20" or "2026-10", in local time. */
function periodKey(d: Date, by: UsagePeriod): string {
	const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
	return by === 'month' ? month : `${month}-${String(d.getDate()).padStart(2, '0')}`
}

function emptyTotals(): UsageTotals {
	return { requests: 0, inputTokens: 0, outputTokens: 0, cost: { usd: 0, estimated: false, unpriced: false }, unreported: 0 }
}

function addTotals(t: UsageTotals, r: UsageRecord): void {
	t.requests += r.requests
	t.unreported += r.unreported
	t.inputTokens += r.usage?.inputTokens ?? 0
	t.outputTokens += r.usage?.outputTokens ?? 0
	t.cost = sumCost(t.cost, r.cost)
}

function sumCost(a: AiCost, b: AiCost): AiCost {
	return { usd: a.usd + b.usd, estimated: a.estimated || b.estimated, unpriced: a.unpriced || b.unpriced }
}

function empty(): UsageFile {
	return { version: 1, records: [] }
}

function migrate(raw: unknown): UsageFile {
	const d = raw as Partial<UsageFile> | null
	if (!d || d.version !== 1 || !Array.isArray(d.records)) throw new Error('Unsupported usage file')
	return { version: 1, records: d.records }
}
