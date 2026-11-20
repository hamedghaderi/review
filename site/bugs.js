// Bug hunt: a few bugs crawl along the page's own lines of text, leaving a red squiggle under the words they touch.
// Click one to catch it and it turns into a comment pin, like a finding in the app. Catch them all and the page is reviewed.
// The text stays real DOM; we only measure where the browser put each word and draw on a canvas over it.
// Skipped for reduced motion (main.js decides) and never blocks a click that misses a bug.

const TEXT = 'h1, .lede, .meta, h2, .tile h3, .tile p, .sprint p, .download__sub, .footer__line'
const BUG = '#ef5f67'
const BUG_DARK = '#7a1f2a'
const PIN = '#a48cff'
const COUNT = 3
const WALK = 26 // px/s
const RUN = 120
// Fingers are blunter than cursors: bigger bugs and a wider catch on touch screens and narrow windows.
const TOUCH = matchMedia('(pointer: coarse)').matches || innerWidth < 700
const BOOST = TOUCH ? 1.7 : 1
const HIT = 26 * BOOST // px radius a click counts as a catch

const canvas = document.createElement('canvas')
canvas.className = 'bugs'
canvas.setAttribute('aria-hidden', 'true')
const ctx = canvas.getContext('2d')
const hud = document.createElement('p')
hud.className = 'bugs-hud'
hud.setAttribute('role', 'status')

let lines = [] // { el, x0, x1, y (baseline, page coords), words: [{ x0, x1 }] }
let bugs = []
let pins = []
let pointer = { x: -1e4, y: -1e4 }
let dpr = 1
let last = 0
let running = false
let caught = 0

// Lines of text, in page coordinates, grouped from each word's client rects.
function measure() {
	const out = []
	const sx = scrollX
	const sy = scrollY
	const range = document.createRange()
	for (const el of document.querySelectorAll(TEXT)) {
		const cs = getComputedStyle(el)
		if (cs.visibility === 'hidden' || +cs.opacity === 0) continue
		const fs = parseFloat(cs.fontSize)
		const rows = new Map()
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
		for (let node; (node = walker.nextNode());) {
			const re = /\S+/g
			for (let m; (m = re.exec(node.data));) {
				range.setStart(node, m.index)
				range.setEnd(node, m.index + m[0].length)
				for (const r of range.getClientRects()) {
					if (r.width < 2) continue
					// The rect is the font's content box; the baseline sits about a fifth of the size above its bottom.
					const y = Math.round(r.bottom - fs * 0.2 + sy)
					const key = Math.round(y / 4)
					let row = rows.get(key)
					if (!row) rows.set(key, (row = { el, y, fs, words: [] }))
					row.words.push({ x0: r.left + sx, x1: r.right + sx })
				}
			}
		}
		for (const row of rows.values()) {
			row.words.sort((a, b) => a.x0 - b.x0)
			row.x0 = row.words[0].x0
			row.x1 = row.words.at(-1).x1
			if (row.x1 - row.x0 > 60) out.push(row)
		}
	}
	lines = out
	for (const b of bugs) if (b.mode === 'walk' && !lines.includes(b.line)) land(b, nearest(b.x, b.y))
}

function visibleLines() {
	const top = scrollY + 70
	const bottom = scrollY + innerHeight - 40
	return lines.filter((l) => l.y > top && l.y < bottom)
}

function nearest(x, y, pool = lines) {
	let best = pool[0]
	let d = Infinity
	for (const l of pool) {
		const dx = Math.max(l.x0 - x, 0, x - l.x1)
		const dd = dx * dx + (l.y - y) ** 2
		if (dd < d) ((d = dd), (best = l))
	}
	return best
}

function land(b, line) {
	if (!line) return
	b.line = line
	b.mode = 'walk'
	b.scale = Math.min(Math.max(line.fs / 34, 1) * BOOST, 2.2)
	b.x = Math.min(Math.max(b.x, line.x0), line.x1)
	b.y = line.y
}

