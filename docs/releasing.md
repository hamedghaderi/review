# Releasing

`npm run dist` builds the macOS installers into `dist/` (the first run downloads Electron and the packaging tools). `npm run dist:win` and `npm run dist:linux` build the others; on an Apple-silicon Mac they need Rosetta 2 (`softwareupdate --install-rosetta`), because electron-builder's installer tools for Windows and Linux are Intel programs.

| File                           | For                                    |
| ------------------------------ | -------------------------------------- |
| `Review-mac-arm64.dmg`         | Macs with Apple silicon (M1 and later) |
| `Review-mac-x64.dmg`           | Intel Macs                             |
| `Review-windows-setup.exe`     | Windows 10 and 11 (64-bit)             |
| `Review-linux-x86_64.AppImage` | Linux (64-bit)                         |

The file names carry no version, so the website's `releases/latest/download/…` links always point at the newest release. To release, bump `version` in `package.json`, build, and attach the four files to a GitHub release tagged `v<version>` (`gh release create v0.2.0 dist/Review-*.dmg dist/Review-*.exe dist/Review-*.AppImage`). There is no auto-update. Everyone needs Git installed; the GitHub CLI (`gh`) is optional.

The installers are not signed with an Apple Developer ID or a Windows certificate, so the system warns on the first open:

- **macOS**: drag Review to Applications and open it. macOS says it cannot check the app for malicious software. Open **System Settings → Privacy & Security**, scroll to "Review was blocked…", click **Open Anyway** and confirm. Only the first open needs this. (Or in Terminal: `xattr -dr com.apple.quarantine /Applications/Review.app`.) The app is signed ad hoc as a whole, which is what macOS needs for notifications and the keychain; after an update, macOS may ask once for the keychain password: choose **Always Allow**.
- **Windows**: SmartScreen says it protected your PC. Click **More info → Run anyway**.
- **Linux**: make the file executable (`chmod +x Review-*.AppImage`) and run it.

To remove the warnings, sign and notarize with an Apple Developer ID (`mac.identity` and `notarize` in `electron-builder.yml`) and a Windows code-signing certificate.
