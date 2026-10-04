// macOS refuses notifications from an app bundle that is not signed as a whole: it never asks for permission and the
// app never appears in System Settings → Notifications. The Electron that npm installs is only linker-signed, so the
// development build could not show review-request notifications. Signing the bundle locally (ad hoc, no identity)
// fixes that. Packaged builds are signed by the build and do not need this. Runs after every install; never fails it.
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

if (process.platform === 'darwin') {
	try {
		const binary = createRequire(import.meta.url)('electron') // …/Electron.app/Contents/MacOS/Electron
		const app = resolve(binary, '../../..')
		if (app.endsWith('.app') && existsSync(app)) {
			execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' })
			console.log(`Signed ${app} for local development (needed for macOS notifications).`)
		}
	} catch (e) {
		console.warn(`Could not sign Electron for local development; macOS notifications may not work: ${e instanceof Error ? e.message : e}`)
	}
}