// Fly in an arc to a random visible line, preferring one nearby.
function fly(b, pool = visibleLines()) {
	if (!pool.length) return
	const pick = pool[Math.floor(Math.random() * pool.length)]
	const tx = pick.x0 + Math.random() * (pick.x1 - pick.x0)
	const dist = Math.hypot(tx - b.x, pick.y - b.y)
	b.mode = 'fly'
	b.from = { x: b.x, y: b.y }
	b.to = { x: tx, y: pick.y, line: pick }
	b.lift = Math.min(160, 40 + dist * 0.35)
	b.t = 0
	b.dur = Math.min(1.6, 0.5 + dist / 900)
	b.dir = tx >= b.x ? 1 : -1
}

function spawn(i) {
	const shot = document.querySelector('.hero__shot')?.getBoundingClientRect()
	const x = shot ? shot.left + scrollX + shot.width * (0.2 + 0.3 * i) : innerWidth / 2
	const y = shot ? shot.top + scrollY + 30 : scrollY + innerHeight
	const b = { x, y, dir: 1, phase: Math.random() * 6, mode: 'walk', trail: [], scale: 1.4 * BOOST, speed: WALK, wait: 0, line: null }
	bugs.push(b)
	const hero = lines.filter((l) => l.el.closest('.hero'))
	fly(b, hero.length ? hero : visibleLines())
}

// Remember the words a bug has crawled under, so the squiggle stays behind it.
function mark(b) {
	const w = b.line.words.find((w) => b.x >= w.x0 && b.x <= w.x1)
	if (!w) return
	if (b.trail.some((t) => t.w === w)) return
	b.trail.push({ w, y: b.line.y, fs: b.line.fs, born: last })
	if (b.trail.length > 7) b.trail.shift()
}

function step(b, dt) {
	b.phase += dt * (b.speed / 6 + (b.mode === 'fly' ? 40 : 0))
	if (b.mode === 'fly') {
		b.t += dt / b.dur
		const t = Math.min(b.t, 1)
		const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
		b.x = b.from.x + (b.to.x - b.from.x) * e
		b.y = b.from.y + (b.to.y - b.from.y) * e - Math.sin(Math.PI * t) * b.lift
		if (t >= 1) {
			b.x = b.to.x
			land(b, b.to.line)
			b.wait = 0.3
		}
		return
	}
	if (b.mode === 'caught') {
		b.t += dt
		return
	}
	if (!b.line) return land(b, nearest(b.x, b.y))

	// Off screen for a while? Fly back into view.
	const onScreen = b.y > scrollY + 40 && b.y < scrollY + innerHeight
	b.away = onScreen ? 0 : (b.away || 0) + dt
	if (b.away > 1.2) return fly(b)

	// Scurry away from the cursor.
	const dx = b.x - pointer.x
	const near = !TOUCH && Math.hypot(dx, b.y - pointer.y) < 60 + 20 * b.scale
	if (near) {
		b.dir = dx >= 0 ? 1 : -1
		b.speed = RUN
		b.wait = 0
		if (Math.random() < dt * 0.6) return fly(b)
	} else {
		b.speed += (WALK - b.speed) * Math.min(dt * 2, 1)
	}

	if (b.wait > 0) {
		b.wait -= dt
		return
	}
	if (!near && Math.random() < dt * 0.25) {
		b.wait = 0.4 + Math.random() * 1.2
		return
	}
	b.x += b.dir * b.speed * dt
	mark(b)
	if (b.x < b.line.x0 || b.x > b.line.x1) {
		b.x = Math.min(Math.max(b.x, b.line.x0), b.line.x1)
		const r = Math.random()
		if (r < 0.45) {
			b.dir *= -1
		} else {
			// Drop to the next line of the same paragraph, or fly somewhere else.
			const same = lines.filter((l) => l.el === b.line.el && l.y > b.line.y && l.y < b.line.y + b.line.fs * 2.2)
			if (same.length && r < 0.8) fly(b, same)
			else fly(b)
		}
	}
}

