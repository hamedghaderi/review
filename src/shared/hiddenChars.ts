/**
 * Characters that change how code looks without changing what it does (issue #223): bidirectional controls that reorder
 * a line on screen (Trojan Source, CVE-2021-42574), invisible characters that make two names that look the same into
 * different names or hide text from the reader, and Cyrillic or Greek letters that look like Latin ones inside a Latin
 * word. A reviewer sees one program and the compiler runs another. Found by reading text; nothing is run.
 */
export interface HiddenChar {
	kind: 'bidi' | 'invisible' | 'lookalike'
	start: number // in UTF-16 code units, like String.slice
	end: number
	label: string // short, shown in the code: "RLO", "ZWSP", "TAG×12", or the letter itself for a look-alike
	name: string // "U+202E RIGHT-TO-LEFT OVERRIDE"; for tag text, what it spells
	warn: boolean // worth stopping an approval for; marks that are normal in some text (LRM, look-alikes in Greek maths) are only shown
}

const BIDI: Record<number, [string, string]> = {
	0x202a: ['LRE', 'LEFT-TO-RIGHT EMBEDDING'],
	0x202b: ['RLE', 'RIGHT-TO-LEFT EMBEDDING'],
	0x202c: ['PDF', 'POP DIRECTIONAL FORMATTING'],
	0x202d: ['LRO', 'LEFT-TO-RIGHT OVERRIDE'],
	0x202e: ['RLO', 'RIGHT-TO-LEFT OVERRIDE'],
	0x2066: ['LRI', 'LEFT-TO-RIGHT ISOLATE'],
	0x2067: ['RLI', 'RIGHT-TO-LEFT ISOLATE'],
	0x2068: ['FSI', 'FIRST STRONG ISOLATE'],
	0x2069: ['PDI', 'POP DIRECTIONAL ISOLATE'],
}

// Direction marks: normal in right-to-left text, and unable to reorder code the way the controls above can.
const MARKS: Record<number, [string, string]> = {
	0x200e: ['LRM', 'LEFT-TO-RIGHT MARK'],
	0x200f: ['RLM', 'RIGHT-TO-LEFT MARK'],
	0x061c: ['ALM', 'ARABIC LETTER MARK'],
}

const INVISIBLE: Record<number, [string, string]> = {
	0x00ad: ['SHY', 'SOFT HYPHEN'],
	0x034f: ['CGJ', 'COMBINING GRAPHEME JOINER'],
	0x115f: ['HF', 'HANGUL CHOSEONG FILLER'],
	0x1160: ['HF', 'HANGUL JUNGSEONG FILLER'],
	0x17b4: ['KIV', 'KHMER VOWEL INHERENT AQ'],
	0x17b5: ['KIV', 'KHMER VOWEL INHERENT AA'],
	0x180e: ['MVS', 'MONGOLIAN VOWEL SEPARATOR'],
	0x200b: ['ZWSP', 'ZERO WIDTH SPACE'],
	0x200c: ['ZWNJ', 'ZERO WIDTH NON-JOINER'],
	0x200d: ['ZWJ', 'ZERO WIDTH JOINER'],
	0x2028: ['LSEP', 'LINE SEPARATOR'],
	0x2029: ['PSEP', 'PARAGRAPH SEPARATOR'],
	0x2060: ['WJ', 'WORD JOINER'],
	0x2061: ['FA', 'FUNCTION APPLICATION'],
	0x2062: ['IT', 'INVISIBLE TIMES'],
	0x2063: ['IS', 'INVISIBLE SEPARATOR'],
	0x2064: ['IP', 'INVISIBLE PLUS'],
	0x206a: ['ISS', 'INHIBIT SYMMETRIC SWAPPING'],
	0x206b: ['ASS', 'ACTIVATE SYMMETRIC SWAPPING'],
	0x206c: ['IAFS', 'INHIBIT ARABIC FORM SHAPING'],
	0x206d: ['AAFS', 'ACTIVATE ARABIC FORM SHAPING'],
	0x206e: ['NADS', 'NATIONAL DIGIT SHAPES'],
	0x206f: ['NODS', 'NOMINAL DIGIT SHAPES'],
	0x3164: ['HF', 'HANGUL FILLER'],
	0xfeff: ['BOM', 'ZERO WIDTH NO-BREAK SPACE (BOM)'],
	0xffa0: ['HF', 'HALFWIDTH HANGUL FILLER'],
	0xfff9: ['IAA', 'INTERLINEAR ANNOTATION ANCHOR'],
	0xfffa: ['IAS', 'INTERLINEAR ANNOTATION SEPARATOR'],
	0xfffb: ['IAT', 'INTERLINEAR ANNOTATION TERMINATOR'],
}

