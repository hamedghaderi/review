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

// Motion: everything below is skipped when the visitor asks for reduced motion.
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
	document.documentElement.classList.add('motion')

	// Feature tiles slide in, one after another, as they come into view.
	const tiles = [...document.querySelectorAll('.reveal')]
	tiles.forEach((el, i) => el.style.setProperty('--d', `${(i % 3) * 90}ms`))
	const seen = new IntersectionObserver(
		(entries) => {
			for (const e of entries) {
				if (!e.isIntersecting) continue
				e.target.classList.add('is-in')
				seen.unobserve(e.target)
			}
		},
		{ rootMargin: '0px 0px -12% 0px' },
	)
	tiles.forEach((el) => seen.observe(el))

	// The hero capture starts tilted back and flattens as the page scrolls.
	const shot = document.querySelector('.hero__shot')
	let queued = false
	const tilt = () => {
		queued = false
		const p = Math.min(window.scrollY / (window.innerHeight * 0.6), 1)
		shot.style.setProperty('--tilt', `${(1 - p) * 16}deg`)
		shot.style.setProperty('--lift', `${0.94 + p * 0.06}`)
	}
	if (shot) {
		tilt()
		addEventListener('scroll', () => queued || ((queued = true), requestAnimationFrame(tilt)), { passive: true })
	}

	// A spotlight follows the cursor across the tiles' borders.
	const grid = document.querySelector('.grid')
	grid?.addEventListener('pointermove', (e) => {
		for (const tile of grid.children) {
			const r = tile.getBoundingClientRect()
			tile.style.setProperty('--mx', `${e.clientX - r.left}px`)
			tile.style.setProperty('--my', `${e.clientY - r.top}px`)
		}
	})
}