function drawSquiggle(x0, x1, y, alpha, color) {
	ctx.save()
	ctx.globalAlpha = alpha
	ctx.strokeStyle = color
	ctx.lineWidth = 1.4
	ctx.beginPath()
	for (let x = x0; x <= x1; x += 1) ctx.lineTo(x, y + Math.sin((x - x0) * 0.75) * 1.6)
	ctx.stroke()
	ctx.restore()
}

function drawBug(b) {
	// Bigger on big type, so a bug on the headline doesn't look like a speck.
	const s = b.scale
	const flying = b.mode === 'fly'
	const flipped = b.mode === 'caught'
	ctx.save()
	ctx.translate(b.x, b.y + (flying ? 0 : -4 * s))
	ctx.scale(b.dir * s, s)
	if (flipped) ctx.rotate(Math.PI * Math.min(b.t * 4, 1))

	// Legs: three a side, alternating tripod gait.
	ctx.strokeStyle = BUG_DARK
	ctx.lineWidth = 1.2
	ctx.lineCap = 'round'
	for (let i = 0; i < 3; i++) {
		const lx = -3 + i * 3
		const swing = Math.sin(b.phase + (i % 2) * Math.PI) * (flipped ? 1.5 : 2)
		for (const side of [-1, 1]) {
			ctx.beginPath()
			ctx.moveTo(lx, 0)
			ctx.lineTo(lx + swing * side * (flying ? 0.3 : 1), 4)
			ctx.stroke()
		}
	}
	// Body and head.
	ctx.fillStyle = BUG
	ctx.beginPath()
	ctx.ellipse(-0.5, -1, 6, 4.2, 0, 0, Math.PI * 2)
	ctx.fill()
	ctx.fillStyle = BUG_DARK
	ctx.beginPath()
	ctx.arc(6, -1.5, 2.4, 0, Math.PI * 2)
	ctx.fill()
	// Shell seam and spots.
	ctx.strokeStyle = BUG_DARK
	ctx.lineWidth = 0.9
	ctx.beginPath()
	ctx.moveTo(-6, -1.5)
	ctx.lineTo(5, -1.5)
	ctx.stroke()
	ctx.fillStyle = BUG_DARK
	for (const [sx, sy] of [
		[-3, -3],
		[1, -3.2],
		[-1.5, 0.8],
	]) {
		ctx.beginPath()
		ctx.arc(sx, sy, 0.9, 0, Math.PI * 2)
		ctx.fill()
	}
	// Antennae.
	ctx.beginPath()
	ctx.moveTo(7.5, -3)
	ctx.quadraticCurveTo(9, -6, 11 + Math.sin(b.phase * 0.5), -6.5)
	ctx.stroke()
	// Wings buzz while flying.
	if (flying) {
		ctx.fillStyle = 'rgba(230, 225, 255, 0.45)'
		const flap = Math.abs(Math.sin(b.phase)) * 5 + 2
		ctx.beginPath()
		ctx.ellipse(-2, -4 - flap / 2, 6, flap, -0.4, 0, Math.PI * 2)
		ctx.fill()
	}
	ctx.restore()
}

function drawPin(p) {
	const age = last - p.born
	const t = Math.min(age / 0.35, 1)
	const k = 1 + Math.sin(t * Math.PI) * 0.25
	ctx.save()
	ctx.translate(p.x, p.top - 14)
	ctx.scale(k * t, k * t)
	ctx.fillStyle = PIN
	ctx.beginPath()
	ctx.roundRect(-11, -9, 22, 16, 5)
	ctx.moveTo(-3, 7)
	ctx.lineTo(0, 12)
	ctx.lineTo(3, 7)
	ctx.fill()
	ctx.fillStyle = '#16131f'
	ctx.font = '600 10px "Geist Mono", ui-monospace, monospace'
	ctx.textAlign = 'center'
	ctx.textBaseline = 'middle'
	ctx.fillText(String(p.n), 0, -1)
	ctx.restore()
}

