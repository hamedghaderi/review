import type { ReviewApi } from '../shared/types.ts'

declare global {
	const __APP_VERSION__: string // package.json's version, set at build time
	interface Window {
		review: ReviewApi
	}
}

export {}
