import type { ReviewApi } from '../shared/types.ts'

declare global {
	interface Window {
		review: ReviewApi
	}
}

export {}
