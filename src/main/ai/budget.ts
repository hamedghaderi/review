import type { BudgetSettings, SpendTotals } from '../../shared/types.ts'

export const NO_BUDGETS: BudgetSettings = { perRun: null, daily: null, monthly: null, connections: {} }

/** What has been spent today and this month (local time), overall and by connection id. */
export interface Spent {
	today: SpendTotals & { connections: Record<string, SpendTotals> }
	month: SpendTotals & { connections: Record<string, SpendTotals> }
}

/** Where a run stands against the budgets, for the connections it uses. */
export interface BudgetCheck {
	over: Array<string> // caps already reached, in words
	// The most the run may cost before it stops, and what it says then; null: no limit applies.
	limit: { usd: number; reason: string } | null
}

const usd = (n: number): string => `$${n.toFixed(2)}`

/** Whether you set any budget. Without one, nothing is checked and every run goes as it did before budgets. */
export function hasBudgets(b: BudgetSettings): boolean {
	return (
		b.perRun !== null ||
		b.daily !== null ||
		b.monthly !== null ||
		Object.values(b.connections).some((c) => c.daily !== null || c.monthly !== null)
	)
}

/**
 * The caps reached by what was spent (a lower bound when some requests had no price), and the most a run on these
 * connections may cost: the per-run budget, or what is left of the tightest cap if that is less. `ignoreCaps`: you
 * chose to start anyway, so only the per-run budget stops it.
 */
export function checkBudget(
	b: BudgetSettings,
	spent: Spent,
	connections: Array<{ id: string; label: string }>,
	ignoreCaps = false,
): BudgetCheck {
	const caps: Array<{ cap: number; spent: number; what: string }> = []
	if (b.daily !== null) caps.push({ cap: b.daily, spent: spent.today.usd, what: `today's budget of ${usd(b.daily)}` })
	if (b.monthly !== null) caps.push({ cap: b.monthly, spent: spent.month.usd, what: `this month's budget of ${usd(b.monthly)}` })
	for (const c of connections) {
		const own = Object.hasOwn(b.connections, c.id) ? b.connections[c.id] : null
		if (own?.daily != null)
			caps.push({
				cap: own.daily,
				spent: spent.today.connections[c.id]?.usd ?? 0,
				what: `today's budget of ${usd(own.daily)} for ${c.label}`,
			})
		if (own?.monthly != null)
			caps.push({
				cap: own.monthly,
				spent: spent.month.connections[c.id]?.usd ?? 0,
				what: `this month's budget of ${usd(own.monthly)} for ${c.label}`,
			})
	}
	const over = caps.filter((c) => c.spent >= c.cap).map((c) => `${usd(c.spent)} spent: ${c.what} is reached.`)
	const limits = [
		...(b.perRun !== null ? [{ usd: b.perRun, reason: `This run reached its budget of ${usd(b.perRun)}` }] : []),
		...(ignoreCaps ? [] : caps.map((c) => ({ usd: Math.max(0, c.cap - c.spent), reason: `This run reached ${c.what}` }))),
	]
	const limit = limits.reduce<BudgetCheck['limit']>((a, x) => (!a || x.usd < a.usd ? x : a), null)
	return { over, limit }
}
