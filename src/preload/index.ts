import { contextBridge, ipcRenderer } from 'electron'
import {
	IPC,
	type AiRun,
	type AiSettingsView,
	type GitHubStatus,
	type InboxOpen,
	type McpSettingsView,
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
	markPrSeen: (repoId, n) => ipcRenderer.invoke(IPC.markPrSeen, repoId, n),
	openKnownRepo: (repoId) => ipcRenderer.invoke(IPC.openKnownRepo, repoId),
	closeRepoTab: (repoId) => ipcRenderer.invoke(IPC.closeRepoTab, repoId),
	repoTabs: () => ipcRenderer.invoke(IPC.repoTabs),
	addContextImage: (name, bytes) => ipcRenderer.invoke(IPC.addContextImage, name, bytes),
	contextImage: (id, mediaType) => ipcRenderer.invoke(IPC.contextImage, id, mediaType),
	onInboxOpen: (handler) => {
		const listener = (_e: Electron.IpcRendererEvent, target: InboxOpen): void => handler(target)
		ipcRenderer.on(IPC.inboxOpen, listener)
		return () => ipcRenderer.removeListener(IPC.inboxOpen, listener)
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
	loadPatch: (comparisonId, fileKey, force) => ipcRenderer.invoke(IPC.loadPatch, comparisonId, fileKey, force),
	loadFileLines: (comparisonId, fileKey) => ipcRenderer.invoke(IPC.loadFileLines, comparisonId, fileKey),
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
	setReviewLimits: (limits) => ipcRenderer.invoke(IPC.aiSetLimits, limits),
	setFindingLevels: (levels) => ipcRenderer.invoke(IPC.aiSetLevels, levels),
	askFinding: (reviewId, findingId, question) => ipcRenderer.invoke(IPC.aiAsk, reviewId, findingId, question),
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
	cancelAiReview: (runId) => ipcRenderer.invoke(IPC.aiCancel, runId),
	retryAiRules: (reviewId, runId, rules) => ipcRenderer.invoke(IPC.aiRetryRules, reviewId, runId, rules),
	onAiRunUpdate: (handler) => {
		const listener = (_e: Electron.IpcRendererEvent, run: AiRun): void => handler(run)
		ipcRenderer.on(IPC.aiRunUpdate, listener)
		return () => ipcRenderer.removeListener(IPC.aiRunUpdate, listener)
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
