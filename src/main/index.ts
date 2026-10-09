import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	nativeTheme,
	Notification,
	powerMonitor,
	safeStorage,
	shell,
	type IpcMainInvokeEvent,
} from 'electron'
import { IPC, type InboxOpen, type Result } from '../shared/types.ts'
import { sdkAdapters } from './ai/adapters.ts'
import { ConnectionService } from './ai/connections.ts'
import { AiController } from './ai/controller.ts'
import { CredentialService } from './ai/credentials.ts'
import { McpService } from './ai/mcp.ts'
import { AppFail } from './git.ts'
import { ghCli } from './ghcli.ts'
import { GitHubService } from './github.ts'
import { InboxWatcher, type RepoEvent } from './inboxWatch.ts'
import { GiphyService } from './giphy.ts'
import { ReviewService } from './service.ts'
import { ReviewStore } from './store.ts'
import {
	apiKey,
	bool,
	branchRef,
	browserState,
	compareTarget,
	githubRepo,
	notificationPrefs,
	githubToken,
	prNumber,
	prQuery,
	reviewBody,
	reviewEvent,
	comparisonId,
	connectionId,
	connectionPatch,
	modelId,
	modelSelection,
	newConnection,
	findingLevels,
	mcpKeys,
	mcpServerInput,
	mcpToolNames,
	reviewerChoice,
	reviewLimits,
	reviewRules,
	reviewTeam,
	str,
} from './validate.ts'

let win: BrowserWindow | null = null
let service: ReviewService
let store: ReviewStore
let ai: AiController
let connections: ConnectionService
let credentials: CredentialService
let mcp: McpService
let github: GitHubService
let watcher: InboxWatcher
let giphy: GiphyService
let quitting = false
// How old a connection's model list may be before it is re-listed in the background, and when the model picker opens.
const MODELS_MAX_AGE_MS = 5 * 60_000
const PICKER_MODELS_MAX_AGE_MS = 30_000

app.on('before-quit', () => (quitting = true))

// A packaged app gets its icon from the bundle (build/icon.icns, .ico); a development run shows Electron's unless told.
const devIcon = app.isPackaged ? undefined : join(__dirname, '../../build/icons/512x512.png')

const rendererUrl = process.env.ELECTRON_RENDERER_URL
const rendererFile = join(__dirname, '../renderer/index.html')

function trustedSender(e: IpcMainInvokeEvent): boolean {
	if (!win || e.sender !== win.webContents || !e.senderFrame || e.senderFrame !== win.webContents.mainFrame) return false
	const url = e.senderFrame.url
	if (rendererUrl) return new URL(url).origin === new URL(rendererUrl).origin
	return url.split('#')[0] === pathToFileURL(rendererFile).href
}

function handle<A extends Array<unknown>, T>(channel: string, fn: (...args: A) => Promise<T>): void {
	ipcMain.handle(channel, async (e, ...args): Promise<Result<T>> => {
		if (!trustedSender(e)) return { ok: false, error: { code: 'invalid-input', message: 'Untrusted sender.' } }
		try {
			return { ok: true, value: await fn(...(args as A)) }
		} catch (err) {
			if (err instanceof AppFail) return { ok: false, error: err.toError() }
			console.error(`[${channel}]`, err)
			return { ok: false, error: { code: 'git-failed', message: err instanceof Error ? err.message : String(err) } }
		}
	})
}

