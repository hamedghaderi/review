import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { MOTION_KEY, REDUCE_CLASS, motionPref, reducesMotion } from '../src/renderer/src/motion.ts'

test('reduced motion: the system decides unless you chose; anything unknown follows the system', () => {
	assert.equal(reducesMotion('system', true), true)
	assert.equal(reducesMotion('system', false), false)
	assert.equal(reducesMotion('reduce', false), true)
	assert.equal(reducesMotion('full', true), false)

	const store = new Map<string, string>()
	const g = globalThis as { localStorage?: Pick<Storage, 'getItem'> }
	g.localStorage = { getItem: (k) => store.get(k) ?? null }
	try {
		assert.equal(motionPref(), 'system')
		store.set(MOTION_KEY, 'reduce')
		assert.equal(motionPref(), 'reduce')
		store.set(MOTION_KEY, 'fast')
		assert.equal(motionPref(), 'system')
	} finally {
		delete g.localStorage
	}
})

test('stylesheets: the reduce rule stops every animation and transition, and nothing overrides it', () => {
	const css = ['src/renderer/src/styles.css', 'src/renderer/src/themes.css'].map((p) => readFileSync(p, 'utf8')).join('\n')
	const rule = new RegExp(`\\.${REDUCE_CLASS} \\*,\\s*\\.${REDUCE_CLASS} \\*::before,\\s*\\.${REDUCE_CLASS} \\*::after \\{([^}]*)\\}`).exec(
		css,
	)
	assert.ok(rule, 'the reduce-motion rule is there')
	assert.match(rule[1], /animation: none !important;/)
	assert.match(rule[1], /transition: none !important;/)
	// An !important animation or transition elsewhere could win over the rule above.
	const overriding = css
		.replace(rule[0], '')
		.split('\n')
		.filter((l) => /^\s*(animation|transition)[\w-]*\s*:.*!important/.test(l))
	assert.deepEqual(overriding, [])
})
