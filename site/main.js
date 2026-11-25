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

	// The story: scrolling through its tall section plays a review, step by step, while its content stays on screen.
	const story = document.querySelector('.story')
	if (story) {
		const steps = [...story.querySelectorAll('.story__steps li')]
		const lines = [...story.querySelectorAll('.ln')]
		const [you, ai] = ['.note--you', '.note--ai'].map((s) => story.querySelector(s))
		const typed = story.querySelector('.type')
		const full = typed.dataset.text
		const check = story.querySelector('.check')
		const mock = story.querySelector('.mock')
		const count = story.querySelector('.mock__count')
		const toast = story.querySelector('.mock__toast')
		const arrive = story.querySelector('.mock__arrive')
		const state = you.querySelector('.state')
		let last = ''
		const play = () => {
			const r = story.getBoundingClientRect()
			const p = Math.min(Math.max(-r.top / (r.height - innerHeight), 0), 1)
			const step = Math.min(Math.floor(p * 4), 3)
			const local = Math.min(p * 4 - step, 1) // progress through the current step, 0–1
			const key = `${step}:${local.toFixed(2)}`
			if (key === last) return
			last = key
			story.style.setProperty('--p', p.toFixed(3))
			story.dataset.step = String(step)
			steps.forEach((li, i) => {
				li.classList.toggle('is-on', i === step)
				li.classList.toggle('is-done', i < step)
			})
			// 1: the change arrives all at once (files, checks, threads), gathers into the one file that matters, and its
			// diff draws in, line by line.
			arrive.classList.toggle('is-in', step === 0 && local < 0.3)
			const shown = step > 0 ? lines.length : Math.ceil(Math.min(Math.max((local - 0.3) * 2.2, 0), 1) * lines.length)
			lines.forEach((l, i) => l.classList.toggle('is-in', i < shown))
			// 2: your comment opens and types itself.
			you.classList.toggle('is-in', step >= 1)
			const chars = step > 1 ? full.length : step === 1 ? Math.round(Math.min(local * 1.5, 1) * full.length) : 0
			typed.textContent = full.slice(0, chars)
			typed.classList.toggle('is-typing', step === 1 && chars < full.length)
			// 3: the AI finding arrives, then its double-check.
			ai.classList.toggle('is-in', step >= 2)
			check.classList.toggle('is-in', step > 2 || (step === 2 && local > 0.55))
			// 4: publishing: the pending count climbs and the comments say where they went.
			const sent = step < 3 ? 0 : local > 0.5 ? 2 : local > 0.25 ? 1 : 0
			count.textContent = String(sent)
			mock.classList.toggle('is-sent', sent > 0)
			toast.classList.toggle('is-in', step === 3 && local > 0.6)
			state.textContent = sent ? 'In your pending review' : 'Not posted'
		}
		let storyQueued = false
		addEventListener('scroll', () => storyQueued || ((storyQueued = true), requestAnimationFrame(() => ((storyQueued = false), play()))), {
			passive: true,
		})
		addEventListener('resize', play)
		play()
	}

	// A few bugs crawl along the page's text until the visitor catches them.
	import('./bugs.js').then((m) => m.release())

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
