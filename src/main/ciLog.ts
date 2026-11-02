/**
 * The useful part of a GitHub Actions job log: what each failed step printed last. Test runners, compilers and linters
 * print their failure summary at the end of the step, right before GitHub marks the step with `##[error]`, so the end
 * of a failed step says which test failed and why, while the rest of the log is setup and progress noise.
 */

export interface FailedStep {
	command: string // the step's first command line, as GitHub prints it after "Run"
	error: string // GitHub's error line ("Process completed with exit code 1.")
	output: Array<string> // what the step printed, without GitHub's own header group
}

const STAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g

/** Splits a raw job log into steps and returns the ones GitHub marked with an error, in log order. */
export function failedSteps(raw: string): Array<FailedStep> {
	const out: Array<FailedStep> = []
	let step: { command: string; output: Array<string>; header: boolean } | null = null
	let last: FailedStep | null = null
	for (const rawLine of raw.split('\n')) {
		const line = rawLine.replace(/\r$/, '').replace(STAMP, '').replace(ANSI, '')
		if (line.startsWith('##[group]Run ')) {
			step = { command: line.slice('##[group]Run '.length).trim(), output: [], header: true }
			last = null
			continue
		}
		if (!step) continue
		if (step.header) {
			// GitHub echoes the step's script and environment in a group before the step's own output.
			if (line.startsWith('##[endgroup]')) step.header = false
			continue
		}
		if (line.startsWith('##[error]')) {
			const error = line.slice('##[error]'.length).trim()
			if (last) last.error = `${last.error}\n${error}`
			else out.push((last = { command: step.command, error, output: step.output }))
			continue
		}
		if (/^##\[(group|endgroup)\]/.test(line)) continue
		step.output.push(line)
	}
	return out
}

/**
 * A short text for the reviewer: the end of the failed step that printed the most (usually the test or build step),
 * with blocks the runner repeats for every failure (the same stack trace, the same source excerpt) kept once, then
 * one line for each other failed step. At most `budget` characters.
 */
export function failureExcerpt(raw: string, budget: number): string | null {
	const steps = failedSteps(raw)
	if (!steps.length) return null
	const main = steps.reduce((a, b) => (b.output.length > a.output.length ? b : a))
	const others = steps.filter((s) => s !== main)
	const tail = (cmd: string) => (cmd.length > 120 ? `${cmd.slice(0, 119)}…` : cmd)
	const footer = others.slice(0, 5).map((s) => `Step "${tail(s.command)}" also failed: ${s.error.split('\n')[0]}`)
	if (others.length > 5) footer.push(`… ${others.length - 5} more failed steps`)
	const head = `Step "${tail(main.command)}" failed: ${main.error.split('\n')[0]}`
	const room = budget - head.length - footer.reduce((n, l) => n + l.length + 1, 0) - 40
	const body = room > 200 ? fromTheEnd(nearFailures(withoutRepeats(main.output)), room) : ''
	return [head, ...(body ? ['Its output, near the failures:', body] : []), ...footer].join('\n')
}

// Words test runners, compilers and linters use for what went wrong; "failing" in a test's name does not match.
const MARKER = /\b(fail(ed|ure|ures|s)?|errors?|exception|assert\w*|expected|panic(ked)?|traceback)\b|[✗✘⨯×]/i
const AFTER = 25 // lines kept after a marker: the message, the source excerpt, the frames
const BEFORE = 2
const SUMMARY = 6 // last lines always kept: the runner's totals
// A test that passed (✓ name, PASS file, ok package, name PASSED) or an info/debug log record: never about a failure,
// even when a test's name says "fail", and it ends the lines kept after a marker.
const QUIET = /^\s*(✓|✔|√|PASS\b|ok\s|--- PASS)|\bPASSED\b|\b(INFO|DEBUG|TRACE)\b/

/** The lines within reach of a failure marker, plus the last few; each gap becomes one "…" line. */
export function nearFailures(lines: Array<string>): Array<string> {
	const keep = new Array<boolean>(lines.length).fill(false)
	const quiet = lines.map((l) => QUIET.test(l))
	for (let i = 0; i < lines.length; i++) {
		if (quiet[i] || !MARKER.test(lines[i])) continue
		for (let j = i - 1; j >= Math.max(0, i - BEFORE) && !quiet[j]; j--) keep[j] = true
		for (let j = i; j <= Math.min(lines.length - 1, i + AFTER) && !quiet[j]; j++) keep[j] = true
	}
	for (let j = Math.max(0, lines.length - SUMMARY); j < lines.length; j++) keep[j] = true
	const out: Array<string> = []
	for (let i = 0; i < lines.length; i++) {
		if (keep[i]) out.push(lines[i])
		else if (out[out.length - 1] !== '…') out.push('…')
	}
	return out
}

/** Drops a block (lines between blank lines) that already appeared earlier, and says how many were dropped. */
export function withoutRepeats(lines: Array<string>): Array<string> {
	const seen = new Set<string>()
	const kept: Array<string> = []
	let dropped = 0
	let block: Array<string> = []
	const flush = () => {
		if (!block.length) return
		const key = block.map((l) => l.trim()).join('\n')
		if (block.length > 1 && seen.has(key)) dropped++
		else {
			seen.add(key)
			kept.push(...block)
		}
		block = []
	}
	for (const l of lines) {
		if (l.trim()) block.push(l.trimEnd())
		else {
			flush()
			if (kept.length && kept[kept.length - 1] !== '') kept.push('')
		}
	}
	flush()
	while (kept.length && kept[kept.length - 1] === '') kept.pop()
	if (dropped) kept.push(`(${dropped} repeated block${dropped === 1 ? '' : 's'} left out)`)
	return kept
}

/** Whole lines from the end, as many as fit in `n` characters. */
function fromTheEnd(lines: Array<string>, n: number): string {
	const out: Array<string> = []
	let used = 0
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].length > 400 ? `${lines[i].slice(0, 399)}…` : lines[i]
		if (used + line.length + 1 > n) {
			if (out[0] !== '…') out.unshift('…')
			break
		}
		out.unshift(line)
		used += line.length + 1
	}
	return out.join('\n')
}
