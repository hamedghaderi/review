import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { AppFail } from './git.ts'
import type { EditorChoice } from '../shared/types.ts'

/** Editors Review can open a folder in: by app name on macOS, by command on Windows and Linux. */
export const EDITORS: Array<{ id: string; label: string; mac: Array<string>; cli: Array<string> }> = [
	{ id: 'vscode', label: 'Visual Studio Code', mac: ['Visual Studio Code'], cli: ['code'] },
	{ id: 'cursor', label: 'Cursor', mac: ['Cursor'], cli: ['cursor'] },
	{ id: 'zed', label: 'Zed', mac: ['Zed', 'Zed Preview'], cli: ['zed', 'zeditor'] },
	{ id: 'windsurf', label: 'Windsurf', mac: ['Windsurf'], cli: ['windsurf'] },
	{ id: 'vscodium', label: 'VSCodium', mac: ['VSCodium'], cli: ['codium'] },
	{ id: 'sublime', label: 'Sublime Text', mac: ['Sublime Text'], cli: ['subl'] },
	{ id: 'intellij', label: 'IntelliJ IDEA', mac: ['IntelliJ IDEA', 'IntelliJ IDEA Ultimate', 'IntelliJ IDEA CE'], cli: ['idea'] },
	{ id: 'webstorm', label: 'WebStorm', mac: ['WebStorm'], cli: ['webstorm'] },
	{ id: 'pycharm', label: 'PyCharm', mac: ['PyCharm', 'PyCharm Professional Edition', 'PyCharm CE'], cli: ['pycharm'] },
	{ id: 'goland', label: 'GoLand', mac: ['GoLand'], cli: ['goland'] },
	{ id: 'phpstorm', label: 'PhpStorm', mac: ['PhpStorm'], cli: ['phpstorm'] },
	{ id: 'rubymine', label: 'RubyMine', mac: ['RubyMine'], cli: ['rubymine'] },
	{ id: 'rider', label: 'Rider', mac: ['Rider'], cli: ['rider'] },
	{ id: 'clion', label: 'CLion', mac: ['CLion'], cli: ['clion'] },
]

export interface FoundEditor {
	id: string
	label: string
	path: string // the .app bundle on macOS, else the command
}

/**
 * The editors installed, in the list's order. macOS looks for the app in /Applications and ~/Applications (where
 * JetBrains Toolbox puts its IDEs); elsewhere, for the command on PATH.
 */
export async function findEditors(
	platform: NodeJS.Platform,
	home: string,
	pathEnv: string,
	exists: (p: string) => Promise<boolean>,
): Promise<Array<FoundEditor>> {
	const win = platform === 'win32'
	const dirs = platform === 'darwin' ? ['/Applications', join(home, 'Applications')] : pathEnv.split(win ? ';' : ':').filter(Boolean)
	const names = (e: (typeof EDITORS)[number]): Array<string> =>
		platform === 'darwin' ? e.mac.map((n) => `${n}.app`) : win ? e.cli.flatMap((c) => [`${c}.exe`, `${c}.cmd`]) : e.cli
	const out: Array<FoundEditor> = []
	for (const e of EDITORS) {
		const candidates = dirs.flatMap((d) => names(e).map((n) => join(d, n)))
		for (const p of candidates)
			if (await exists(p)) {
				out.push({ id: e.id, label: e.label, path: p })
				break
			}
	}
	return out
}

/** The one to use: the chosen editor when still installed, else the first one found. */
export function pickEditor(found: Array<FoundEditor>, chosen: string | undefined): FoundEditor | null {
	return found.find((e) => e.id === chosen) ?? found[0] ?? null
}

export function editorChoice(found: Array<FoundEditor>, chosen: string | undefined): EditorChoice {
	return { installed: found.map(({ id, label }) => ({ id, label })), chosen: found.some((e) => e.id === chosen) ? chosen! : null }
}

/** Opens `folder` in the editor, without waiting for it to close. */
export function launchEditor(editor: FoundEditor, folder: string, platform: NodeJS.Platform): Promise<void> {
	// A .cmd needs cmd.exe; neither path can hold a double quote on Windows, so quoting them is enough.
	const [cmd, args, verbatim] =
		platform === 'darwin'
			? ['open', ['-a', editor.path, folder], false]
			: platform === 'win32' && editor.path.endsWith('.cmd')
				? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${editor.path}" "${folder}""`], true]
				: [editor.path, [folder], false]
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: verbatim })
		child.once('error', (e) => reject(new AppFail('not-found', `Couldn't open ${editor.label}: ${e.message}`)))
		child.once('spawn', () => {
			child.unref()
			resolve()
		})
	})
}
