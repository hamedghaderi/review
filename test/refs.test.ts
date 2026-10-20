import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileRefs } from '../src/shared/refs.ts'

const refs = (text: string) => fileRefs(text).map((r) => [text.slice(r.start, r.end), r.path, r.line, r.endLine])

test('file references: path:line, ranges with a hyphen or en dash, and folder paths without a line', () => {
	assert.deepEqual(refs('Same as `src/cart.ts:40`; see src/a/b.tsx:12-20 and ./lib/x.py:3–7.'), [
		['src/cart.ts:40', 'src/cart.ts', 40, null],
		['src/a/b.tsx:12-20', 'src/a/b.tsx', 12, 20],
		['./lib/x.py:3–7', 'lib/x.py', 3, 7],
	])
	assert.deepEqual(refs('The call in src/lib/util.ts moved.'), [['src/lib/util.ts', 'src/lib/util.ts', null, null]])
	assert.deepEqual(refs('cart.ts:9 too'), [['cart.ts:9', 'cart.ts', 9, null]], 'a bare file name with a line')
})

test('file references: not URLs, emails, names without a line or folder, parent folders or line 0', () => {
	assert.deepEqual(refs('https://github.com/o/r/blob/main/src/x.ts:4'), [])
	assert.deepEqual(refs('mail a@b.com about node.js, v1.2 and Foo.bar(1)'), [])
	assert.deepEqual(refs('../up.ts:3 and x.ts:0'), [])
	assert.deepEqual(refs('src/y.ts:9-3'), [['src/y.ts:9-3', 'src/y.ts', 9, null]], 'a backwards range keeps only its start')
})