// Joiners are part of Persian, Arabic and Indic words and of emoji sequences. Next to ASCII on both sides they join
// nothing, which is how they hide inside a name.
const JOINERS = new Set([0x200c, 0x200d])

// Letters drawn the same as a Latin letter in most code fonts.
const LOOKALIKE: Record<string, string> = {
	// Cyrillic
	а: 'a',
	в: 'B',
	е: 'e',
	к: 'k',
	м: 'M',
	н: 'H',
	о: 'o',
	р: 'p',
	с: 'c',
	т: 'T',
	у: 'y',
	х: 'x',
	ѕ: 's',
	і: 'i',
	ј: 'j',
	ԁ: 'd',
	ԛ: 'q',
	ԝ: 'w',
	ү: 'y',
	һ: 'h',
	ӏ: 'l',
	А: 'A',
	В: 'B',
	Е: 'E',
	К: 'K',
	М: 'M',
	Н: 'H',
	О: 'O',
	Р: 'P',
	С: 'C',
	Т: 'T',
	Х: 'X',
	Ѕ: 'S',
	І: 'I',
	Ј: 'J',
	У: 'Y',
	Ү: 'Y',
	Һ: 'H',
	Ԛ: 'Q',
	Ԝ: 'W',
	Ӏ: 'I',
	// Greek
	Α: 'A',
	Β: 'B',
	Ε: 'E',
	Ζ: 'Z',
	Η: 'H',
	Ι: 'I',
	Κ: 'K',
	Μ: 'M',
	Ν: 'N',
	Ο: 'O',
	Ρ: 'P',
	Τ: 'T',
	Υ: 'Y',
	Χ: 'X',
	ο: 'o',
	ι: 'i',
	ν: 'v',
	ρ: 'p',
	κ: 'k',
}
const CYRILLIC = /\p{Script=Cyrillic}/u
const LATIN = /\p{Script=Latin}/u
const WORD = /[\p{L}\p{M}\p{N}_$]+/gu