function registerIpc(): void {
	handle(IPC.openRepository, async () => {
		const r = await dialog.showOpenDialog(win!, { title: 'Open repository', properties: ['openDirectory'] })
		if (r.canceled || !r.filePaths[0]) return null
		return service.open(r.filePaths[0])
	})
	handle(IPC.restoreLast, () => service.restoreLast())
	handle(IPC.refreshRepo, (repoId: unknown) => service.refresh(str(repoId, 'repository')))
	handle(IPC.loadComparison, (repoId: unknown, target: unknown) => service.loadComparison(str(repoId, 'repository'), compareTarget(target)))
	handle(IPC.probeTarget, (repoId: unknown, reviewId: unknown) => service.probeTarget(str(repoId, 'repository'), comparisonId(reviewId)))
	handle(IPC.branchPreview, (repoId: unknown, head: unknown, base: unknown) =>
		service.branchPreview(str(repoId, 'repository'), branchRef(head), branchRef(base, 'base branch')),
	)
	handle(IPC.saveBrowserState, (repoId: unknown, state: unknown) =>
		service.saveBrowserState(str(repoId, 'repository'), browserState(state)),
	)
	handle(IPC.cancelOpen, async () => service.cancelOpen())

	// GitHub. The token goes in once and is never returned; every handler answers with the secret-free status.
	handle(IPC.githubStatus, async () => github.status())
	handle(IPC.githubSetToken, async (token: unknown, persist: unknown) => {
		await github.setToken(githubToken(token), bool(persist, 'persist'))
		return github.status()
	})
	handle(IPC.githubDisconnect, async () => {
		await github.disconnect()
		return github.status()
	})
	handle(IPC.githubVerify, async () => {
		await github.verify()
		return github.status()
	})
	handle(IPC.githubUseCli, async (enabled: unknown) => {
		await github.useCli(bool(enabled, 'enabled'))
		return github.status()
	})
	handle(IPC.githubSetNotifications, async (prefs: unknown) => {
		await github.setNotifications(notificationPrefs(prefs))
		void watcher.check()
		return github.status()
	})
	handle(IPC.githubTestNotification, async () => {
		await present(
			new Notification({
				title: 'Review requested: example#123',
				body: 'This is what a review-request notification looks like\nby the Review app',
				silent: !github.notifications.sound,
			}),
			null,
		)
		return github.status()
	})
	handle(IPC.markPrSeen, (repoId: unknown, n: unknown) => service.markPrSeen(str(repoId, 'repository'), prNumber(n)))
	handle(IPC.openKnownRepo, (repoId: unknown) => service.openKnown(str(repoId, 'repository')))
	handle(IPC.closeRepoTab, (repoId: unknown) => service.closeTab(str(repoId, 'repository')))
	handle(IPC.repoTabs, async () => service.tabs())
	handle(IPC.addContextImage, (name: unknown, bytes: unknown) => {
		if (!(bytes instanceof Uint8Array)) throw new AppFail('invalid-input', 'Invalid image.')
		return service.addContextImage(typeof name === 'string' ? name : 'image', bytes)
	})
	handle(IPC.contextImage, (id: unknown, mediaType: unknown) => service.contextImage(str(id, 'image id', 64), mediaType))
	handle(IPC.githubSetRepo, (repoId: unknown, repo: unknown) => service.setGitHubRepo(str(repoId, 'repository'), githubRepo(repo)))
	handle(IPC.searchPrs, (repoId: unknown, q: unknown, slot: unknown) =>
		service.searchPrs(str(repoId, 'repository'), prQuery(q), slot === 'palette' ? 'palette' : 'list'),
	)
	handle(IPC.prDetail, (repoId: unknown, n: unknown) => service.prDetail(str(repoId, 'repository'), prNumber(n)))
	handle(IPC.prGraph, (repoId: unknown) => service.prGraph(str(repoId, 'repository')))
	handle(IPC.myReviews, (repoId: unknown) => service.myReviews(str(repoId, 'repository')))

	handle(IPC.branchPr, (repoId: unknown, head: unknown) => service.branchPr(str(repoId, 'repository'), branchRef(head)))

	handle(IPC.prDiscussion, (repoId: unknown, reviewId: unknown) => service.prDiscussion(str(repoId, 'repository'), comparisonId(reviewId)))

	// Publishing to GitHub. Only explicit user actions reach these; nothing is published automatically.
	handle(IPC.publishPlan, (repoId: unknown, reviewId: unknown) => service.publishPlan(str(repoId, 'repository'), comparisonId(reviewId)))
	handle(IPC.publishComment, (repoId: unknown, reviewId: unknown, commentId: unknown, outside: unknown) =>
		service.publishComment(
			str(repoId, 'repository'),
			comparisonId(reviewId),
			str(commentId, 'comment id', 128),
			outside === 'file' ? 'file' : 'skip',
		),
	)
	handle(IPC.submitReview, (repoId: unknown, reviewId: unknown, event: unknown, body: unknown) =>
		service.submitReview(str(repoId, 'repository'), comparisonId(reviewId), reviewEvent(event), reviewBody(body)),
	)
	handle(IPC.loadPatch, (cid: unknown, key: unknown, force: unknown) =>
		service.loadPatch(comparisonId(cid), str(key, 'file'), bool(force, 'force')),
	)
	handle(IPC.loadFileLines, (cid: unknown, key: unknown) => service.loadFileLines(comparisonId(cid), str(key, 'file')))
	handle(IPC.saveReview, (review: unknown) => service.saveReview(review))
	handle(IPC.aiStart, (reviewId: unknown, scope: unknown, reviewer: unknown) => {
		const choice = reviewerChoice(reviewer)
		connections.checkChoice(choice)
		return service.startAi(comparisonId(reviewId), scope, choice)
	})
	handle(IPC.aiCancel, async (runId: unknown) => ai.cancel(str(runId, 'run id', 64)))
	handle(IPC.gifStatus, async () => giphy.status())
	handle(IPC.gifSetKey, (key: unknown, persist: unknown) => giphy.setKey(str(key, 'GIPHY API key', 200), bool(persist, 'remember setting')))
	handle(IPC.gifRemoveKey, () => giphy.removeKey())
	handle(IPC.gifSearch, (query: unknown, offset: unknown) =>
		giphy.find(typeof query === 'string' ? query.slice(0, 200) : '', typeof offset === 'number' ? offset : -1),
	)
	// Questions go to the model picked for them; a finding without one goes to the model that raised it.
	handle(IPC.aiAsk, (reviewId: unknown, findingId: unknown, question: unknown) =>
		service.askFinding(
			comparisonId(reviewId),
			str(findingId, 'finding id', 64),
			str(question, 'question', 4000),
			connections.pickedAskModel(),
		),
	)
	handle(IPC.aiAskCode, async (reviewId: unknown, anchor: unknown, question: unknown, questionId: unknown) => {
		const selection = connections.view().questionModel
		if (!selection) throw new AppFail('ai-unavailable', 'Choose a model for questions first.')
		return service.askCode(
			comparisonId(reviewId),
			anchor,
			str(question, 'question', 4000),
			questionId === null ? null : str(questionId, 'question id', 64),
			selection,
		)
	})
	handle(IPC.aiDeleteCodeQuestion, (reviewId: unknown, questionId: unknown) =>
		service.deleteCodeQuestion(comparisonId(reviewId), str(questionId, 'question id', 64)),
	)
	handle(IPC.aiRetryRules, (reviewId: unknown, runId: unknown, rules: unknown) =>
		service.retryAiRules(comparisonId(reviewId), str(runId, 'run id', 64), reviewRules(rules)),
	)

	// Provider settings. Every handler returns the refreshed, secret-free settings view.
	const view = async <A extends Array<unknown>>(fn: (...a: A) => Promise<unknown>, ...a: A) => {
		await fn(...a)
		return connections.view()
	}
	handle(IPC.aiSettings, async () => connections.view())
	handle(IPC.aiCreateConnection, (input: unknown) => view(() => connections.create(newConnection(input))))
	handle(IPC.aiUpdateConnection, (id: unknown, patch: unknown) => view(() => connections.update(connectionId(id), connectionPatch(patch))))
	handle(IPC.aiRemoveConnection, (id: unknown) => view(() => connections.remove(connectionId(id))))
	handle(IPC.aiSetCredential, (id: unknown, key: unknown, persist: unknown) =>
		view(() => connections.setCredential(connectionId(id), apiKey(key), bool(persist, 'persist'))),
	)
	handle(IPC.aiTestConnection, (id: unknown) => view(() => connections.test(connectionId(id))))
	handle(IPC.aiRefreshModels, () => view(() => connections.refreshModels(PICKER_MODELS_MAX_AGE_MS)))
	handle(IPC.aiAddModel, (id: unknown, m: unknown) => view(() => connections.addModel(connectionId(id), modelId(m))))
	handle(IPC.aiRemoveModel, (id: unknown, m: unknown) => view(() => connections.removeModel(connectionId(id), modelId(m))))
	handle(IPC.aiProbeModel, (id: unknown, m: unknown) => view(() => connections.probeModel(connectionId(id), modelId(m))))
	handle(IPC.aiSelectModel, (sel: unknown) => view(() => connections.select(modelSelection(sel))))
	handle(IPC.aiSelectAskModel, (sel: unknown) => view(() => connections.selectAskModel(modelSelection(sel))))
	handle(IPC.aiSetLimits, (limits: unknown) => view(() => connections.setLimits(reviewLimits(limits))))
	handle(IPC.aiSetLevels, (levels: unknown) => view(() => connections.setLevels(findingLevels(levels))))
	handle(IPC.aiSaveTeam, (team: unknown) => view(() => connections.saveTeam(reviewTeam(team))))
	handle(IPC.aiRemoveTeam, (id: unknown) => view(() => connections.removeTeam(connectionId(id))))
	handle(IPC.aiSelectTeam, (id: unknown) => view(() => connections.selectTeam(connectionId(id))))

	// MCP servers for the reviewers. Every handler returns the refreshed view, which never holds secret values.
	const mcpView = async (fn: () => Promise<unknown>) => {
		await fn()
		return mcp.view()
	}
	const repoRoot = (repoId: unknown) => (repoId === null ? null : service.repoRoot(str(repoId, 'repository')))
	handle(IPC.mcpSettings, async () => mcp.view())
	handle(IPC.mcpSave, (id: unknown, input: unknown) =>
		mcpView(() => mcp.save(id === null ? null : str(id, 'server id', 64), mcpServerInput(input))),
	)
	handle(IPC.mcpRemove, (id: unknown) => mcpView(() => mcp.remove(str(id, 'server id', 64))))
	handle(IPC.mcpTest, (id: unknown, repoId: unknown) => mcpView(() => mcp.test(str(id, 'server id', 64), repoRoot(repoId))))
	handle(IPC.mcpSetTools, (id: unknown, allowed: unknown) => mcpView(() => mcp.setTools(str(id, 'server id', 64), mcpToolNames(allowed))))
	handle(IPC.mcpClaudeCandidates, (repoId: unknown) => mcp.claudeCandidates(repoRoot(repoId)))
	handle(IPC.mcpImportClaude, (repoId: unknown, keys: unknown) => mcpView(() => mcp.importClaude(repoRoot(repoId), mcpKeys(keys))))
}

