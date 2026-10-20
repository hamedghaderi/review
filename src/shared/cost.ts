import type { AiCost, AiUsage, ModelPrice, PricedModel } from './types.ts'

/** What one request's tokens cost at `price`, in US dollars. Cached and cache-write input is billed at its own price. */
export function costOf(u: AiUsage, price: ModelPrice): number {
	const cached = u.cachedInputTokens
	const written = u.cacheWriteTokens ?? 0
	const plain = Math.max(0, u.inputTokens - cached - written)
	return (
		(plain * price.input +
			cached * (price.cachedInput ?? price.input) +
			written * (price.cacheWrite ?? price.input) +
			u.outputTokens * price.output) /
		1_000_000
	)
}

/** Adds one request to a running total. A request without a price or without reported usage makes the total a lower bound. */
export function addCost(total: AiCost | null, u: AiUsage | null, price: PricedModel | null): AiCost {
	const t = total ?? { usd: 0, estimated: false, unpriced: false }
	if (!u || !price) return { ...t, unpriced: true }
	return { usd: t.usd + costOf(u, price), estimated: t.estimated || price.source === 'catalog', unpriced: t.unpriced }
}

/** "$0.42", "<$0.01", "at least $0.42" when some requests had no price, "unknown" when none had one. */
export function formatCost(c: AiCost): string {
	if (c.unpriced && c.usd === 0) return 'unknown'
	const amount = c.usd > 0 && c.usd < 0.01 ? '<$0.01' : `$${c.usd.toFixed(2)}`
	return c.unpriced ? `at least ${amount}` : amount
}

/** Why a cost is uncertain, for a tooltip; null when it is not. */
export function costCaveat(c: AiCost): string | null {
	const parts = [
		...(c.estimated ? ['Estimated from catalog prices, which may be out of date. Set your own price in Settings → AI providers.'] : []),
		...(c.unpriced ? ['Some requests used a model without a price, or the provider reported no usage, so they are not counted.'] : []),
	]
	return parts.length ? parts.join(' ') : null
}

/** "$3 in · $15 out per million tokens". */
export function formatPrice(p: ModelPrice): string {
	const n = (x: number): string => `$${Number(x.toFixed(4))}`
	return `${n(p.input)} in · ${n(p.output)} out per million tokens`
}
