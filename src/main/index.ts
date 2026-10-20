import { mkdir, realpath } from 'node:fs/promises'
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
import { IPC, type AppUpdate, type InboxOpen, type Result } from '../shared/types.ts'
import { sdkAdapters } from './ai/adapters.ts'
import { ConnectionService } from './ai/connections.ts'
import { AiController } from './ai/controller.ts'
import { CredentialService } from './ai/credentials.ts'
import { McpService } from './ai/mcp.ts'
import { AppFail, setAppCloneRoots, setManagedClones } from './git.ts'
import { ghCli } from './ghcli.ts'
import { GitHubService } from './github.ts'
import { AutoReviewer } from './autoReview.ts'
import { InboxWatcher, type RepoEvent, type WatchEvent } from './inboxWatch.ts'
import { GiphyService } from './giphy.ts'
import { ReviewService } from './service.ts'
import { ReviewStore } from './store.ts'
import { LINK_SCHEME, linkInArgs, parsePrLink, type PrLink } from '../shared/link.ts'
import { download, newerRelease, RELEASES_URL, type Release } from './update.ts'
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
	prDescriptionText,
	prQuery,
	reviewBody,
	reviewEvent,
	comparisonId,
	repoPath,
	symbolName,
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
let autoReviewer: AutoReviewer
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

// Pull request links from a browser (review-code://open/owner/repo/pull/n). One instance handles them all: a second
// launch (Windows and Linux pass the link on its command line) hands its link over and quits.
const primary = app.requestSingleInstanceLock()
let pendingLink: PrLink | null = null
if (!primary) app.quit()
else {
	app.on('second-instance', (_e, argv) => {
		const link = linkInArgs(argv)
		if (link) receiveLink(link)
		else if (app.isReady()) focusWindow(() => {})
	})
	// macOS delivers links as events, the first one possibly before the app is ready.
	app.on('open-url', (e, url) => {
		e.preventDefault()
		receiveLink(url)
	})
	receiveLink(linkInArgs(process.argv))
	// Installers register the scheme too; a development build would register the bare Electron binary instead.
	if (app.isPackaged) app.setAsDefaultProtocolClient(LINK_SCHEME)
}

/** Keeps the newest valid link for the window to take; anything else that arrives under the scheme is ignored. */
function receiveLink(raw: string | null): void {
	const link = raw ? parsePrLink(raw) : null
	if (!link) return
	pendingLink = link
	// Before the window exists, the renderer takes the link when it starts.
	if (app.isReady()) focusWindow((w) => w.webContents.send(IPC.linkOpen))
}

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

