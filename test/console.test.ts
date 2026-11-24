import assert from 'node:assert/strict'
import { test } from 'node:test'
import { looksLikeShell, parseCommand, suggest } from '../src/renderer/src/consoleCommands.ts'

const cmd = (line: string) => {
	const p = parseCommand(line)
	return p?.ok ? p.command : p
}

test('console: commands and their arguments', () => {
	assert.equal(cmd('  '), null)
	assert.deepEqual(cmd('review'), { name: 'review', scope: 'all' })
	assert.deepEqual(cmd('rerun changed'), { name: 'review', scope: 'changed' })
	assert.deepEqual(cmd('findings --blocking'), { name: 'findings', filter: 'blocking' })
	assert.deepEqual(cmd('findings should-fix'), { name: 'findings', filter: 'should_fix' })
	assert.deepEqual(cmd('Findings'), { name: 'findings', filter: 'open' })
	assert.deepEqual(cmd('ask "is #1 reachable from /login?"'), { name: 'ask', question: 'is #1 reachable from /login?' })
	assert.deepEqual(cmd('open src/a.ts:12'), { name: 'open', path: 'src/a.ts', line: 12 })
	assert.deepEqual(cmd('open src/a b.ts'), { name: 'open', path: 'src/a b.ts', line: null })
	assert.deepEqual(cmd('approve'), { name: 'submit', event: 'APPROVE' })
	assert.deepEqual(cmd('reject'), { name: 'submit', event: 'REQUEST_CHANGES' })
	assert.deepEqual(cmd('submit'), { name: 'submit', event: null })
	assert.match((parseCommand('approve now') as { error: string }).error, /takes nothing/, 'a typo next to approve does nothing')
	assert.match((parseCommand('findings huge') as { error: string }).error, /takes all, open or a level/)
	assert.match((parseCommand('ls -la') as { error: string }).error, /No command “ls”/, 'there is no shell')
})

test('console: what Enter runs is always on screen, and plain words become a question that names its model', () => {
	assert.equal(suggest('', 'opus'), null)
	assert.deepEqual(suggest('fin', 'opus'), { run: 'findings', hint: 'List the newest run’s findings; open ones by default', ai: false })
	assert.deepEqual(
		suggest('op', 'opus'),
		{ run: 'open ', hint: 'open <path>[:line]', ai: false },
		'needs a path, so it only completes the word',
	)
	assert.deepEqual(suggest('why is the token check gone?', 'opus'), {
		run: 'ask why is the token check gone?',
		hint: 'Asks opus about the change · one request',
		ai: true,
	})
	assert.equal(suggest('why?', null)?.hint, 'Choose a model for questions first')
	assert.equal(suggest('review', 'opus')?.ai, true)
	assert.equal(suggest('findings huge', 'opus')?.run, 'findings huge', 'a command with a wrong argument is not turned into a question')
	assert.equal(suggest('approve', 'opus')?.hint, 'Open the submit dialog, set to Approve')
})

test('console: a shell command is answered that this is not a shell, and is never sent on as a question', () => {
	for (const line of ['ls -la', 'ls', 'git status', 'npm test', 'cat a.ts | grep x', 'deploy --prod', 'make && make install'])
		assert.equal(looksLikeShell(line), true, line)
	for (const line of ['why is the token check gone', 'what does git rebase do?', 'is #1 reachable from /login?', 'Explain the retry loop'])
		assert.equal(looksLikeShell(line), false, line)
	const s = suggest('ls -la', 'opus')
	assert.equal(s?.run, 'ls -la')
	assert.equal(s?.ai, false)
	assert.match(s?.hint ?? '', /Not a shell/)
	assert.match((parseCommand('git status') as { error: string }).error, /not a shell: Review never runs commands/)
	assert.equal(
		suggest('what does git rebase do?', 'opus')?.run,
		'ask what does git rebase do?',
		'a question about a command is still a question',
	)
})
