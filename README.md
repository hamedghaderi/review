<div align="center">
  <img src="build/icons/256x256.png" alt="Review app icon" width="112" height="112" />
  <h1>Review</h1>
  <p><strong>Code review on your own machine.</strong></p>
  <p>A desktop app for Git branches and GitHub pull requests: comment on any line, publish when you're ready,<br />and add an AI reviewer with your own model, or none.</p>
  <p>
    <a href="https://github.com/hamedghaderi/review/actions/workflows/ci.yml"><img src="https://github.com/hamedghaderi/review/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <a href="https://github.com/hamedghaderi/review/releases/latest"><img src="https://img.shields.io/github/v/release/hamedghaderi/review?color=6d4aff" alt="Latest release" /></a>
    <a href="https://github.com/hamedghaderi/review/releases"><img src="https://img.shields.io/github/downloads/hamedghaderi/review/total?color=6d4aff" alt="Downloads" /></a>
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey" alt="Platforms: macOS, Windows, Linux" />
    <a href="LICENSE"><img src="https://img.shields.io/github/license/hamedghaderi/review" alt="MIT license" /></a>
  </p>
  <p>
    <a href="https://hamedghaderi.github.io/review/"><strong>Website</strong></a> ·
    <a href="https://github.com/hamedghaderi/review/releases/latest"><strong>Download</strong></a> ·
    <a href="docs/guide.md"><strong>User guide</strong></a>
  </p>
  <br />
  <img src="site/img/review.webp" alt="Review showing a branch diff with a comment on line 14" />
</div>

## Features

- **Branches and pull requests in one place.** Browse local branches, remotes and GitHub PRs, and press `⌘P` to jump anywhere.
- **Reviews pinned to exact commits.** Each review compares from the merge base, so the diff doesn't move when someone pushes.
- **Comments that stay local.** Nothing goes to GitHub until you publish. Comments land in your pending review, and you submit it.
- **Bring your own AI, or none.** OpenAI, Anthropic, Gemini, OpenRouter, any OpenAI-compatible endpoint, or a local model in Ollama or LM Studio. Keys are encrypted with your system keychain.
- **MCP tools.** AI reviewers can call your MCP servers for context the repository doesn't have, like the ticket behind a change.

## Install

Download the installer for your system from the [latest release](https://github.com/hamedghaderi/review/releases/latest). You need Git installed.

The installers aren't signed yet, so your system asks once on first open. On macOS, go to **System Settings → Privacy & Security** and click **Open Anyway**. On Windows, click **More info → Run anyway**.

## Build from source

Requires Node 22.12+ and Git.

```sh
git clone https://github.com/hamedghaderi/review.git
cd review
npm install
npm run dev
```

| Command             | What it does                                                     |
| ------------------- | ---------------------------------------------------------------- |
| `npm run dev`       | Run with hot reload                                              |
| `npm test`          | Run the tests (temporary repos, mock servers)                    |
| `npm run typecheck` | Type-check main and renderer                                     |
| `npm run format`    | Format with Prettier                                             |
| `npm run dist`      | Build macOS installers (`dist:win`, `dist:linux` for the others) |

## Docs

- [User guide](docs/guide.md): browsing, pull requests, publishing, AI review, MCP servers
- [Architecture](docs/architecture.md): how AI review works, code layout, how reviews are stored
- [Releasing](docs/releasing.md): building installers and publishing a release

## Contributing

Issues and pull requests are welcome. Before opening a PR, run `npm test`, `npm run typecheck` and `npm run format:check`; CI runs the same three. To report a security problem, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
