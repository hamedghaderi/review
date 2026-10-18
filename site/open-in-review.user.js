// ==UserScript==
// @name         Open in Review
// @namespace    https://review-code.dev/
// @version      1.0.0
// @description  Press Shift+R on a GitHub pull request to open its review in the Review desktop app.
// @homepageURL  https://review-code.dev/
// @downloadURL  https://review-code.dev/open-in-review.user.js
// @updateURL    https://review-code.dev/open-in-review.user.js
// @match        https://github.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// The same as the browser extension (extension/content.js), with the shortcut set here instead of in options.
// GitHub swaps pages without reloading, so the address is read when the key is pressed. The page's content is never read.
;(() => {
	// Change this to use another shortcut. `code` is the physical key, so Option and other layouts still match.
	const SHORTCUT = { key: 'r', code: 'KeyR', shift: true, alt: false, ctrl: false, meta: false }
	// Same shape as src/shared/link.ts: /<owner>/<repo>/pull/<n>, optionally followed by a tab such as /files.
	const PR_PATH = /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9]\d{0,9})(?:\/|$)/

	document.addEventListener('keydown', (e) => {
		if (e.repeat || e.isComposing || !matches(e, SHORTCUT) || typing(e.target)) return
		const m = PR_PATH.exec(location.pathname)
		if (!m || m[2] === '.' || m[2] === '..') return
		e.preventDefault()
		location.href = `review-code://open/${m[1]}/${m[2]}/pull/${m[3]}`
	})

	function matches(e, s) {
		const key = (e.key ?? '').toLowerCase() === s.key || (!!s.code && e.code === s.code)
		return key && e.shiftKey === s.shift && e.altKey === s.alt && e.ctrlKey === s.ctrl && e.metaKey === s.meta
	}

	// A comment box, the file filter or any other field keeps its keys.
	function typing(target) {
		return !!target && (target.isContentEditable || !!target.closest?.('input, textarea, select'))
	}
})()
