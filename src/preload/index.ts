import { contextBridge, ipcRenderer } from 'electron'
import {
	IPC,
	type AiRun,
	type AiSettingsView,
	type AppUpdate,
	type GitHubStatus,
	type InboxOpen,
	type McpSettingsView,
	type Review,
	type ReviewApi,
} from '../shared/types.ts'

const api: ReviewApi = {
	openRepository: () => ipcRenderer.invoke(IPC.openRepository),
	restoreLast: () => ipcRenderer.invoke(IPC.restoreLast),
	refreshRepo: (repoId) => ipcRenderer.invoke(IPC.refreshRepo, repoId),
	loadComparison: (repoId, target) => ipcRenderer.invoke(IPC.loadComparison, repoId, target),
	probeTarget: (repoId, reviewId) => ipcRenderer.invoke(IPC.probeTarget, repoId, reviewId),
	branchPreview: (repoId, head, base) => ipcRenderer.invoke(IPC.branchPreview, repoId, head, base),
	saveBrowserState: (repoId, state) => ipcRenderer.invoke(IPC.saveBrowserState, repoId, state),
	cancelOpen: () => ipcRenderer.invoke(IPC.cancelOpen),
	githubStatus: () => ipcRenderer.invoke(IPC.githubStatus),
	onGitHubStatus: (handler) => {
		const listener = (_e: Electron.IpcRendererEvent, s: GitHubStatus): void => handler(s)
		ipcRenderer.on(IPC.githubStatusChanged, listener)
		return () => ipcRenderer.removeListener(IPC.githubStatusChanged, listener)
	},
	githubSetToken: (token, persist) => ipcRenderer.invoke(IPC.githubSetToken, token, persist),
	githubDisconnect: () => ipcRenderer.invoke(IPC.githubDisconnect),
	githubVerify: () => ipcRenderer.invoke(IPC.githubVerify),
	githubUseCli: (enabled) => ipcRenderer.invoke(IPC.githubUseCli, enabled),
	githubSetNotifications: (prefs) => ipcRenderer.invoke(IPC.githubSetNotifications, prefs),
	githubTestNotification: () => ipcRenderer.invoke(IPC.githubTestNotification),
	githubSetAutoReview: (enabled) => ipcRenderer.invoke(IPC.githubSetAutoReview, enabled),
	markPrSeen: (repoId, n) => ipcRenderer.invoke(IPC.markPrSeen, repoId, n),
	openKnownRepo: (repoId) => ipcRenderer.invoke(IPC.openKnownRepo, repoId),
	closeRepoTab: (repoId) => ipcRenderer.invoke(IPC.closeRepoTab, repoId),
	repoTabs: () => ipcRenderer.invoke(IPC.repoTabs),
	homeInbox: () => ipcRenderer.invoke(IPC.homeInbox),
	refreshHome: () => ipcRenderer.invoke(IPC.refreshHome),
	setRepoMuted: (repo, muted) => ipcRenderer.invoke(IPC.setRepoMuted, repo, muted),
	chooseCloneFolder: (repo) => ipcRenderer.invoke(IPC.chooseCloneFolder, repo),
	openGitHubClone: (repo, parent) => ipcRenderer.invoke(IPC.openGitHubClone, repo, parent),
	appClones: () => ipcRenderer.invoke(IPC.appClones),
	deleteAppClone: (repoId) => ipcRenderer.invoke(IPC.deleteAppClone, repoId),
	revealAppClone: (repoId) => ipcRenderer.invoke(IPC.revealAppClone, repoId),
	addContextImage: (name, bytes) => ipcRenderer.invoke(IPC.addContextImage, name, bytes),
	contextImage: (id, mediaType) => ipcRenderer.invoke(IPC.contextImage, id, mediaType),
	takeLink: () => ipcRenderer.invoke(IPC.takeLink),
	onLinkOpen: (handler) => {
		const listener = (): void => handler()
		ipcRenderer.on(IPC.linkOpen, listener)
		return () => ipcRenderer.removeListener(IPC.linkOpen, listener)
	},
	onInboxOpen: (handler) => {
		const listener = (_e: Electron.IpcRendererEvent, target: InboxOpen): void => handler(target)
		ipcRenderer.on(IPC.inboxOpen, listener)
		return () => ipcRenderer.removeListener(IPC.inboxOpen, listener)
	},
	onReviewChanged: (handler) => {
		const listener = (_e: Electron.IpcRendererEvent, review: Review): void => handler(review)
		ipcRenderer.on(IPC.reviewChanged, listener)
		return () => ipcRenderer.removeListener(IPC.reviewChanged, listener)
	},
	onInboxChanged: (handler) => {
		const listener = (): void => handler()
		ipcRenderer.on(IPC.inboxChanged, listener)
		return () => ipcRenderer.removeListener(IPC.inboxChanged, listener)
	},
	githubSetRepo: (repoId, repo) => ipcRenderer.invoke(IPC.githubSetRepo, repoId, repo),
	searchPrs: (repoId, q, slot) => ipcRenderer.invoke(IPC.searchPrs, repoId, q, slot),
	prDetail: (repoId, n) => ipcRenderer.invoke(IPC.prDetail, repoId, n),
	prGraph: (repoId) => ipcRenderer.invoke(IPC.prGraph, repoId),
	myReviews: (repoId) => ipcRenderer.invoke(IPC.myReviews, repoId),
	branchPr: (repoId, head) => ipcRenderer.invoke(IPC.branchPr, repoId, head),
	publishPlan: (repoId, reviewId) => ipcRenderer.invoke(IPC.publishPlan, repoId, reviewId),
	publishComment: (repoId, reviewId, commentId, outside) => ipcRenderer.invoke(IPC.publishComment, repoId, reviewId, commentId, outside),
	submitReview: (repoId, reviewId, event, body) => ipcRenderer.invoke(IPC.submitReview, repoId, reviewId, event, body),
	prDiscussion: (repoId, reviewId) => ipcRenderer.invoke(IPC.prDiscussion, repoId, reviewId),
	prDescription: (repoId, reviewId) => ipcRenderer.invoke(IPC.prDescription, repoId, reviewId),
	headChecks: (repoId, reviewId) => ipcRenderer.invoke(IPC.headChecks, repoId, reviewId),
	prDescriptionPreview: (repoId, reviewId, text) => ipcRenderer.invoke(IPC.prDescriptionPreview, repoId, reviewId, text),
	prDescriptionUpdate: (repoId, reviewId, expected, body) => ipcRenderer.invoke(IPC.prDescriptionUpdate, repoId, reviewId, expected, body),
	replyToThread: (repoId, reviewId, threadId, body, resolve) =>
		ipcRenderer.invoke(IPC.replyToThread, repoId, reviewId, threadId, body, resolve),
	loadPatch: (comparisonId, fileKey, force) => ipcRenderer.invoke(IPC.loadPatch, comparisonId, fileKey, force),
	loadFileLines: (comparisonId, fileKey) => ipcRenderer.invoke(IPC.loadFileLines, comparisonId, fileKey),
	loadFileAt: (comparisonId, path, side) => ipcRenderer.invoke(IPC.loadFileAt, comparisonId, path, side),
	filesAtHead: (comparisonId, paths) => ipcRenderer.invoke(IPC.filesAtHead, comparisonId, paths),
	lookupSymbol: (comparisonId, name, side, kind) => ipcRenderer.invoke(IPC.lookupSymbol, comparisonId, name, side, kind),
	saveReview: (review) => ipcRenderer.invoke(IPC.saveReview, review),
	getAiSettings: () => ipcRenderer.invoke(IPC.aiSettings),
	onAiSettingsChanged: (handler) => {
		const listener = (_e: Electron.IpcRendererEvent, view: AiSettingsView): void => handler(view)
		ipcRenderer.on(IPC.aiSettingsChanged, listener)
		return () => ipcRenderer.removeListener(IPC.aiSettingsChanged, listener)
	},
	createConnection: (input) => ipcRenderer.invoke(IPC.aiCreateConnection, input),
	updateConnection: (id, patch) => ipcRenderer.invoke(IPC.aiUpdateConnection, id, patch),
	removeConnection: (id) => ipcRenderer.invoke(IPC.aiRemoveConnection, id),
	setCredential: (id, key, persist) => ipcRenderer.invoke(IPC.aiSetCredential, id, key, persist),
	testConnection: (id) => ipcRenderer.invoke(IPC.aiTestConnection, id),
	refreshModels: () => ipcRenderer.invoke(IPC.aiRefreshModels),
	addModel: (id, model) => ipcRenderer.invoke(IPC.aiAddModel, id, model),
	removeModel: (id, model) => ipcRenderer.invoke(IPC.aiRemoveModel, id, model),
	probeModel: (id, model) => ipcRenderer.invoke(IPC.aiProbeModel, id, model),
	selectModel: (selection) => ipcRenderer.invoke(IPC.aiSelectModel, selection),
	selectAskModel: (selection) => ipcRenderer.invoke(IPC.aiSelectAskModel, selection),
	setReviewLimits: (limits) => ipcRenderer.invoke(IPC.aiSetLimits, limits),
	setFindingLevels: (levels) => ipcRenderer.invoke(IPC.aiSetLevels, levels),
	askFinding: (reviewId, findingId, question) => ipcRenderer.invoke(IPC.aiAsk, reviewId, findingId, question),
	verifyFinding: (reviewId, findingId) => ipcRenderer.invoke(IPC.aiVerify, reviewId, findingId),
	writeFindingTest: (reviewId, findingId) => ipcRenderer.invoke(IPC.aiWriteTest, reviewId, findingId),
	askCode: (reviewId, anchor, question, questionId) => ipcRenderer.invoke(IPC.aiAskCode, reviewId, anchor, question, questionId),
	deleteCodeQuestion: (reviewId, questionId) => ipcRenderer.invoke(IPC.aiDeleteCodeQuestion, reviewId, questionId),
	gifStatus: () => ipcRenderer.invoke(IPC.gifStatus),
	gifSetKey: (key, persist) => ipcRenderer.invoke(IPC.gifSetKey, key, persist),
	gifRemoveKey: () => ipcRenderer.invoke(IPC.gifRemoveKey),
	gifSearch: (query, offset) => ipcRenderer.invoke(IPC.gifSearch, query, offset ?? 0),
	saveTeam: (team) => ipcRenderer.invoke(IPC.aiSaveTeam, team),
	removeTeam: (id) => ipcRenderer.invoke(IPC.aiRemoveTeam, id),
	selectTeam: (id) => ipcRenderer.invoke(IPC.aiSelectTeam, id),
	mcpSettings: () => ipcRenderer.invoke(IPC.mcpSettings),
	onMcpSettingsChanged: (handler) => {
		const listener = (_e: Electron.IpcRendererEvent, view: McpSettingsView): void => handler(view)
		ipcRenderer.on(IPC.mcpSettingsChanged, listener)
		return () => ipcRenderer.removeListener(IPC.mcpSettingsChanged, listener)
	},
	mcpSave: (id, input) => ipcRenderer.invoke(IPC.mcpSave, id, input),
	mcpRemove: (id) => ipcRenderer.invoke(IPC.mcpRemove, id),
	mcpTest: (id, repoId) => ipcRenderer.invoke(IPC.mcpTest, id, repoId),
	mcpSetTools: (id, allowed) => ipcRenderer.invoke(IPC.mcpSetTools, id, allowed),
	mcpClaudeCandidates: (repoId) => ipcRenderer.invoke(IPC.mcpClaudeCandidates, repoId),
	mcpImportClaude: (repoId, keys) => ipcRenderer.invoke(IPC.mcpImportClaude, repoId, keys),
	startAiReview: (reviewId, scope, reviewer) => ipcRenderer.invoke(IPC.aiStart, reviewId, scope, reviewer),
	incrementalOffer: (reviewId, reviewer) => ipcRenderer.invoke(IPC.aiIncremental, reviewId, reviewer),
	cancelAiReview: (runId) => ipcRenderer.invoke(IPC.aiCancel, runId),
	retryAiRules: (reviewId, runId, rules) => ipcRenderer.invoke(IPC.aiRetryRules, reviewId, runId, rules),
	onAiRunUpdate: (handler) => {
		const listener = (_e: Electron.IpcRendererEvent, run: AiRun): void => handler(run)
		ipcRenderer.on(IPC.aiRunUpdate, listener)
		return () => ipcRenderer.removeListener(IPC.aiRunUpdate, listener)
	},
	updateStatus: () => ipcRenderer.invoke(IPC.updateStatus),
	onUpdateAvailable: (handler) => {
		const listener = (_e: Electron.IpcRendererEvent, update: AppUpdate): void => handler(update)
		ipcRenderer.on(IPC.updateAvailable, listener)
		return () => ipcRenderer.removeListener(IPC.updateAvailable, listener)
	},
	skipUpdate: (version) => ipcRenderer.invoke(IPC.skipUpdate, version),
	installUpdate: () => ipcRenderer.invoke(IPC.installUpdate),
	onUpdateProgress: (handler) => {
		const listener = (_e: Electron.IpcRendererEvent, fraction: number): void => handler(fraction)
		ipcRenderer.on(IPC.updateProgress, listener)
		return () => ipcRenderer.removeListener(IPC.updateProgress, listener)
	},
	onFlushRequest: (handler) => {
		const listener = (): void => {
			void handler().finally(() => ipcRenderer.send(IPC.flushDone))
		}
		ipcRenderer.on(IPC.flushRequest, listener)
		return () => ipcRenderer.removeListener(IPC.flushRequest, listener)
	},
}

contextBridge.exposeInMainWorld('review', api)
