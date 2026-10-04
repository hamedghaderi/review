# Review

Code review on your own machine. A desktop app for Git branches and GitHub pull requests: comment on any line, publish when you're ready, and add an AI reviewer with your own model, or none.

**[Website](https://hamedghaderi.github.io/review/)** · **[Download](https://github.com/hamedghaderi/review/releases/latest)** · **[User guide](docs/guide.md)**

![Review showing a branch diff with a comment on line 14](site/img/review.webp)

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