function createWindow(): void {
	win = new BrowserWindow({
		width: 1440,
		height: 900,
		minWidth: 900,
		minHeight: 560,
		title: 'Review',
		icon: devIcon, // Windows and Linux; macOS uses the dock icon
		show: false,
		backgroundColor: nativeTheme.shouldUseDarkColors ? '#18191F' : '#FFFFFF',
		webPreferences: {
			preload: join(__dirname, '../preload/index.js'),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			webSecurity: true,
			spellcheck: false,
		},
	})
	win.once('ready-to-show', () => win?.show())

	// Never navigate away from the app or open windows; external http(s) links go to the system browser.
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:\/\//.test(url)) void shell.openExternal(url)
		return { action: 'deny' }
	})
	win.webContents.on('will-navigate', (e) => e.preventDefault())

	// Let the renderer save pending edits before the window goes away.
	let flushed = false
	let flushing = false
	win.on('close', (e) => {
		if (flushed || !win) return
		e.preventDefault()
		if (flushing) return
		flushing = true
		const w = win
		const done = (): void => {
			clearTimeout(timer)
			ipcMain.removeListener(IPC.flushDone, onDone)
			flushed = true
			void ai
				.flush()
				.then(() => Promise.all([store.flush(), connections.flush(), credentials.flush(), github.flush()]))
				.finally(() => (quitting ? app.quit() : w.close()))
		}
		const onDone = (ev: Electron.IpcMainEvent): void => {
			if (ev.sender === w.webContents) done()
		}
		const timer = setTimeout(done, 3000)
		ipcMain.on(IPC.flushDone, onDone)
		w.webContents.send(IPC.flushRequest)
	})
	win.on('closed', () => (win = null))

	if (rendererUrl) void win.loadURL(rendererUrl)
	else void win.loadFile(rendererFile)
}

