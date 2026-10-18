// Records the shortcut the content script listens for. Stored in sync storage, so it follows the browser profile.
const DEFAULT_SHORTCUT = { key: 'r', code: 'KeyR', shift: true, alt: false, ctrl: false, meta: false }
const MODIFIERS = ['Shift', 'Alt', 'Control', 'Meta', 'CapsLock', 'Fn']
const button = document.getElementById('shortcut')
const hint = document.getElementById('hint')
const mac = /Mac/.test(navigator.platform)
let recording = false

function label(s) {
	const parts = []
	if (s.ctrl) parts.push(mac ? '⌃' : 'Ctrl')
	if (s.alt) parts.push(mac ? '⌥' : 'Alt')
	if (s.shift) parts.push(mac ? '⇧' : 'Shift')
	if (s.meta) parts.push(mac ? '⌘' : 'Win')
	// The physical key names the letter or digit, since Option and Shift change what the key types.
	const key = /^Key[A-Z]$/.test(s.code) ? s.code.slice(3) : /^Digit\d$/.test(s.code) ? s.code.slice(5) : s.key.toUpperCase()
	parts.push(key)
	return parts.join(mac ? '' : '+')
}

function show(s) {
	button.textContent = label(s)
}

chrome.storage.sync.get({ shortcut: DEFAULT_SHORTCUT }, (v) => show(v.shortcut))

button.addEventListener('click', () => {
	recording = true
	button.textContent = 'Press keys…'
})
button.addEventListener('blur', () => {
	if (!recording) return
	recording = false
	chrome.storage.sync.get({ shortcut: DEFAULT_SHORTCUT }, (v) => show(v.shortcut))
})
button.addEventListener('keydown', (e) => {
	if (!recording) return
	e.preventDefault()
	if (e.key === 'Escape') return button.blur()
	if (MODIFIERS.includes(e.key)) return
	const s = { key: e.key.toLowerCase(), code: e.code, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey }
	recording = false
	chrome.storage.sync.set({ shortcut: s }, () => {
		show(s)
		hint.textContent =
			s.shift || s.alt || s.ctrl || s.meta
				? `Saved. Press ${label(s)} on a pull request.`
				: `Saved. GitHub uses single keys for its own shortcuts, so ${label(s)} may also do something there; a key with Shift or another modifier is safer.`
	})
})

document.getElementById('reset').addEventListener('click', () => {
	chrome.storage.sync.set({ shortcut: DEFAULT_SHORTCUT }, () => {
		show(DEFAULT_SHORTCUT)
		hint.textContent = `Saved. Press ${label(DEFAULT_SHORTCUT)} on a pull request.`
	})
})
