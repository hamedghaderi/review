import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CliGate } from '../src/main/ai/cliGate.ts'
import { createFakeProvider } from '../src/main/ai/fake.ts'
import { ProviderError, type ProviderRequest, type ReviewProvider } from '../src/main/ai/provider.ts'

const REQUEST = {
	instructions: 'x',
	input: 'y',
	batch: { index: 0, references: [], facts: [], fileKeys: [], overview: '', chars: 0, excerpts: [] },
} as ProviderRequest

/** A provider whose requests wait until the test lets them finish, so it can see how many run at once. */
function held() {
	let active = 0
	let most = 0
	const pending: Array<(r: unknown) => void> = []
	const provider: ReviewProvider = {
		...createFakeProvider(),
		async review() {
			active++
			most = Math.max(most, active)
			const output = await new Promise((resolve) => pending.push(resolve))
			active--
			if (output instanceof Error) throw output
			return { output, usage: null }
		},
	}
	return { provider, most: () => most, sent: () => pending.length, finish: (r: unknown = {}) => pending.shift()!(r) }
}

const tick = () => new Promise((r) => setImmediate(r))

test('a CLI gate runs two requests at once from every provider on the login, and queues the rest in order', async () => {
	const gate = new CliGate(2)
	const a = held()
	const b = held()
	// Two team members (or passes, or runs) on one login: two providers, one gate.
	const one = gate.wrap(a.provider)
	const two = gate.wrap(b.provider)
	const signal = new AbortController().signal
	const done = [one.review(REQUEST, signal), two.review(REQUEST, signal), one.review(REQUEST, signal), two.review(REQUEST, signal)]
	await tick()
	assert.equal(a.sent() + b.sent(), 2, 'two sent, two waiting')
	a.finish()
	await tick()
	assert.equal(a.sent() + b.sent(), 2, 'the first in line goes when one finishes')
	a.finish()
	b.finish()
	await tick()
	b.finish()
	await Promise.all(done)
	assert.ok(a.most() + b.most() <= 2)
})

test('a request cancelled while it waits for the gate is never sent and frees its place', async () => {
	const gate = new CliGate(1)
	const p = held()
	const provider = gate.wrap(p.provider)
	const first = provider.review(REQUEST, new AbortController().signal)
	const waiting = new AbortController()
	const second = provider.review(REQUEST, waiting.signal)
	const third = provider.review(REQUEST, new AbortController().signal)
	await tick()
	waiting.abort()
	await assert.rejects(second, (e: ProviderError) => e.kind === 'cancelled')
	p.finish()
	await first
	await tick()
	assert.equal(p.sent(), 1, 'the third went next')
	p.finish()
	await third
})

test('once the plan’s limit is reached, the login’s other requests fail at once with the reset, until it passes', async () => {
	let now = 1_000_000
	const gate = new CliGate(2, () => now)
	const p = held()
	const provider = gate.wrap(p.provider)
	const signal = new AbortController().signal
	const first = provider.review(REQUEST, signal)
	const second = provider.review(REQUEST, signal)
	const third = provider.review(REQUEST, signal) // waiting for a place
	await tick()
	p.finish(new ProviderError('quota', 'Your Claude plan’s usage limit is reached; it resets at 18:00.', 60 * 60_000))
	await assert.rejects(first, /resets at 18:00/)
	await assert.rejects(third, (e: ProviderError) => e.kind === 'quota' && /resets at 18:00/.test(e.message), 'not sent after waiting')
	await assert.rejects(provider.review(REQUEST, signal), (e: ProviderError) => e.kind === 'quota' && e.fatal && !e.retryable)
	p.finish() // the one already sent still finishes normally
	await second
	assert.equal(p.sent(), 0)

	now += 60 * 60_000
	const later = provider.review(REQUEST, signal)
	await tick()
	assert.equal(p.sent(), 1, 'tried again once the limit reset')
	p.finish()
	await later

	// Without a known reset, a short block; testing the connection again clears it.
	const again = provider.review(REQUEST, signal)
	await tick()
	p.finish(new ProviderError('quota', 'usage limit reached'))
	await assert.rejects(again)
	await assert.rejects(provider.review(REQUEST, signal), (e: ProviderError) => e.kind === 'quota')
	gate.clear()
	const cleared = provider.review(REQUEST, signal)
	await tick()
	p.finish()
	await cleared
})