app.whenReady().then(async () => {
	if (devIcon && process.platform === 'darwin') app.dock?.setIcon(devIcon)
	const dir = app.getPath('userData')
	store = ReviewStore.in(dir)
	await store.load()
	credentials = new CredentialService(dir, safeStorage)
	await credentials.load()
	giphy = new GiphyService(credentials)
	github = new GitHubService(credentials, { cli: ghCli, dir })
	await github.load()
	let connected = false
	github.onChange((s) => {
		if (win && !win.isDestroyed()) win.webContents.send(IPC.githubStatusChanged, s)
		// Check review requests as soon as GitHub connects, not only at the next interval.
		if (s.state === 'connected' && !connected) void watcher?.check()
		connected = s.state === 'connected'
	})
	void github.verify()
	service = new ReviewService(store, github)
	watcher = new InboxWatcher({
		github,
		store,
		known: () => service.knownGitHubRepos(),
		notify: showNotifications,
		badge: (n) => app.setBadgeCount(n),
		changed: () => {
			service.forgetMyReviews()
			if (win && !win.isDestroyed()) win.webContents.send(IPC.inboxChanged)
		},
	})
	watcher.start()
	// Timers do not run while the Mac sleeps, so check as soon as it wakes or unlocks, and when you come back to the app.
	powerMonitor.on('resume', () => void watcher.check())
	powerMonitor.on('unlock-screen', () => void watcher.check())
	app.on('browser-window-focus', () => watcher.checkIfOlder(30_000))
	// The fixture provider is offered in development builds only.
	connections = new ConnectionService(dir, credentials, sdkAdapters, { showDevelopment: !app.isPackaged })
	await connections.load()
	ai = new AiController(
		store,
		(selection) => connections.runConfig(selection),
		(run) => {
			if (win && !win.isDestroyed()) win.webContents.send(IPC.aiRunUpdate, run)
		},
	)
	connections.onRemoved((id) => ai.cancelForConnection(id))
	connections.onChange((v) => {
		if (win && !win.isDestroyed()) win.webContents.send(IPC.aiSettingsChanged, v)
	})
	// Pick up models added on the provider since the last "Test connection" (e.g. in a gateway's dashboard).
	void connections.refreshModels(MODELS_MAX_AGE_MS)
	app.on('browser-window-focus', () => void connections.refreshModels(MODELS_MAX_AGE_MS))
	await ai.recoverInterrupted()
	ai.attachTeams((id) => connections.team(id))
	service.attachAi(ai)
	mcp = new McpService(dir, credentials)
	await mcp.load()
	mcp.onChange((v) => {
		if (win && !win.isDestroyed()) win.webContents.send(IPC.mcpSettingsChanged, v)
	})
	service.attachMcp(mcp)
	registerIpc()
	createWindow()
	app.on('activate', () => {
		if (!win) createWindow()
	})
})

