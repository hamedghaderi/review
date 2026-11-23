import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { agentShare, agentShareDetail, commitAgents, type AgentCommit } from '../src/shared/agentCommits.ts'
import { commitAuthorship } from '../src/main/git.ts'

let n = 0
const commit = (name: string, email: string, message = 'Change things'): AgentCommit => ({
	sha: String(++n).padStart(40, '0'),
	name,
	email,
	message,
})
const person = (message?: string) => commit('Ada Lovelace', 'ada@example.com', message)

test('a Co-authored-by trailer naming an agent counts, in any case', () => {
	assert.deepEqual(commitAgents(person('Fix it\n\nCo-Authored-By: Claude <noreply@anthropic.com>')), ['Claude'])
	assert.deepEqual(commitAgents(person('Fix it\n\nco-authored-by: Cursor Agent <cursoragent@cursor.com>')), ['Cursor'])
	assert.deepEqual(commitAgents(person('Fix it\n\nCo-authored-by: aider (gpt-5) <aider@aider.chat>')), ['Aider'])
})

test('an agent account as the author counts, by bot name or noreply address', () => {
	assert.deepEqual(commitAgents(commit('copilot-swe-agent[bot]', '198982749+Copilot@users.noreply.github.com')), ['Copilot'])
	assert.deepEqual(commitAgents(commit('Copilot', '198982749+Copilot@users.noreply.github.com')), ['Copilot'])
	assert.deepEqual(commitAgents(commit('Devin AI', '158243242+devin-ai-integration[bot]@users.noreply.github.com')), ['Devin'])
	assert.deepEqual(commitAgents(commit('Codex', 'codex@openai.com')), ['Codex'])
	assert.deepEqual(commitAgents(commit('Ada Lovelace (aider)', 'ada@example.com')), ['Aider'])
})

test('people, dependency bots and lookalike names do not count', () => {
	assert.deepEqual(commitAgents(person()), [])
	assert.deepEqual(commitAgents(commit('dependabot[bot]', '49699333+dependabot[bot]@users.noreply.github.com')), [])
	assert.deepEqual(commitAgents(commit('renovate[bot]', '29139614+renovate[bot]@users.noreply.github.com')), [])
	// A person co-author, someone called Claude, and an agent mentioned outside a trailer.
	assert.deepEqual(commitAgents(person('Pair\n\nCo-authored-by: Grace <123+grace@users.noreply.github.com>')), [])
	assert.deepEqual(commitAgents(commit('Claude Shannon', 'claude@example.com')), [])
	assert.deepEqual(commitAgents(person('Mention noreply@anthropic.com in the docs')), [])
	assert.deepEqual(commitAgents(person('Not a trailer: Co-authored-by: Claude <noreply@anthropic.com>')), [])
})

test('a commit with two agents counts once in the total and once for each agent', () => {
	const both = person('Fix\n\nCo-authored-by: Claude <noreply@anthropic.com>\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>')
	const s = agentShare([both, person(), person('x\n\nCo-authored-by: Claude Opus <noreply@anthropic.com>')])
	assert.deepEqual(s, {
		agentCommits: 2,
		commits: 3,
		byAgent: [
			{ agent: 'Claude', commits: 2 },
			{ agent: 'Cursor', commits: 1 },
		],
	})
	assert.equal(agentShareDetail(s!), 'Claude 2, Cursor 1')
})

test('nothing when no commit came from an agent', () => {
	assert.equal(agentShare([]), null)
	assert.equal(agentShare([person(), person()]), null)
})

test('the clone’s commits are read with full messages, merges left out', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'review-agents-'))
	const git = (...a: Array<string>): string =>
		execFileSync('git', a, {
			cwd: dir,
			encoding: 'utf8',
			env: {
				...process.env,
				GIT_CONFIG_GLOBAL: '/dev/null',
				GIT_AUTHOR_NAME: 'Ada',
				GIT_AUTHOR_EMAIL: 'ada@example.com',
				GIT_COMMITTER_NAME: 'Ada',
				GIT_COMMITTER_EMAIL: 'ada@example.com',
			},
		}).trim()
	git('init', '-q', '-b', 'main')
	writeFileSync(join(dir, 'a.txt'), '1')
	git('add', '.')
	git('commit', '-qm', 'base')
	git('checkout', '-qb', 'topic')
	writeFileSync(join(dir, 'a.txt'), '2')
	git('commit', '-qam', 'Agent work\n\nSecond paragraph.\n\nCo-authored-by: Claude <noreply@anthropic.com>')
	git('checkout', '-q', 'main')
	writeFileSync(join(dir, 'b.txt'), '1')
	git('add', '.')
	git('commit', '-qm', 'on main')
	git('checkout', '-q', 'topic')
	git('merge', '-q', '--no-edit', 'main')
	writeFileSync(join(dir, 'a.txt'), '3')
	git('commit', '-qam', 'By hand')
	const head = git('rev-parse', 'HEAD')
	const base = git('merge-base', 'main', 'topic') // as a PR review compares, so main's own commit is left out

	const commits = await commitAuthorship(dir, base, head)
	assert.deepEqual(commits.map((c) => c.message.split('\n')[0]).sort(), ['Agent work', 'By hand'])
	assert.match(commits.find((c) => c.message.startsWith('Agent'))!.message, /Second paragraph\.\n\nCo-authored-by: Claude/)
	assert.ok(commits.every((c) => c.name === 'Ada' && c.email === 'ada@example.com'))
	assert.deepEqual(agentShare(commits), { agentCommits: 1, commits: 2, byAgent: [{ agent: 'Claude', commits: 1 }] })
})
