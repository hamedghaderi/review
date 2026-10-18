// Runs on every github.com page. GitHub swaps pages without reloading, so the address is read when the key is
// pressed, not when the script starts. The page's content is never read, only its address.
;(() => {
	const DEFAULT_SHORTCUT = { key: 'r', code: 'KeyR', shift: true, alt: false, ctrl: false, meta: false }
	// Same shape as src/shared/link.ts: /<owner>/<repo>/pull/<n>, optionally followed by a tab such as /files.
	const PR_PATH = /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9]\d{0,9})(?:\/|$)/

	let shortcut = DEFAULT_SHORTCUT
	chrome.storage.sync.get({ shortcut: DEFAULT_SHORTCUT }, (v) => (shortcut = v.shortcut))
	chrome.storage.onChanged.addListener((changes) => {
		if (changes.shortcut) shortcut = changes.shortcut.newValue ?? DEFAULT_SHORTCUT
	})

	document.addEventListener('keydown', (e) => {
		if (e.repeat || e.isComposing || !matches(e, shortcut) || typing(e.target)) return
		const m = PR_PATH.exec(location.pathname)
		if (!m || m[2] === '.' || m[2] === '..') return
		e.preventDefault()
		location.href = `review-code://open/${m[1]}/${m[2]}/pull/${m[3]}`
	})

	// The physical key counts too: Option+R types "®" on a Mac, and other keyboard layouts type other letters.
	function matches(e, s) {
		const key = (e.key ?? '').toLowerCase() === s.key || (!!s.code && e.code === s.code)
		return key && e.shiftKey === s.shift && e.altKey === s.alt && e.ctrlKey === s.ctrl && e.metaKey === s.meta
	}

	// A comment box, the file filter or any other field keeps its keys.
	function typing(target) {
		return !!target && (target.isContentEditable || !!target.closest?.('input, textarea, select'))
	}
})()