app.on('web-contents-created', (_e, contents) => {
	contents.on('will-attach-webview', (e) => e.preventDefault())
})

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit()
})

// Electron drops a notification's click handler once the object is garbage collected, so shown ones are kept here.
const shown = new Set<Notification>()

const EVENT_TITLE: Record<RepoEvent['kind'], string> = {
	requested: 'Review requested',
	're-requested': 'Review requested again',
	ready: 'Ready for review',
	updated: 'New commits since your review',
}

function showNotifications(events: Array<RepoEvent>): void {
	const silent = !github.notifications.sound
	// A burst (e.g. after the app was closed for a while) becomes one summary instead of a stack of banners.
	const batches =
		events.length > 3
			? [
					{
						title: events.every((e) => e.kind === 'updated')
							? `${events.length} reviewed pull requests have new commits`
							: events.some((e) => e.kind === 'updated')
								? `${events.length} review updates`
								: `${events.length} review requests`,
						body: events
							.slice(0, 3)
							.map((e) => `${e.pr.repo.split('/')[1]}#${e.pr.number} ${e.pr.title}`)
							.join('\n'),
						target: null,
					},
				]
			: events.map((e) => ({
					title: `${EVENT_TITLE[e.kind]}: ${e.pr.repo.split('/')[1]}#${e.pr.number}`,
					body: `${e.pr.title}${e.pr.author ? `\nby ${e.pr.author}` : ''}`,
					target: { repoId: e.repoId, repo: e.pr.repo, number: e.pr.number } satisfies InboxOpen,
				}))
	for (const b of batches) void present(new Notification({ title: b.title, body: b.body, silent }), b.target)
}

/**
 * Shows a notification and records whether the system allowed it, so Settings can say when notifications are blocked
 * instead of review requests going missing silently. Resolves once it is shown or refused (or after 5 s).
 */
function present(n: Notification, target: InboxOpen | null): Promise<void> {
	if (!Notification.isSupported()) {
		github.setNotificationProblem('This system does not support desktop notifications.')
		return Promise.resolve()
	}
	shown.add(n)
	n.on('click', () => {
		shown.delete(n)
		focusWindow((w) => target && w.webContents.send(IPC.inboxOpen, target))
	})
	n.on('close', () => shown.delete(n))
	return new Promise((resolve) => {
		const t = setTimeout(resolve, 5000)
		n.once('show', () => {
			clearTimeout(t)
			github.setNotificationProblem(null)
			resolve()
		})
		n.once('failed', (_e, error) => {
			clearTimeout(t)
			shown.delete(n)
			github.setNotificationProblem(
				process.platform === 'darwin'
					? `macOS is blocking notifications from this app. Allow them in System Settings → Notifications → ${app.isPackaged ? app.getName() : 'Electron'}. (${error})`
					: `The notification could not be shown: ${error}`,
			)
			resolve()
		})
		n.show()
	})
}

/** Brings the window forward (re-creating it if it was closed) and then runs `then` once its page is loaded. */
function focusWindow(then: (w: BrowserWindow) => void): void {
	if (!win || win.isDestroyed()) {
		createWindow()
		win!.webContents.once('did-finish-load', () => win && then(win))
	} else {
		if (win.isMinimized()) win.restore()
		then(win)
	}
	win!.show()
	win!.focus()
}