const hex = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`

/**
 * The hidden, direction-changing and look-alike characters in one line of code. `fileStart`: the line is the first of
 * its file, where a byte order mark at the very start is expected.
 */
export function findHiddenChars(text: string, fileStart = false): Array<HiddenChar> {
	const out: Array<HiddenChar> = []
	// A quick pass first: nearly every line is plain, and this keeps the diff fast.
	if (!/[^\x00-\x7f]/.test(text)) return out
	let i = 0
	while (i < text.length) {
		const cp = text.codePointAt(i)!
		const width = cp > 0xffff ? 2 : 1
		// Tag characters spell ASCII invisibly (U+E0020 is a space, U+E0041 an "A"): text hidden from people, not from models.
		if (cp >= 0xe0000 && cp <= 0xe007f) {
			const end = runEnd(text, i, (c) => c >= 0xe0000 && c <= 0xe007f)
			const spelled = [...text.slice(i, end)].map((c) => c.codePointAt(0)! - 0xe0000).filter((c) => c >= 0x20 && c < 0x7f)
			const count = (end - i) / 2
			out.push({
				kind: 'invisible',
				start: i,
				end,
				label: count > 1 ? `TAG×${count}` : 'TAG',
				name: spelled.length
					? `${count} invisible tag character${count === 1 ? '' : 's'} spelling “${String.fromCharCode(...spelled)}”`
					: `${hex(cp)} TAG CHARACTER`,
				warn: true,
			})
			i = end
			continue
		}
		// Variation selectors: one after an emoji or a CJK character is normal; a run of them can carry hidden bytes.
		const vs = (c: number): boolean => (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0xe0100 && c <= 0xe01ef)
		if (vs(cp)) {
			const end = runEnd(text, i, vs)
			const count = [...text.slice(i, end)].length
			if (count > 1 || cp >= 0xe0100) {
				out.push({
					kind: 'invisible',
					start: i,
					end,
					label: count > 1 ? `VS×${count}` : 'VS',
					name:
						count > 1
							? `${count} variation selectors in a row (${hex(cp)}…), which can carry hidden data`
							: `${hex(cp)} VARIATION SELECTOR`,
					warn: true,
				})
			}
			i = end
			continue
		}
		const bidi = BIDI[cp]
		const mark = MARKS[cp]
		const invisible = INVISIBLE[cp]
		if (bidi) out.push({ kind: 'bidi', start: i, end: i + width, label: bidi[0], name: `${hex(cp)} ${bidi[1]}`, warn: true })
		else if (mark) out.push({ kind: 'bidi', start: i, end: i + width, label: mark[0], name: `${hex(cp)} ${mark[1]}`, warn: false })
		else if (invisible && !(cp === 0xfeff && i === 0 && fileStart) && !(JOINERS.has(cp) && joinsText(text, i)))
			out.push({ kind: 'invisible', start: i, end: i + width, label: invisible[0], name: `${hex(cp)} ${invisible[1]}`, warn: true })
		i += width
	}
	for (const m of text.matchAll(WORD)) out.push(...lookalikes(m[0], m.index!))
	return out.sort((a, b) => a.start - b.start)
}

function runEnd(text: string, from: number, is: (cp: number) => boolean): number {
	let i = from
	while (i < text.length) {
		const cp = text.codePointAt(i)!
		if (!is(cp)) break
		i += cp > 0xffff ? 2 : 1
	}
	return i
}

/** A joiner with something other than ASCII on either side: inside a Persian word or an emoji, where it belongs. */
function joinsText(text: string, i: number): boolean {
	const low = i > 1 && text.charCodeAt(i - 1) >= 0xdc00 && text.charCodeAt(i - 1) <= 0xdfff // the end of an emoji, say
	const before = i > 0 ? text.codePointAt(i - (low ? 2 : 1))! : null
	const after = i + 1 < text.length ? text.codePointAt(i + 1)! : null
	return (before !== null && before > 0x7f) || (after !== null && after > 0x7f)
}

/**
 * Cyrillic or Greek letters that look like Latin ones, in a word that also has Latin letters: `pаypal` with a Cyrillic
 * "а". A word in one script is left alone, whatever its language. Cyrillic mixed into a Latin word is not how any
 * language is written, so it warns; Greek mixed in is how maths is written (`αMax`), so it is only shown.
 */
function lookalikes(word: string, at: number): Array<HiddenChar> {
	if (!LATIN.test(word)) return []
	const out: Array<HiddenChar> = []
	let i = 0
	for (const ch of word) {
		const latin = LOOKALIKE[ch]
		if (latin) {
			const cyrillic = CYRILLIC.test(ch)
			out.push({
				kind: 'lookalike',
				start: at + i,
				end: at + i + ch.length,
				label: ch,
				name: `${hex(ch.codePointAt(0)!)} ${cyrillic ? 'Cyrillic' : 'Greek'} “${ch}”, which looks like Latin “${latin}”`,
				warn: cyrillic,
			})
		}
		i += ch.length
	}
	return out
}

/** "2 bidirectional controls (RLO, PDI), 1 invisible character (ZWSP) and 1 look-alike letter", for a banner or warning. */
export function describeHiddenChars(found: ReadonlyArray<HiddenChar>): string {
	const parts: Array<string> = []
	const group = (kind: HiddenChar['kind'], one: string, many: string): void => {
		const of = found.filter((h) => h.kind === kind)
		if (!of.length) return
		const labels = [...new Set(of.map((h) => (kind === 'lookalike' ? `“${h.label}”` : h.label.replace(/×\d+$/, ''))))]
		parts.push(`${of.length} ${of.length === 1 ? one : many} (${labels.slice(0, 4).join(', ')}${labels.length > 4 ? '…' : ''})`)
	}
	group('bidi', 'bidirectional control', 'bidirectional controls')
	group('invisible', 'invisible character', 'invisible characters')
	group('lookalike', 'look-alike letter', 'look-alike letters')
	return parts.length <= 2 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

/** One added line of the change that holds such characters. */
export interface HiddenLine {
	fileKey: string
	path: string
	line: number
	found: Array<HiddenChar>
}

/** The added lines of a file's hunks that hold such characters. Removed and unchanged lines are not this change's doing. */
export function hiddenInHunks(
	fileKey: string,
	path: string,
	hunks: ReadonlyArray<{ lines: ReadonlyArray<{ kind: string; newNo: number | null; text: string }> }>,
): Array<HiddenLine> {
	const out: Array<HiddenLine> = []
	for (const h of hunks)
		for (const l of h.lines) {
			if (l.kind !== 'add' || l.newNo === null) continue
			const found = findHiddenChars(l.text, l.newNo === 1)
			if (found.length) out.push({ fileKey, path, line: l.newNo, found })
		}
	return out
}