// The header Git uses for the app's own clones, kept only in memory and following the GitHub connection.
let cloneAuth: string | null = null
// The folder last picked for a clone; cloning goes only there.
let chosenCloneParent: string | null = null
async function refreshCloneAuth(): Promise<void> {
	cloneAuth = await github.gitAuthHeader()
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
	handle(IPC.githubSetAutoReview, async (enabled: unknown) => {
		await github.setAutoReview(bool(enabled, 'automatic review'))
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
	handle(IPC.updateStatus, async () => pendingUpdate())
	handle(IPC.installUpdate, async () => {
		await installUpdate()
		return true
	})
	handle(IPC.skipUpdate, async (version: unknown) => {
		const v = str(version, 'version', 64)
		await store.update((d) => void (d.skippedVersion = v))
		return true
	})
	handle(IPC.markPrSeen, (repoId: unknown, n: unknown) => service.markPrSeen(str(repoId, 'repository'), prNumber(n)))
	handle(IPC.openKnownRepo, (repoId: unknown) => service.openKnown(str(repoId, 'repository')))
	handle(IPC.closeRepoTab, (repoId: unknown) => service.closeTab(str(repoId, 'repository')))
	handle(IPC.repoTabs, async () => service.tabs())
	handle(IPC.chooseCloneFolder, async (repo: unknown) => {
		const name = githubRepo(repo)
		const r = await dialog.showOpenDialog(win!, {
			title: `Clone ${name}`,
			message: `Choose a folder. The clone goes in a new “${name.split('/')[1]}” folder inside it.`,
			buttonLabel: 'Clone here',
			defaultPath: store.read().cloneParent ?? app.getPath('home'),
			properties: ['openDirectory', 'createDirectory'],
		})
		if (r.canceled || !r.filePaths[0]) return null
		chosenCloneParent = await realpath(r.filePaths[0])
		return chosenCloneParent
	})
	handle(IPC.openGitHubClone, async (repo: unknown, parent: unknown) => {
		const name = githubRepo(repo)
		// Only ever where you just chose in the folder picker.
		if (typeof parent !== 'string' || parent !== chosenCloneParent)
			throw new AppFail('invalid-input', 'Choose the folder to clone into first.')
		await refreshCloneAuth()
		return service.openGitHubClone(name, parent)
	})
	handle(IPC.appClones, () => service.appClones())
	handle(IPC.deleteAppClone, async (repoId: unknown) => {
		const id = str(repoId, 'repository')
		const { root, repo, missing } = await service.appCloneOf(id)
		const forget = 'The app also forgets this repository and its reviews, including comments you have not published.'
		const { response } = await dialog.showMessageBox(win!, {
			type: 'warning',
			buttons: [missing ? 'Forget it' : 'Move to Trash', 'Cancel'],
			defaultId: 1,
			cancelId: 1,
			message: `Delete the app's clone of ${repo}?`,
			detail: missing ? `${root} is already gone. ${forget}` : `${root} moves to the Trash. ${forget}`,
		})
		if (response !== 0) return { deleted: false, tabs: service.tabs() }
		return { deleted: true, tabs: await service.deleteAppClone(id, (p) => shell.trashItem(p)) }
	})
	handle(IPC.revealAppClone, async (repoId: unknown) => {
		shell.showItemInFolder((await service.appCloneOf(str(repoId, 'repository'))).root)
		return true
	})
	handle(IPC.homeInbox, async () => service.homeInbox())
	handle(IPC.refreshHome, async () => {
		await watcher.check()
		return service.homeInbox()
	})
	handle(IPC.setRepoMuted, async (repo: unknown, muted: unknown) => {
		const home = await service.setRepoMuted(githubRepo(repo), bool(muted, 'muted'))
		void watcher.check() // the badge follows
		return home
	})
	handle(IPC.takeLink, async () => {
		const link = pendingLink
		pendingLink = null
		return link ? { ...link, repoId: service.knownGitHubRepos().get(link.repo.toLowerCase()) ?? null } : null
	})
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
	handle(IPC.prDescription, (repoId: unknown, reviewId: unknown) =>
		service.prDescription(str(repoId, 'repository'), comparisonId(reviewId)),
	)
	handle(IPC.headChecks, (repoId: unknown, reviewId: unknown) => service.headChecks(str(repoId, 'repository'), comparisonId(reviewId)))
	handle(IPC.prDescriptionPreview, (repoId: unknown, reviewId: unknown, text: unknown) =>
		service.previewDescription(str(repoId, 'repository'), comparisonId(reviewId), prDescriptionText(text)),
	)
	handle(IPC.prDescriptionUpdate, (repoId: unknown, reviewId: unknown, expected: unknown, body: unknown) =>
		service.updateDescription(
			str(repoId, 'repository'),
			comparisonId(reviewId),
			prDescriptionText(expected, 'previous description'),
			prDescriptionText(body),
		),
	)

	// Publishing to GitHub. Only explicit user actions reach these; automatic review (off by default) publishes from the main process.
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
	handle(IPC.replyToThread, (repoId: unknown, reviewId: unknown, threadId: unknown, body: unknown, resolve: unknown) =>
		service.replyToThread(
			str(repoId, 'repository'),
			comparisonId(reviewId),
			str(threadId, 'thread id', 128),
			reviewBody(body),
			bool(resolve, 'resolve'),
		),
	)
	handle(IPC.loadPatch, (cid: unknown, key: unknown, force: unknown) =>
		service.loadPatch(comparisonId(cid), str(key, 'file'), bool(force, 'force')),
	)
	handle(IPC.loadFileLines, (cid: unknown, key: unknown) => service.loadFileLines(comparisonId(cid), str(key, 'file')))
	handle(IPC.loadFileAt, (cid: unknown, path: unknown, side: unknown) =>
		service.loadFileAt(comparisonId(cid), repoPath(path), side === 'old' ? 'old' : 'new'),
	)
	handle(IPC.lookupSymbol, (cid: unknown, name: unknown, side: unknown, kind: unknown) =>
		service.lookupSymbol(comparisonId(cid), symbolName(name), side === 'old' ? 'old' : 'new', kind === 'uses' ? 'uses' : 'definition'),
	)
	handle(IPC.saveReview, (review: unknown) => service.saveReview(review))
	handle(IPC.aiStart, (reviewId: unknown, scope: unknown, reviewer: unknown) => {
		const choice = reviewerChoice(reviewer)
		connections.checkChoice(choice)
		return service.startAi(comparisonId(reviewId), scope, choice)
	})
	handle(IPC.aiIncremental, async (reviewId: unknown, reviewer: unknown) =>
		service.incrementalOffer(comparisonId(reviewId), reviewerChoice(reviewer)),
	)
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
	if (!primary) return
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
	setManagedClones(() => cloneAuth)
	setAppCloneRoots(Object.keys(store.read().appClones ?? {}))
	github.onChange(() => void refreshCloneAuth())
	void refreshCloneAuth()
	service = new ReviewService(store, github)
	watcher = new InboxWatcher({
		github,
		store,
		known: () => service.knownGitHubRepos(),
		notify: (events) => {
			if (github.notifications.enabled) showNotifications(events)
			// Automatic review works in a clone, so only repositories opened in the app take part.
			autoReviewer.take(events.filter((e): e is RepoEvent => e.repoId !== null))
		},
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
	ai.attachLevels(() => connections.view().levels.enabled)
	service.attachAi(ai)
	mcp = new McpService(dir, credentials)
	await mcp.load()
	mcp.onChange((v) => {
		if (win && !win.isDestroyed()) win.webContents.send(IPC.mcpSettingsChanged, v)
	})
	service.attachMcp(mcp)
	autoReviewer = new AutoReviewer({
		store,
		enabled: () => github.autoReview,
		viewer: () => github.status().login,
		reviewer: () => {
			const v = connections.view()
			if (!v.reviewer) throw new AppFail('ai-unavailable', v.selectionIssue ?? 'Choose a model or team for AI reviews first.')
			connections.checkChoice(v.reviewer)
			const r = v.reviewer
			const label = r.kind === 'team' ? (v.teams.find((t) => t.id === r.teamId)?.name ?? 'a review team') : r.selection.modelId
			return { choice: r, label }
		},
		levels: () => connections.view().levels.autoAdd,
		busy: () => ai.busy,
		runsFor: (repoId, reviewId) => ai.runsFor(repoId, reviewId),
		whenDone: (runId) => ai.whenDone(runId),
		open: (repoId, pr, signal) => service.openInBackground(repoId, pr, signal),
		start: (reviewId, choice, label) => service.startAutoAi(reviewId, choice, label),
		addFindings: (repoId, reviewId, runId, levels) => service.addAutoFindings(repoId, reviewId, runId, levels),
		plan: (repoId, reviewId) => service.publishPlan(repoId, reviewId),
		publish: (repoId, reviewId, commentId, outside) => service.publishComment(repoId, reviewId, commentId, outside),
		submit: (repoId, reviewId, event, body) => service.submitReview(repoId, reviewId, event, body),
		checks: (repoId, reviewId) => service.headChecks(repoId, reviewId),
		reviewChanged: (repoId, reviewId) => {
			const r = store.read().repos[repoId]?.reviews[reviewId]
			if (r && win && !win.isDestroyed()) win.webContents.send(IPC.reviewChanged, r)
		},
		finished: (e, record) => {
			// The app acted as you, so this is shown even with review-request notifications off.
			void present(
				new Notification({
					title: `Automatic review: ${e.pr.repo.split('/')[1]}#${e.pr.number}`,
					body: record.message,
					silent: !github.notifications.sound,
				}),
				{ repoId: e.repoId, repo: e.pr.repo, number: e.pr.number },
			)
		},
	})
	registerIpc()
	createWindow()
	app.on('activate', () => {
		if (!win) createWindow()
	})
	if (runningVersion) {
		void checkForUpdate()
		setInterval(() => void checkForUpdate(), 12 * 60 * 60_000)
	}
})

// Development runs skip the update check; `REVIEW_UPDATE_FROM=0.1.0 npm run dev` pretends to be that version to try it.
const runningVersion = app.isPackaged ? app.getVersion() : (process.env.REVIEW_UPDATE_FROM ?? null)
let newest: Release | null = null
let announcedVersion: string | null = null
let installing: Promise<void> | null = null

function pendingUpdate(): AppUpdate | null {
	if (!newest || newest.version === store.read().skippedVersion) return null
	const canInstall = !!newest.asset && (process.platform !== 'linux' || !!process.env.APPIMAGE)
	return { version: newest.version, current: runningVersion!, url: RELEASES_URL, canInstall }
}

/**
 * There is no auto-update (the app isn't Developer ID signed), so a newer GitHub release is announced: a banner in the
 * window, and a notification once per version per run that brings the window forward. A skipped version stays quiet.
 */
async function checkForUpdate(): Promise<void> {
	newest = (await newerRelease(runningVersion!, process.platform, process.arch)) ?? newest
	const update = pendingUpdate()
	if (!update) return
	if (win && !win.isDestroyed()) win.webContents.send(IPC.updateAvailable, update)
	const version = update.version
	if (version === announcedVersion || !Notification.isSupported()) return
	announcedVersion = version
	const n = new Notification({ title: `Review ${version} is available`, body: `You have ${runningVersion}. Click to update.` })
	shown.add(n)
	n.on('click', () => {
		shown.delete(n)
		focusWindow(() => {})
	})
	n.on('close', () => shown.delete(n))
	n.show()
}

/**
 * Downloads this system's installer and hands over to it. macOS opens the disk image (drag Review to Applications) and
 * Windows runs the setup, then the app quits so it can be replaced. A Linux AppImage replaces itself and restarts.
 */
function installUpdate(): Promise<void> {
	installing ??= (async () => {
		const asset = newest?.asset
		if (!asset) throw new Error('This release has no installer for your system. Download it from GitHub.')
		const progress = (fraction: number): void => {
			if (win && !win.isDestroyed()) win.webContents.send(IPC.updateProgress, fraction)
		}
		if (process.platform === 'linux') {
			const target = process.env.APPIMAGE
			if (!target) throw new Error('Only the AppImage can update itself. Download the new version from GitHub.')
			await download(asset, target, progress)
			app.relaunch({ execPath: target })
			app.quit()
			return
		}
		const dir = join(app.getPath('temp'), 'review-update')
		await mkdir(dir, { recursive: true })
		const file = join(dir, asset.name)
		await download(asset, file, progress)
		const error = await shell.openPath(file)
		if (error) throw new Error(`The installer was downloaded to ${file} but could not be opened: ${error}`)
		app.quit()
	})().finally(() => (installing = null))
	return installing
}

app.on('web-contents-created', (_e, contents) => {
	contents.on('will-attach-webview', (e) => e.preventDefault())
})

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit()
})

// Electron drops a notification's click handler once the object is garbage collected, so shown ones are kept here.
const shown = new Set<Notification>()

const EVENT_TITLE: Record<WatchEvent['kind'], string> = {
	requested: 'Review requested',
	're-requested': 'Review requested again',
	ready: 'Ready for review',
	updated: 'New commits since your review',
}

function showNotifications(events: Array<WatchEvent>): void {
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