function frame(now) {
	const dt = Math.min((now - (last * 1000 || now)) / 1000, 0.05)
	last = now / 1000
	for (const b of bugs) step(b, dt)

	render()

	const done = bugs.length && bugs.every((b) => b.mode === 'caught' && last - b.caughtAt > 1.3)
	if (done || document.hidden) {
		running = false
		return
	}
	requestAnimationFrame(frame)
}

function render() {
	const w = innerWidth
	const h = innerHeight
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
	ctx.clearRect(0, 0, w, h)
	ctx.translate(-scrollX, -scrollY)

	for (const b of bugs) {
		for (const t of b.trail) {
			const fade = b.mode === 'caught' ? Math.max(0, 1 - (last - b.caughtAt) / 1.2) : 0.85
			if (fade > 0) drawSquiggle(t.w.x0, t.w.x1, t.y + 4, fade, b.mode === 'caught' ? PIN : BUG)
		}
	}
	for (const p of pins) drawPin(p)
	for (const b of bugs) if (b.mode !== 'caught' || last - b.caughtAt < 0.3) drawBug(b)

	// Pointer cursor over a bug, so it reads as clickable.
	const over = bugs.some((b) => b.mode !== 'caught' && Math.hypot(b.x - pointer.x, b.y - pointer.y) < HIT)
	document.documentElement.classList.toggle('bug-hover', over)
}

function start() {
	if (running) return
	running = true
	requestAnimationFrame(frame)
}

function resize() {
	dpr = Math.min(devicePixelRatio || 1, 2)
	canvas.width = innerWidth * dpr
	canvas.height = innerHeight * dpr
	measure()
}

function say(text) {
	hud.textContent = text
	hud.classList.add('is-in')
}

function left() {
	const n = COUNT - caught
	return n === 1 ? '1 bug left' : `${n} bugs left`
}

addEventListener(
	'pointermove',
	(e) => {
		pointer = { x: e.clientX + scrollX, y: e.clientY + scrollY }
	},
	{ passive: true },
)
addEventListener('pointerleave', () => (pointer = { x: -1e4, y: -1e4 }))

// Capture phase, so a catch doesn't also follow the link underneath it.
addEventListener(
	'click',
	(e) => {
		const x = e.clientX + scrollX
		const y = e.clientY + scrollY
		const b = bugs.find((b) => b.mode !== 'caught' && Math.hypot(b.x - x, b.y - y) < HIT)
		if (!b) return
		e.preventDefault()
		e.stopPropagation()
		// The pin sits just above the tops of the capitals, so it doesn't cover the word it flags.
		const top = b.mode === 'walk' ? b.line.y - b.line.fs * 0.78 : b.y - 10 * b.scale
		b.mode = 'caught'
		b.t = 0
		b.caughtAt = last
		caught++
		pins.push({ x: b.x, top, n: caught, born: last + 0.25 })
		if (caught === COUNT) {
			say('0 open findings. This page is reviewed.')
			document.querySelector('.hero')?.classList.add('is-reviewed')
		} else say(`Caught one. ${left()}.`)
	},
	true,
)

// Once every bug is caught the loop stops; the pins still need to follow the page as it scrolls.
addEventListener('scroll', () => running || requestAnimationFrame(render), { passive: true })

let resizeQueued = 0
addEventListener('resize', () => {
	clearTimeout(resizeQueued)
	resizeQueued = setTimeout(() => (resize(), running || render()), 150)
})
document.addEventListener('visibilitychange', () => !document.hidden && bugs.length && start())
// Reveal animations and late fonts move words around; re-measure now and then.
setInterval(() => !document.hidden && running && measure(), 1000)

export function release() {
	document.body.append(canvas, hud)
	resize()
	document.fonts.ready.then(measure)
	// Let the hero's words finish settling before anything walks on them.
	setTimeout(() => {
		measure()
		for (let i = 0; i < COUNT; i++) setTimeout(() => spawn(i), i * 450)
		start()
		setTimeout(() => say(`${COUNT} bugs got into this page. ${TOUCH ? 'Tap' : 'Click'} one to leave a comment.`), 900)
	}, 1700)
}
