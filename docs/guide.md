# User guide

How to use Review: browsing, reviewing, publishing to GitHub and AI review. For how it's built, see [architecture.md](architecture.md).

## Browsing and opening reviews

The app opens in the **Browse** workspace. The sidebar holds **Pull requests**, **Pinned** branches, **Local** branches and one entry per **remote**. Branch namespaces (`feat/`, `fix/`, `release/`…) are collapsible folders. Sidebar section, expanded folders, pins, searches, filter, selection, scroll position and the chosen base are saved per repository. **Open review** switches to the files/diff/comments workspace; **Browse** in the header goes back with everything as you left it.

Keyboard: `⌘P`/`Ctrl+P` quick open (PRs and branches), `/` focuses the visible search (not while typing elsewhere), `↑`/`↓`/`Home`/`End`/`PgUp`/`PgDn` move, `Enter` selects (or toggles a folder, `←`/`→` too), `⌘`/`Ctrl+Enter` opens the selected review, `Esc` clears the search or closes the palette. Tab moves between the sidebar, search, list and preview as usual.

Quick open starts with the PRs waiting for your review (when signed in to GitHub), your recent reviews, the checked-out branch and recently updated branches. Typing searches all of them; a branch that has a PR in the results is listed once, as the PR. `Tab` switches between All, Pull requests and Branches (or start the query with `pr ` or `b `). `Enter` opens the review (a branch against its default base), `⌘`/`Ctrl+Enter` shows the item in Browse instead, and `⌘`/`Ctrl+K` lists more actions: open on GitHub, copy link, copy branch name.

### Branches

Read with `git for-each-ref` only; nothing is fetched. `main`, `origin/main` and `upstream/main` are separate entries; `refs/remotes/*/HEAD` aliases are hidden. The checked-out branch is labelled _checked out_, which is separate from the selection. Ahead/behind numbers in rows are **relative to the configured upstream**. The preview shows ahead/behind relative to the chosen base and the exact merge base it will review.

The base picker is searchable. The default comes from the repository, not a hard-coded name: the remotes' `HEAD` targets (upstream first, then origin), then local branches of the same name, then `main`/`master`/`develop`/`trunk`. A review compares `merge-base(base, head)..head`. Missing refs, unrelated histories and shallow clones (where a merge base may just not be downloaded) are reported as such.

### Pull requests (GitHub)

Repositories are detected from HTTPS, SSH, scp-style and `git://` remotes. If remotes point at different GitHub repositories (fork `origin` plus `upstream`), `upstream` is used by default, and you can choose another one under **GitHub** in the header; the choice is saved per clone.

Filters: Open (includes drafts), Review requested, Mine, Drafts, Merged, Closed (unmerged), All. The default sort is most recently updated. Search runs on GitHub (`/search/issues` without a token, GraphQL with one) and is paginated, so it covers the whole repository. It is debounced, and a newer search cancels the one before it. It accepts title words, `#128`, pasted PR URLs, `@user`, and qualifiers such as `author:`, `head:`, `base:`, `label:`, `review-requested:` and `is:` (click **?** for examples). `repo:`, `org:` and `user:` are dropped so a search never leaves the repository. GitHub's 1,000-result cap and `incomplete_results` are shown as they are. If a refresh fails, the last results are kept and labelled with their fetch time. The preview loads details (description, commits, files, reviewers, SHAs) for the selected PR only.

**Review state.** Rows, the preview and the header of an open PR review show where a PR stands: **Approved** (×n), **Changes requested**, **Reviewed** (comments only), **n approvals, more required**, or **Review required**, plus what you did yourself ("you approved"). The badge follows GitHub's review decision when the repository has review rules. Without rules, it follows the reviews. Each person counts once, with their standing review: an approval or change request stands until they approve, request changes or are dismissed, and a later comment doesn't undo it. The PR author's own replies and pending reviews don't count. Approvals given on an older commit are labelled **(older commit)**. Change requests stay in force after new commits, as on GitHub. The preview lists who approved, requested changes and commented. With a token, list rows get this from the same search query, with no extra requests. Without a token, rows show nothing; the preview reads the PR's review list (one request), which has no review decision. An open PR review re-reads its state every 2 minutes. Search with `review:approved`, `review:changes_requested` or `reviewed-by:@me` to filter.

