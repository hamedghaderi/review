# Store listings for Open in Review

Copy and paste for the Chrome Web Store and Firefox Add-ons. Submit after the Review release that understands `review-code://` links (0.6) is out, or hold the listing until it is: on older versions the shortcut only brings the app forward. Upload `dist/open-in-review.zip` from `npm run extension:pack` to both stores ([releasing.md](releasing.md#browser-extension-and-userscript)).

## Both stores

**Name** (from the manifest): Open in Review

**Summary** (from the manifest, 132 characters at most): Press Shift+R on a GitHub pull request to open its review in the Review desktop app.

**Description:**

> Press Shift+R on any GitHub pull request to open it in Review, the desktop app for reviewing Git branches and pull requests on your own machine.
>
> Review opens the pull request in your local clone, pinned to its exact commits, with the AI review dialog ready. Nothing runs until you click Start.
>
> • Works on every pull request page, including the Files and Commits tabs
> • Does nothing while you type in a comment box or any other field
> • Choose another shortcut in the extension's options
> • Runs only on github.com, reads only the page address, and sends nothing anywhere
>
> You need the Review app (free, MIT licensed) for macOS, Windows or Linux, version 0.6 or later: https://review-code.dev
>
> Source code: https://github.com/hamedghaderi/review

**Homepage:** https://review-code.dev/
**Support:** https://github.com/hamedghaderi/review/issues
**Privacy policy:** https://review-code.dev/privacy.html

## Chrome Web Store

**Category:** Developer Tools. **Language:** English.

**Images** (in `docs/store/`):

| Field              | File                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| Store icon 128×128 | `extension/icons/128.png`                                             |
| Screenshots        | `screenshot-1.png`, `screenshot-2.png`, `screenshot-3.png` (1280×800) |
| Small promo tile   | `promo-tile.png` (440×280)                                            |

**Privacy practices tab:**

- **Single purpose:** Opens the GitHub pull request you are viewing in the Review desktop app when you press a keyboard shortcut.
- **Permission justification, `storage`:** Saves the keyboard shortcut the user chooses in the extension's options.
- **Permission justification, host access to `https://github.com/*`:** The content script listens for the shortcut on GitHub pages and reads the page address to find the pull request's owner, repository and number. It runs on all of github.com because GitHub changes pages without reloading, so a pull request can be reached from any GitHub page.
- **Remote code:** No, I am not using remote code.
- **Data usage:** collects none of the listed types. Tick the three certifications (no selling, no unrelated use, no credit-worthiness use).

**Test instructions for the reviewer:**

> Open any pull request on github.com (for example https://github.com/hamedghaderi/review/pull/60), click on the page outside any text field and press Shift+R. The browser navigates to review-code://open/hamedghaderi/review/pull/60 and asks to open the Review app. Without the app installed (https://review-code.dev), the browser reports that no application handles the link, which is expected. Shift+R does nothing on non-pull-request pages or while typing in a field. The shortcut can be changed in the extension's options.

## Firefox Add-ons

**Distribution:** On this site (listed). **Categories:** Web Development. **License:** MIT. **Privacy policy:** paste the URL above, or leave it out (the manifest declares that no data is collected).

**Source code:** not needed; the files are not minified or bundled.

**Notes to reviewer:** the test instructions above, with "Firefox shows a dialog to choose an application" in place of the Chrome wording.

## Updating the images

The images are HTML pages in `docs/store/`, styled with the site's tokens and using the app screenshot from `site/img/`. `screenshot-3` shows the extension's real options page. Render each at its size with Chrome (headless Chrome needs file access for screenshot 3):

```sh
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
cd docs/store
for n in screenshot-1 screenshot-2 screenshot-3; do
  "$CHROME" --headless=new --hide-scrollbars --allow-file-access-from-files --force-device-scale-factor=1 \
    --virtual-time-budget=5000 --window-size=1280,800 --screenshot="$PWD/$n.png" "file://$PWD/$n.html"
done
"$CHROME" --headless=new --hide-scrollbars --force-device-scale-factor=1 --virtual-time-budget=5000 \
  --window-size=440,280 --screenshot="$PWD/promo-tile.png" "file://$PWD/promo-tile.html"
```
