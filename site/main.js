// Points the main download button at the installer for the visitor's system and marks that row in the list.
// Browsers can't always tell Apple silicon from Intel; Chromium can, others get Apple silicon (every Mac sold since 2023).
const LABELS = {
	'mac-arm64': 'Download for macOS',
	'mac-x64': 'Download for macOS (Intel)',
	windows: 'Download for Windows',
	linux: 'Download for Linux',
}

async function detect() {
	const uad = navigator.userAgentData
	const platform = (uad?.platform || navigator.platform || navigator.userAgent).toLowerCase()
	if (/iphone|ipad|android/.test(navigator.userAgent.toLowerCase())) return null
	if (platform.includes('mac')) {
		try {
			const { architecture } = (await uad?.getHighEntropyValues(['architecture'])) ?? {}
			if (architecture === 'x86') return 'mac-x64'
		} catch {}
		return 'mac-arm64'
	}
	if (platform.includes('win')) return 'windows'
	if (platform.includes('linux')) return 'linux'
	return null
}

detect().then((key) => {
	if (!key) return
	const row = document.querySelector(`.files li[data-platform="${key}"]`)
	const button = document.getElementById('primary-download')
	if (!row || !button) return
	row.classList.add('is-yours')
	button.href = row.querySelector('a').href
	button.textContent = LABELS[key]
})
