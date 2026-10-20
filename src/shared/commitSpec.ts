import type { ReviewTarget } from './types.ts'

const REV = /^[^\s:\\-][^\s:\\]*$/

/**
 * Commits to review, typed as git writes them: `a..b`, `a...b` (from their merge base), either side empty for HEAD, or
 * one commit's SHA (that commit alone). Whether they resolve is for the main process to say.
 */
export function commitSpec(text: string): Extract<ReviewTarget, { kind: 'commits' }> | null {
	const range = /^(.*?)(\.\.\.?)(.*)$/.exec(text)
	if (range) {
		const from = range[1] || 'HEAD'
		const to = range[3] || 'HEAD'
		if (!REV.test(from) || !REV.test(to) || from.includes('..') || to.includes('..')) return null
		return { kind: 'commits', from, to, mergeBase: range[2] === '...' }
	}
	// A word like "defaced" is hex too; a SHA almost always has a digit.
	if (/^[0-9a-f]{7,40}$/i.test(text) && /\d/.test(text)) return { kind: 'commits', from: `${text}^`, to: text, mergeBase: false }
	return null
}