**Inbox.** The **Inbox** filter lists the open pull requests that need you, with where each one stands: **Re-requested** (asked again after you reviewed), **New** (requested and you haven't looked at it here yet; selecting it in the list counts as looking), **Waiting for you**, **New commits since your review**, and **Reviewed**. They're listed in that order, newest first within each. It combines two GitHub searches (`review-requested:@me`, which includes team requests, and `reviewed-by:@me`), up to 50 each, and needs a GitHub token.

**Review-request notifications.** While the app runs, it checks your review requests on GitHub every 3 minutes (one search across all repositories) and shows a desktop notification, with the system sound, for repositories you have opened in the app: a new request, a request after you already reviewed, or a draft marked ready. Drafts don't notify until they're ready. Clicking a notification opens that PR's review, switching repository if needed. More than 3 at once become one summary. The last state is stored, so requests that arrive while the app is closed are announced at the next start; the very first check only records what's there. The dock icon shows how many requests are open. Turn notifications or the sound off in **Settings · GitHub**. **Send a test notification** there shows a sample. If the system refuses a notification (on macOS: not allowed in System Settings → Notifications), the settings say so instead of review requests going missing silently. In development, `npm install` signs the downloaded Electron app locally (`scripts/sign-electron.mjs`), because macOS refuses notifications from an app bundle that isn't signed as a whole and never lists it in System Settings.

**Stacks.** A pull request is stacked on another when its base branch is that PR's branch. Turn on **Stacks** next to the filters to show each result under the PR it is stacked on. PRs the search didn't return but a result is stacked on (for example the parts underneath a stack whose review was requested from you) are added greyed out, so every stack reaches down to its base branch. The preview shows the PR's stack (`main › #101 › #102 › #103`) and what is stacked on it, with links. An open PR review shows "Stacked on #102 · 3 above" in the header. Reviewing a stacked PR already compares it with the branch it is stacked on, so you see only its own changes. The app connects stacks from one list of the repository's open PRs and their branches (one GraphQL request per 100 open PRs, cached for 2 minutes, up to 1,000). It needs a GitHub token; without one, results stay flat.

**Connecting GitHub** is optional; branches never need it. The quickest way is **Use GitHub CLI login** under **GitHub** in the header. If `gh` is installed and logged in, the app asks it for its token (`gh auth token`) when it needs one, re-reads it every few minutes and after a rejected request, and never stores it. It then has exactly the access `gh` has; publishing and private repositories need the `repo` scope, which `gh auth login` grants by default. A token saved in the app takes precedence over the gh login. The choice is kept in `github-settings.json` (no secrets). Alternatively: Paste a fine-grained personal access token with only **Pull requests: Read** under **GitHub** in the header (a prefilled creation link is provided). It is encrypted with the same credential service as AI keys (`ai-credentials.json`, id `github`) and never sent back to the renderer. Without a token, public repositories work with GitHub's anonymous limit of 60 requests an hour, and rows carry no branch names or review requests. The token is used for **API calls only**. Commits are fetched with Git, which uses your SSH keys or credential helper, so a connected token doesn't mean a fetch will work, and fetch failures say so.

### Opening a pull request

1. Read the PR's base repository, number, base SHA and head SHA from `GET /repos/{repo}/pulls/{n}`.
2. Fetch exactly those two commits by SHA (`git fetch --no-tags --no-write-fetch-head --refmap= <remote> +<sha>:refs/review/keep/<sha>`) from the remote for the base repository, or its HTTPS URL if there isn't one. Fork heads work because GitHub serves them from the base repository. Branches, remote-tracking refs, `FETCH_HEAD`, the index and the working tree are never touched, and the fetch is cancelled if you open something else or switch repositories.
3. Check that the pinned refs resolve to the requested SHAs.
4. Re-read the PR. If its head or base moved during the fetch, start over with the new pair, up to three times; the review shows a notice when this happens. It never mixes versions.
5. Compare `merge-base(base SHA, head SHA)..head SHA`. The PR base SHA, head SHA and merge base are stored separately. Local `HEAD` and GitHub's synthetic merge commit are never used.

When a closed or merged PR's commits can't be fetched any more, or its recorded base already contains the head, the app says the original comparison can't be rebuilt and offers **Open on GitHub**. It never shows an empty diff in that case.

Each review is pinned to its snapshot. While a review is open, the app checks the target (every 15 s for branches, locally; every 2 min for PRs, through the API) and shows **Update available**. Opening the update starts a new snapshot, and your comments carry over to it (see [Carrying comments forward](#carrying-comments-forward)). Findings and viewed files stay with the old snapshot, which keeps its own comments too and is still reachable from the Snapshot selector or **Recent reviews**. Opening a review never starts an AI review.

### Carrying comments forward

When you open a newer snapshot with **Review update** / **Fetch and review update**, or go from a branch review to its PR with **Open PR review**, each comment is copied into the new snapshot:

- **Lines unchanged**: the comment moves to the same lines in the new snapshot. Lines added or removed above it, and renames, are followed. Comments on the new version are compared head to head; comments on removed lines are compared base to base.
- **Lines changed**: the comment is marked **Outdated** and shown at the top of the file with the code it was written on (up to 40 lines) and the old line numbers. This also covers lines inserted inside the commented range, a deleted file, and a file that is no longer part of the change (listed in **My comments** only). Once outdated, a comment stays outdated in later snapshots.
- File comments move with the file.

The old snapshot is not changed. Each comment is carried from a snapshot once, so a comment you delete in the new snapshot doesn't come back. A new snapshot opened some other way (for example from **Browse**) carries from the latest snapshot of the same target; a pull request's first snapshot uses the latest review of its head branch. Drafts, findings, finding decisions and viewed files are not carried, and a carried comment loses its link to the AI finding it came from, since that finding belongs to the old snapshot's run. If the old commits can't be read any more, the review still opens and a notice says why nothing was carried.

Publishing: a comment already published from an earlier snapshot shows as published and isn't posted again, since GitHub keeps it on the PR itself. An outdated comment is treated like one outside the diff: skipped, or posted as a file comment that names its old lines and commit (`**lines 20–21 at 1a2b3c4:** …`).

## Existing discussion on GitHub

PR reviews show what has already been said on the pull request, so you and the AI don't raise a point that was discussed or resolved already. It only reads from GitHub: nothing is posted, replied to or resolved from here, and existing comments never go into what **Publish** sends.

- **In the diff**: each review thread appears under the lines it is about, marked **On GitHub**, above your own comments on those lines. It shows its status (**Open**, **Resolved by …**, **Outdated**), every comment with its author and their role on the repository, and a link to GitHub. Resolved threads start collapsed. Unresolved threads stay open even when outdated, because code moving is not the same as someone handling the point.
- **Placement**: a thread appears at a line only where GitHub reports a current position. On a snapshot older than the PR's head, that position is carried back to the snapshot's lines when none of them changed in between (following lines added or removed above). On the commit a thread was written on, its original lines are used. Everything else is listed at the top of its file with the reason and the diff GitHub showed when it was written: outdated threads, lines that differ in this snapshot, old-side threads on another version, and a PR head that isn't in the local repository. Threads on files outside this snapshot's changes appear only in the **GitHub** tab. A thread is never pinned to its original line number on different code.
- **"Already discussed on GitHub"**: your comments, drafts and AI findings on lines that an existing thread covers carry a note naming how many open and resolved threads are there and who started them. A line comment is matched only with a line thread on overlapping lines of the same side, and a file comment only with a file thread. Outdated threads have no current line, so they don't match. The note is worked out when it is shown and stored nowhere. It never hides, lowers or drops a comment or finding, and a resolved thread is not treated as proof the code changed. A comment you published from this app doesn't count as already discussed by its own thread.
- **GitHub tab** (right panel, PR reviews only): all threads, open first, then review summaries and the PR conversation. It says when it was read (it doesn't update by itself; use **Refresh**, and it re-reads after the Publish dialog closes), and whether the read was partial or failed. A failed read says earlier comments may exist; it never shows as "no discussion".
- **With a token** (or the GitHub CLI login), one read-only GraphQL query per 50 threads (up to 500), since only GraphQL reports resolved and outdated threads. **Without a token**, REST is used for public repositories, and resolved state is shown as unknown.
- Limits: 30 comments per thread, 100 reviews and 100 conversation comments, and 20,000 characters per comment. Anything cut is counted in the panel. Comment text is third-party text: it is shown as plain text, and links are shown only when they point to `github.com`.

## Publishing a review to GitHub

Reviews opened from a pull request show **Publish to GitHub…**. For branches, the app looks up their pull request: it asks GitHub for PRs whose head is `owner:branch`, where the owner comes from the remote the branch is pushed to (its upstream, or `origin`). It lists open ones first, and caches the answer for two minutes. The branch preview in Browse and branch reviews both show that PR with **Open PR review**. On a branch review with no PR, the button is shown disabled with the reason. **Open PR review** carries the branch review's comments into the PR review (see [Carrying comments forward](#carrying-comments-forward)). Nothing is ever published automatically, and saving locally never sends anything.

1. **Add comments to your pending review.** The dialog lists the snapshot's comments with checkboxes. Selected comments go into your _pending_ review on the PR, which only you can see, attached to the snapshot's head commit. The first comment creates the pending review; later ones are added to it. GitHub allows one pending review per person per PR. If you already started one on GitHub for the same commit, the app adds to it. If yours is on a different commit, publishing is blocked with an explanation, since mixing commits would misplace comments.
2. **Submit** as Comment, Approve or Request changes, with an optional summary (required for Comment and Request changes when there are no comments). Submitting needs a second confirmation, because it is public and can't be undone. You can also finish on GitHub instead.

Where comments land:

- GitHub only accepts line comments on lines in its diff: changed lines plus 3 lines of context, with ranges inside one hunk. The app works this out from the same merge-base..head diff GitHub uses. Comments elsewhere (for example in context you expanded) are marked **Outside diff**. You choose to post them as file comments, which start with the line numbers (`**lines 20–21:** …`), or skip them.
- File-level comments are added as file threads in the pending review, so they stay private until you submit too.
- Renamed files are addressed by their new path. Comments on removed lines use GitHub's left side.
- If the PR has commits newer than the snapshot, the dialog says so. GitHub may show those comments as outdated.

The dialog reads your pending review and earlier published reviews from GitHub before each write, and the app records each comment's GitHub id as soon as it is created. So:

- Publishing twice is a no-op.
- An edited comment updates the pending one in place.
- A comment you delete on GitHub becomes publishable again.
- If the app dies mid-publish, the comment already on GitHub is recognised instead of posted again.
- Comments already submitted aren't changed from the app; edit them on GitHub.
- Local drafts that were never submitted are not published.
- Deleting a comment locally leaves it on GitHub.

Writes run one at a time and are spaced out to respect GitHub's limits on creating content. Publishing needs a fine-grained token with **Pull requests: Read and write**. With a read-only token, the dialog explains this and links to a prefilled token page. The publication record is stored with the snapshot in `review-store.json`, written only by the main process; `saveReview` from the renderer can't change it.

## AI review

AI review is optional and off until you use it. Manual review works without any AI setup.

### Connecting a provider

Open **Settings → AI providers** with the ⚙ button in the header, or with **Connect AI provider** when nothing is connected yet. No `.env` file or environment variable is involved. Existing `OPENAI_API_KEY` and similar variables are ignored.

| Provider          | Authentication  | Protocol                                                                                         | Models                                                                            |
| ----------------- | --------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| OpenAI            | API key         | Responses API, strict `json_schema` output                                                       | Discovered via `/models`, plus catalog                                            |
| Anthropic         | API key         | Messages API, `output_config.format` JSON schema                                                 | Discovered via Models API (models without structured output hidden), plus catalog |
| Google Gemini     | API key         | Gemini API `generateContent` with `responseJsonSchema`                                           | Discovered via `models.list` (generateContent only), plus catalog                 |
| OpenRouter        | API key         | Chat Completions, `json_schema`, routed only to endpoints that support it (`require_parameters`) | Discovered: models with `structured_outputs`                                      |
| OpenAI-compatible | None or API key | Chat Completions or Responses (you choose)                                                       | Discovered via `/models`, or entered manually                                     |

The OpenAI-compatible provider has presets, each listed under **Add provider** by name:

- **Ollama** (`http://localhost:11434/v1`) and **LM Studio** (`http://localhost:1234/v1`). Both default to no authentication, so no `Authorization` header is sent.
- **OmniRoute** (`http://localhost:20128/v1`), a local gateway that routes to the providers configured in its dashboard. It defaults to an API key created in OmniRoute; switch authentication to "None" if your gateway doesn't require one. OmniRoute reports context and output limits per model, so the preset leaves the context window blank and requests are sized from those limits. Its `/models` list is public, so "Test connection" shows that the gateway is reachable, not that the key is accepted. Use "Test model" to check the key and a model end to end. Several OpenAI-compatible connections can exist side by side, and one of each hosted provider.

Connection states:

- **Not connected**: no key yet, or a key was saved but not tested. Saving a key never counts as verified.
- **Testing**: a test is in progress.
- **Connected**: the last test succeeded for the current endpoint and key.
- **Connection failed**: the last test failed, with the provider's reason shown.

**Test connection** only lists models. It sends no repository content and runs no inference. **Test model** is a separate, explicit action: it sends one small synthetic request (a four-line made-up diff) to confirm that the model answers in the findings schema.

Models are labelled by source:

- **Available**: listed by the provider for this key.
- **Catalog**: from the built-in list in `src/main/ai/catalog.ts`, not yet verified for your account.
- **Manual**: an ID you typed.
- **Tested**: passed "Test model".

After a successful test, catalog entries the account doesn't list are no longer offered.

### Choosing a model

The picker next to **Run AI review…** groups models by connected provider. It supports search, keyboard navigation (↑/↓, Enter, Esc) and a **Manage providers…** link, and it remembers the last valid choice across restarts. If that model or provider goes away, the picker says why instead of picking another one.

When a review starts, the chosen connection, provider, protocol, model, endpoint and credential are fixed for the whole run. Changing the picker only affects later runs. Disconnecting a provider, replacing its key or changing its endpoint cancels a run that is using it, and any late responses are discarded. After an error the app never switches to another provider or credential. Each run stores its provenance (connection, provider, protocol, model, endpoint, prompt version, the limits actually used), so past reviews stay readable after a provider is disconnected.

### Credentials

- API keys go from the renderer to the main process through one validated IPC call (`setCredential`). There is no call that reads a key back. The key field is cleared after saving.
- Keys are encrypted with Electron `safeStorage` (macOS Keychain, Windows DPAPI, Linux libsecret/KWallet) and stored in `<userData>/ai-credentials.json` (mode 0600). They are kept separate from the nonsecret `<userData>/ai-settings.json` and from `review-store.json`.
- If secure storage is unavailable, or on Linux the backend is `basic_text`/unknown, keys can only be used for the current session and are kept in memory. Nothing is written in plaintext, and the settings screen explains why.
- Each key is bound to the connection's endpoint and protocol. Changing a custom endpoint deletes the key, so you have to enter it again for the new endpoint. Disconnecting deletes the key.
- Error messages are scrubbed of the key and of anything that looks like one before they are shown or stored. SDK clients get every option explicitly, so they never read `OPENAI_*`, `ANTHROPIC_*` or `GOOGLE_*` variables. Git subprocesses don't receive provider variables either.

### Review teams

A review team splits the 14 rules between several models, so each one checks only its part. Create one with **+ New review team** in the model picker, or under **Settings → AI providers → Review teams**. A new team starts with four roles and a connected model suggested for each; you can rename roles, pick any connected model, add or remove reviewers (1 to 8), and choose who checks each rule:

| Role                  | Rules                                                                          |
| --------------------- | ------------------------------------------------------------------------------ |
| Defects               | Bugs, missing or hidden error handling                                         |
| Security              | Security                                                                       |
| Callers & structure   | Breaking changes, a file taking on a second job, over-engineering, conventions |
| Tests & leftover code | Test value, the 6 leftover-code signatures                                     |

Every rule must have exactly one reviewer before a team can be saved. Pick a team in the model picker like a single model; choosing a model switches back.

**Focused passes** gets the same split without building a team: with a single model chosen, tick **Focused passes** in the Run dialog and the model runs once per default role (Defects, Security, Callers & structure, Tests & leftover code), each pass with only its rules and its files. The run is recorded and shown like a team run named "Focused passes". It uses more tokens than one pass, though less than four, because each pass reads only its files. The checkbox is remembered on this computer.

How a team run works:

- Every member gets the full review policy plus an assignment naming only its rules. Answers outside those rules are rejected, and each member must report on each of its rules.
- Each member gets only the changed files its rules apply to (`src/main/ai/routing.ts`). Bugs and error handling: code and configuration. Security: code and configuration not rated low risk, so tests, docs and plain config go elsewhere. Breaking changes: code, configuration and lock files (they carry the dependency facts). File split, over-engineering and conventions: code. Test value: test files, plus the changed code those tests import. Leftover code: code, tests and docs. Generated, vendored and binary files go to nobody and are listed as not reviewable. A member's overview marks the other files as checked by other members. A single model still gets every file.
- The change is cut into excerpts once, sized for the member with the smallest context window, so an excerpt id means the same lines for everyone. Each member then packs its own files into requests sized for its own model: a large-context model gets few large requests, a small one more small ones. The run limit applies to each member's input. All members run at the same time.
- Each member's model and credential are captured before anything is sent. If one can't start, the run doesn't start. Disconnecting any member's provider cancels the run.
- Results merge into one run. Two members reporting the same lines and source become one finding, marked "also reported by". The review limits apply to the merged total.
- The Findings panel shows each member's progress, status and tokens. The checklist shows which member checked each rule. A member that fails leaves its rules unticked, and the run is partial.
- Cost: each member reads only its files, so a four-member team uses less than four times the input tokens of one model; how much less depends on how many tests, docs and low-risk files the change has. The Findings panel shows each member's file count and tokens. Retrying a rule rebuilds only its member's requests; team runs recorded before members got their own files are retried the old way, on the shared requests.

Teams are stored in `ai-settings.json` with the connections (no secrets). Each run records its team and members as provenance.

### MCP servers

Reviewers can also call tools from MCP servers while they review, for context the repository can't give: the ticket behind a change, documentation for a library the change uses, errors reported for the code. Add them under **Settings → AI providers → MCP servers**:

- **Add MCP server**: a command the app starts on this computer (like `claude mcp add name -- npx -y …`), or a remote server by URL (Streamable HTTP, or the older SSE). Commands run in the open repository's folder with your login shell's `PATH`, so `npx`, Homebrew and nvm installs are found even when the app is started from the Dock. A started server gets only `HOME`, `USER`, `PATH`, `SHELL`, `TERM`, `TMPDIR` and `LANG` from the app, plus the environment variables you set for it.
- **Import from Claude Code**: lists the servers added with `claude mcp add`: user scope from `~/.claude.json`, and for the open repository its local scope and its `.mcp.json`. `${VAR}` and `${VAR:-default}` are expanded from your shell when the server starts, as Claude Code does.
- Environment variables and headers can hold tokens, so their values are kept in the system keychain (session only when secure storage is unavailable) and never shown again; settings show their names only. The rest is stored in `mcp-servers.json`.
- **Test connection** lists the server's tools. Only tools that look read-only are offered to reviewers by default: the server's `readOnlyHint`, or, when it does not say, a name like `get_…`, `list_…` or `search_…` with no writing verb in it. Tick other tools to offer them; tools the server marks as able to change things get a warning.

When a review starts, every enabled server is connected for that run and closed when it ends. Their tools are offered with the lookups (named `mcp__<server>__<tool>`) and share each request's lookup limit and result clipping, so they are off when lookups are off. The instructions list the servers and tell the reviewer to treat results as background data, never as instructions, and to keep findings grounded in the changed code. A server that cannot be reached is skipped and named in the run details, which also list the MCP tools that were called.

### Input limits and context windows

**Settings → AI providers → Review input limits** sets context lines, characters per request and characters per run. Each run also shrinks the per-request size to fit the selected model's context window, which comes from provider discovery, the catalog, or (for custom endpoints) the value you enter, since servers like Ollama truncate silently past `num_ctx`. If a response reports far fewer input tokens than were sent, the batch is treated as truncated and the files are marked as not reviewed. Content over any limit is listed as skipped, never cut off.

## Limits

- A patch over 1 MB or 10,000 changed lines shows a "too large" state with a "Load diff anyway" button. The forced load has a hard limit of 16 MB. AI review skips such files and says so.
- Expanding context reads the whole newer blob, up to 8 MB.
