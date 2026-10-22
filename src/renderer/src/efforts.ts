import type { ConnectionView, ModelView } from '../../shared/types.ts'

// A CLI connection offers each model at every effort it takes ("gpt-6-sol-high"). Pickers list the models themselves and
// offer the effort beside them, so these turn a picked model into its base model and effort, and back.

/** Lists show the models themselves; their variants are chosen with the effort beside them. */
export const listed = (m: ModelView): boolean => !m.variantOf

/** The model a pick runs, without its effort: "gpt-6-sol" for "gpt-6-sol-high". */
export function baseModel(c: ConnectionView | undefined, modelId: string): string {
	return c?.models.find((m) => m.id === modelId)?.variantOf ?? modelId
}

export function effortOf(c: ConnectionView | undefined, modelId: string): string | null {
	return c?.models.find((m) => m.id === modelId)?.effort ?? null
}

/** The efforts a model is offered at; empty for models of other providers. */
export function effortsFor(c: ConnectionView | undefined, baseId: string): Array<string> {
	return c?.models.flatMap((m) => (m.variantOf === baseId && m.effort ? [m.effort] : [])) ?? []
}

/** The model to pick for a model at an effort: its variant, or the model itself at the default (null) or an effort it lacks. */
export function withEffort(c: ConnectionView | undefined, baseId: string, effort: string | null): string {
	return (effort && c?.models.find((m) => m.variantOf === baseId && m.effort === effort)?.id) || baseId
}
