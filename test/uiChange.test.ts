import assert from 'node:assert/strict'
import { test } from 'node:test'
import { showsMedia, uiFiles } from '../src/shared/uiChange.ts'

test('UI files are markup, styles and templates, not tests or stories', () => {
	assert.deepEqual(
		uiFiles([
			'src/components/Cart.tsx',
			'src/App.vue',
			'web/styles/main.scss',
			'resources/views/cart.blade.php',
			'app/views/orders/show.html.erb',
			'public/index.html',
			'src/cart.ts',
			'src/Cart.test.tsx',
			'src/Cart.stories.tsx',
			'src/__tests__/Cart.tsx',
			'tests/fixtures/page.html',
			'README.md',
		]),
		[
			'src/components/Cart.tsx',
			'src/App.vue',
			'web/styles/main.scss',
			'resources/views/cart.blade.php',
			'app/views/orders/show.html.erb',
			'public/index.html',
		],
	)
})

test('an image or video anywhere on the pull request counts', () => {
	assert.equal(showsMedia(['Before/after:\n\n![before](https://example.com/a.png)']), true)
	assert.equal(showsMedia(['![after][1]\n\n[1]: https://example.com/b.png']), true, 'reference-style image')
	assert.equal(showsMedia(['<img width="400" alt="cart" src="https://example.com/c.png">']), true)
	assert.equal(showsMedia(['<video src="https://example.com/d.mp4"></video>']), true)
	assert.equal(showsMedia(['https://github.com/user-attachments/assets/0f6c2a9e-1b2c-4d5e-8f90-123456789abc']), true, 'a pasted video')
	assert.equal(showsMedia([null, '', 'Looks good', 'Screenshot: https://private-user-images.githubusercontent.com/1/x.png']), true)

	assert.equal(showsMedia(['Fixes the cart total. See [the issue](https://example.com/1).']), false, 'a link is not a picture')
	assert.equal(showsMedia(['Log: https://github.com/user-attachments/files/123/build.log']), false, 'an attached file is not media')
	assert.equal(showsMedia([null, undefined, '']), false)
})
