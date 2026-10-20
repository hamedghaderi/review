# User guide

How to use Review: browsing, reviewing, publishing to GitHub and AI review. For how it's built, see [architecture.md](architecture.md).

## Browsing and opening reviews

The app opens in the **Browse** workspace. The sidebar holds **Pull requests**, **Pinned** branches, **Local** branches and one entry per **remote**. Branch namespaces (`feat/`, `fix/`, `release/`…) are collapsible folders. Sidebar section, expanded folders, pins, searches, filter, selection, scroll position and the chosen base are saved per repository. **Open review** switches to the files/diff/comments workspace; **Browse** in the header goes back with everything as you left it.

**Repository tabs.** Each repository you open gets a tab above the header; **+** opens another. A tab shows how many open pull requests there request your review (drafts not counted, same as the dock badge), updated by the background check; with GitHub disconnected or notifications off it shows none rather than an old number. Switching tabs puts you back where you were in that repository (view, open review, sidebar and search), and `⌘1`–`⌘8`/`Ctrl+1`–`Ctrl+8` switch by position (`9` is the last tab). Closing a tab (**×**, or middle-click) keeps its reviews, and its review requests still notify; opening it again, or clicking one of its notifications, brings the tab back. Only one repository is active at a time, so switching tabs stops an AI review that is running in the other one (**Resume** continues it later).

Keyboard: `⌘,`/`Ctrl+,` opens settings (from anywhere, even before a repository is open), `⌘P`/`Ctrl+P` quick open (PRs and branches), `/` focuses the visible search (not while typing elsewhere), `↑`/`↓`/`Home`/`End`/`PgUp`/`PgDn` move, `Enter` selects (or toggles a folder, `←`/`→` too), `⌘`/`Ctrl+Enter` opens the selected review, `Esc` clears the search or closes the palette. Tab moves between the sidebar, search, list and preview as usual.

Quick open starts with the PRs waiting for your review (when signed in to GitHub), your recent reviews, the checked-out branch and recently updated branches. Typing searches all of them; a branch that has a PR in the results is listed once, as the PR. `Tab` switches between All, Pull requests and Branches (or start the query with `pr ` or `b `). `Enter` opens the review (a branch against its default base), `⌘`/`Ctrl+Enter` shows the item in Browse instead, and `⌘`/`Ctrl+K` lists more actions: open on GitHub, copy link, copy branch name.

### Branches

Read with `git for-each-ref` only; nothing is fetched. `main`, `origin/main` and `upstream/main` are separate entries; `refs/remotes/*/HEAD` aliases are hidden. The checked-out branch is labelled _checked out_, which is separate from the selection. Ahead/behind numbers in rows are **relative to the configured upstream**. The preview shows ahead/behind relative to the chosen base and the exact merge base it will review.

The base picker is searchable. The default comes from the repository, not a hard-coded name: the remotes' `HEAD` targets (upstream first, then origin), then local branches of the same name, then `main`/`master`/`develop`/`trunk`. A review compares `merge-base(base, head)..head`. Missing refs, unrelated histories and shallow clones (where a merge base may just not be downloaded) are reported as such.

### Commits

To review commits that aren't a branch comparison, type them in Quick open (`⌘P`) the way git writes them and pick **Review these commits**:

- a commit's SHA (at least 7 characters): that commit alone, compared with its parent;
- `a..b`: what `b` has after `a`, for example `topic~3..topic` for the last three commits of a branch;
- `a...b`: from the merge base of `a` and `b` to `b`, like a branch review;
- either side left out means `HEAD`, so `HEAD~2..` is your last two commits.

Anything git resolves to a commit works on either side (a SHA, a branch, a tag, `HEAD~3`, `main^`). The review stores the SHAs it resolved to, so it never changes and never offers an update; type the range again for newer commits. A range with the same two SHAs as a branch review opens that review. Commits reviews can't be published; the first commit of a repository has no parent to compare with.

### Pull requests (GitHub)

Repositories are detected from HTTPS, SSH, scp-style and `git://` remotes. If remotes point at different GitHub repositories (fork `origin` plus `upstream`), `upstream` is used by default, and you can choose another one under the **GitHub** icon in the header (next to settings; a green dot means connected, red means the connection failed); the choice is saved per clone.

Filters: Open (includes drafts), Review requested, Mine, Drafts, Merged, Closed (unmerged), All. The default sort is most recently updated. Search runs on GitHub (`/search/issues` without a token, GraphQL with one) and is paginated, so it covers the whole repository. It is debounced, and a newer search cancels the one before it. It accepts title words, `#128`, pasted PR URLs, `@user`, and qualifiers such as `author:`, `head:`, `base:`, `label:`, `review-requested:` and `is:` (click **?** for examples). `repo:`, `org:` and `user:` are dropped so a search never leaves the repository. GitHub's 1,000-result cap and `incomplete_results` are shown as they are. If a refresh fails, the last results are kept and labelled with their fetch time. The preview loads details (description, commits, files, reviewers, SHAs) for the selected PR only.

**Review state.** Rows, the preview and the header of an open PR review show where a PR stands: **Approved** (×n), **Changes requested**, **Reviewed** (comments only), **n approvals, more required**, or **Review required**, plus what you did yourself ("you approved"). The badge follows GitHub's review decision when the repository has review rules. Without rules, it follows the reviews. Each person counts once, with their standing review: an approval or change request stands until they approve, request changes or are dismissed, and a later comment doesn't undo it. The PR author's own replies and pending reviews don't count. Approvals given on an older commit are labelled **(older commit)**. Change requests stay in force after new commits, as on GitHub. The preview lists who approved, requested changes and commented. With a token, list rows get this from the same search query, with no extra requests. Without a token, rows show nothing; the preview reads the PR's review list (one request), which has no review decision. An open PR review re-reads its state every 2 minutes. Search with `review:approved`, `review:changes_requested` or `reviewed-by:@me` to filter.

**Inbox.** The **Inbox** filter lists the open pull requests that need you, with where each one stands: **Re-requested** (asked again after you reviewed), **New** (requested and you haven't looked at it here yet; selecting it in the list counts as looking), **Waiting for you**, **New commits since your review**, and **Reviewed**. They're listed in that order, newest first within each. It combines two GitHub searches (`review-requested:@me`, which includes team requests, and `reviewed-by:@me`), up to 50 each, and needs a GitHub token.

**Review-request notifications.** While the app runs, it checks your review requests on GitHub every 3 minutes (one search across all repositories) and shows a desktop notification, with the system sound, for repositories you have opened in the app: a new request, a request after you already reviewed, or a draft marked ready. Drafts don't notify until they're ready. Clicking a notification opens that PR's review, switching repository if needed. More than 3 at once become one summary. The last state is stored, so requests that arrive while the app is closed are announced at the next start; the very first check only records what's there. The dock icon shows how many requests are open. Turn notifications or the sound off in **Settings · GitHub**. **Send a test notification** there shows a sample. If the system refuses a notification (on macOS: not allowed in System Settings → Notifications), the settings say so instead of review requests going missing silently. In development, `npm install` signs the downloaded Electron app locally (`scripts/sign-electron.mjs`), because macOS refuses notifications from an app bundle that isn't signed as a whole and never lists it in System Settings.

**Stacks.** A pull request is stacked on another when its base branch is that PR's branch. Turn on **Stacks** next to the filters to show each result under the PR it is stacked on. PRs the search didn't return but a result is stacked on (for example the parts underneath a stack whose review was requested from you) are added greyed out, so every stack reaches down to its base branch. Stacks are reviewed bottom up, since each PR's changes build on the one below, and the app keeps one rule for where to start: the **next PR to review** is the lowest PR in the stack that needs you, meaning your review is requested or there are new commits since you reviewed. Drafts come after ready PRs; in a stack that is all drafts, the lowest draft that needs you is where to start. Merging goes the same way: the bottom PR is the one every other PR is built on, so it merges first and the rest wait for it. It is marked **Merge first** wherever it appears (the label doesn't stop you reviewing the others in any order). Everywhere a stacked PR appears, it says where it sits and agrees on that PR:

- **PR list and search**: stacked rows show their position (`Stack 2/6`, counted from the bottom), and the next PR to review shows **Start here**, with or without **Stacks** grouping. The preview lists the whole stack in review order with your own status on each PR in words (● Needs you, ✓ You approved, ✕ You requested changes, You commented; nothing when you're not involved; it is never the PR's overall approval) each PR indented under the one it is stacked on (so a fork shows as PRs side by side at the same indent), and offers **Start at #N** next to **Open review**.
- **Quick open**: stacked PRs show `Stack 3/6`, or `Start here`; ⌘K offers **Start the stack at #N**.
- **An open review**: the second header row shows **Stack 3/6 ▾**, which opens the same list under it, scrolled to this PR (click a PR to open its review), and a button to the next PR: **Review #N first ↓** when a PR below still needs you, or **Next: #N →** when the next one is above.

Your status comes from the same two searches the review-request check runs (requested from you, reviewed by you), cached for 2 minutes and refreshed when your requests change; it works with notifications off but needs a GitHub token. Reviewing a stacked PR already compares it with the branch it is stacked on, so you see only its own changes. That also holds after the PR below is merged. When it was **squash- or rebase-merged**, the base branch gets its changes as new commits, so comparing from the merge base would show them again (GitHub's own diff does, until the branch is rebased). With a GitHub token, the app checks whether GitHub retargeted the PR from a merged PR's branch. If so, it compares with that PR's last commit instead, and the review says so. A PR below that landed as a merge commit, or a branch already rebased onto its base, needs nothing special and is compared as usual. When publishing, comments go on GitHub's diff, which still starts before the merged PR. So comments on removed lines (the left side) are posted as file comments that name their lines. If the check fails, the review opens with the usual comparison and a note saying why. The app connects stacks from one list of the repository's open PRs and their branches (one GraphQL request per 100 open PRs, cached for 2 minutes, up to 1,000). It needs a GitHub token; without one, results stay flat.

**Connecting GitHub** is optional; branches never need it. The quickest way is **Use GitHub CLI login** under the **GitHub** icon in the header. If `gh` is installed and logged in, the app asks it for its token (`gh auth token`) when it needs one, re-reads it every few minutes and after a rejected request, and never stores it. It then has exactly the access `gh` has; publishing and private repositories need the `repo` scope, which `gh auth login` grants by default. A token saved in the app takes precedence over the gh login. The choice is kept in `github-settings.json` (no secrets). Alternatively: Paste a fine-grained personal access token with only **Pull requests: Read** under **GitHub** in the header (a prefilled creation link is provided). It is encrypted with the same credential service as AI keys (`ai-credentials.json`, id `github`) and never sent back to the renderer. Without a token, public repositories work with GitHub's anonymous limit of 60 requests an hour, and rows carry no branch names or review requests. The token is used for **API calls only**. Commits are fetched with Git, which uses your SSH keys or credential helper, so a connected token doesn't mean a fetch will work, and fetch failures say so.

### Opening a pull request

1. Read the PR's base repository, number, base SHA and head SHA from `GET /repos/{repo}/pulls/{n}`.
2. Fetch exactly those two commits by SHA (`git fetch --no-tags --no-write-fetch-head --refmap= <remote> +<sha>:refs/review/keep/<sha>`) from the remote for the base repository, or its HTTPS URL if there isn't one. Fork heads work because GitHub serves them from the base repository. Branches, remote-tracking refs, `FETCH_HEAD`, the index and the working tree are never touched, and the fetch is cancelled if you open something else or switch repositories.
3. Check that the pinned refs resolve to the requested SHAs.
4. Re-read the PR. If its head or base moved during the fetch, start over with the new pair, up to three times; the review shows a notice when this happens. It never mixes versions.
5. Compare `merge-base(base SHA, head SHA)..head SHA`. The PR base SHA, head SHA and merge base are stored separately. Local `HEAD` and GitHub's synthetic merge commit are never used.

When a closed or merged PR's commits can't be fetched any more, or its recorded base already contains the head, the app says the original comparison can't be rebuilt and offers **Open on GitHub**. It never shows an empty diff in that case.

Each review is pinned to its snapshot. While a review is open, the app checks the target (every 15 s for branches, locally; every 2 min for PRs, through the API) and shows **Update available**. Opening the update starts a new snapshot, and your comments carry over to it (see [Carrying comments forward](#carrying-comments-forward)). Findings and viewed files stay with the old snapshot, which keeps its own comments too and is still reachable from the Snapshot selector or **Recent reviews**. Opening a review never starts an AI review.

### Opening a pull request from GitHub

On any pull request page on GitHub, put `review-code.dev` in place of `github.com` in the address (`github.com/owner/repo/pull/58` becomes `review-code.dev/owner/repo/pull/58`). The page hands the pull request to the app with a `review-code://open/owner/repo/pull/58` link; your browser may ask once whether to open Review. The same page has a bookmarklet you can drag to your bookmarks bar, which does it in one click on any pull request.

**A keyboard shortcut on GitHub.** With the **Open in Review** browser extension (Chrome and Firefox) or the userscript at [review-code.dev/open-in-review.user.js](https://review-code.dev/open-in-review.user.js) (for Tampermonkey or Violentmonkey), press **Shift+R** on a pull request. Plain `r` is left alone, because GitHub uses it to quote the selected text in a reply. The shortcut does nothing while you type in a comment box or another field. The extension's options let you choose another shortcut; in the userscript, edit `SHORTCUT` at its top. Both run only on github.com, read nothing from the page except its address, and send nothing anywhere.

The app switches to your clone of that repository, opens the pull request's review the same way **Open review** does, and opens the **Run AI review** dialog. The review only starts when you click **Start review**, because anyone can put such a link in a comment or an email. A link carries only the repository and number. The app ignores anything else under the scheme, including links with extra options. If no clone of the repository is open in Review yet, a notice asks you to open it. A folder that is a clone of another repository leaves the link waiting.

Only one copy of the app runs: opening it again (or a link, which on Windows and Linux starts a second copy) brings the open window forward. The installers register the scheme; a development build (`npm run dev`) doesn't, since it would register the bare Electron binary.

### Carrying comments forward

When you open a newer snapshot with **Review update** / **Fetch and review update**, or go from a branch review to its PR with **Open PR review**, each comment is copied into the new snapshot:

- **Lines unchanged**: the comment moves to the same lines in the new snapshot. Lines added or removed above it, and renames, are followed. Comments on the new version are compared head to head; comments on removed lines are compared base to base.
- **Lines changed**: the comment is marked **Outdated** and shown at the top of the file with the code it was written on (up to 40 lines) and the old line numbers. This also covers lines inserted inside the commented range, a deleted file, and a file that is no longer part of the change (listed in **My comments** only). Once outdated, a comment stays outdated in later snapshots.
- File comments move with the file.

The old snapshot is not changed. Each comment is carried from a snapshot once, so a comment you delete in the new snapshot doesn't come back. A new snapshot opened some other way (for example from **Browse**) carries from the latest snapshot of the same target; a pull request's first snapshot uses the latest review of its head branch. Drafts, findings, finding decisions and viewed files are not carried, and a carried comment loses its link to the AI finding it came from, since that finding belongs to the old snapshot's run. If the old commits can't be read any more, the review still opens and a notice says why nothing was carried.

Publishing: a comment already published from an earlier snapshot shows as published and isn't posted again, since GitHub keeps it on the PR itself. An outdated comment is treated like one outside the diff: skipped, or posted as a file comment that names its old lines and commit (`**lines 20–21 at 1a2b3c4:** …`).

## Following code: go to definition and find uses

To follow a path through a change (which function calls which, who else uses the one that changed) without leaving the app:

- **Go to definition**: `⌘`-click (`Ctrl`-click on Windows and Linux) a name in the code. With the key held, the name under the pointer is underlined. One definition opens directly; several show a list of `path:line` with the matching line to pick from; none shows a short note.
- **Find uses**: `⌘⇧`-click (`Ctrl+Shift`-click), or **Find uses** in the definitions list. Uses are grouped by file. Lines this change touched are marked **changed**, and the count says how many are outside the change. Definitions and import lines are not counted as uses.
- **Where results open**: a result in a changed file jumps to that line in the diff (expanding collapsed context if needed) and marks it. A result in a file the change doesn't touch opens it **read-only** at the head commit, at that line. You can't comment there; go back to the diff for that.
- **Back and forward**: `⌘[` and `⌘]` (`Alt+←` and `Alt+→` elsewhere) return to where you were, with the scroll position. Selecting a file in the tree leaves the read-only view.
- **Which commit**: lookups read the reviewed commits, never the working tree. On a removed line, names are looked up at the base commit, and results open at the base commit (removed lines are marked **removed**).
- A plain click and drag still start a comment; `⌘`/`Ctrl`-click never does.
- **References in findings**: a file reference in an AI finding's text (`src/cart.ts:40`, `src/cart.ts:40-52`, or a path with a folder and no line) is a link, and opens the same way as a result. A bare file name (`cart.ts:40`) links when exactly one changed file has that name. A path that isn't a file at the head commit stays plain text.

Limits: it is a text match, not a language server. A name can be a different thing with the same name, so a common name can list several definitions, and a use can be of another thing called the same. Definitions are recognised by the common forms of JS/TS, Python, Go, Rust, Java, Kotlin, C#, PHP and Ruby (functions, methods, classes, types, `const x = () =>`), the same patterns the AI reviewer's related code uses; anything else is not found. Only source files are searched, and vendored, built and generated folders (`node_modules`, `vendor`, `dist`, `build` and similar), lock files and lines over 400 characters are skipped. At most 50 definitions and 300 uses are listed.

## Existing discussion on GitHub

PR reviews show what has already been said on the pull request, so you and the AI don't raise a point that was discussed or resolved already. It only reads from GitHub: nothing is posted, replied to or resolved from here, and existing comments never go into what **Publish** sends.

- **In the diff**: each review thread appears under the lines it is about, marked **On GitHub**, above your own comments on those lines. It shows its status (**Open**, **Resolved by …**, **Outdated**), every comment with its author and their role on the repository, and a link to GitHub. Resolved threads start collapsed. Unresolved threads stay open even when outdated, because code moving is not the same as someone handling the point.
- **Placement**: a thread appears at a line only where GitHub reports a current position. On a snapshot older than the PR's head, that position is carried back to the snapshot's lines when none of them changed in between (following lines added or removed above). On the commit a thread was written on, its original lines are used. Everything else is listed at the top of its file with the reason and the diff GitHub showed when it was written: outdated threads, lines that differ in this snapshot, old-side threads on another version, and a PR head that isn't in the local repository. Threads on files outside this snapshot's changes appear only in the **GitHub** tab. A thread is never pinned to its original line number on different code.
- **"Already discussed on GitHub"**: your comments, drafts and AI findings on lines that an existing thread covers carry a note naming how many open and resolved threads are there and who started them. A line comment is matched only with a line thread on overlapping lines of the same side, and a file comment only with a file thread. Outdated threads have no current line, so they don't match. The note is worked out when it is shown and stored nowhere. It never hides, lowers or drops a comment or finding, and a resolved thread is not treated as proof the code changed. A comment you published from this app doesn't count as already discussed by its own thread. On an AI finding, the note also says when the AI didn't link those threads, so you can check it isn't the same point again.
- **"Raised before on GitHub"**: the PR's review threads are sent to the AI as T1, T2…, and it is told not to repeat a point a thread already settled. When it does raise one again, it has to name the thread, say what was decided there (agreed to change, answered as not a problem, no answer yet, or unclear) and what is new since. The finding then links to that thread, and the note is highlighted when the thread answered it as not a problem. A finding that names a thread without saying what is new is rejected. A comment posted from such a finding ends with a link to the earlier thread. The decision shown is the AI's reading of the thread, so open it before you post.
- **Whose answer counts**: each comment reaches the AI tagged with its author's role on GitHub: the PR author, someone with write access (owner, organization member or collaborator), or someone without it. Only a thread answered or resolved by someone with write access other than the PR author can talk the AI out of a finding. An answer from the PR author or an outsider is weighed but never stops a finding the code shows, and the "Raised before" note says when nobody with write access answered. On an [automatic review](#automatic-review) no answer settles anything, since nobody reads the findings before they go out.
- **"Read before posting"**: a finding whose text has a link outside this repository, an image, HTML that loads something, an @mention, a request for a password, token or other secret, a command to download or run something, text about the AI's own instructions, or nothing that names the code it cites. The AI read pull request text that anyone can write, and text like this is what a reply would try to steer it into. It's a sign to read it, not proof: you can still add and post it.
- **Description tab** (right panel, PR reviews only): the pull request's description as GitHub renders it (headings, lists, tables, task lists, collapsed sections, issue links), read from GitHub when the tab opens and with **Refresh**. GitHub renders it and the app sanitises the result again, so nothing in a description can run code or add forms. Links open in your browser, and hovering one shows where it goes. Images aren't loaded in the app, so each shows as a link instead. Without a token, public repositories still show it.

  **Edit** (if you are the author or have write access, and GitHub is connected) opens the Markdown with **Write** and **Preview** tabs; the preview is rendered by GitHub, so issue links and mentions look as they will. **Save to GitHub** (or `⌘`/`Ctrl+Enter`) changes it for everyone straight away. Before saving, the app reads the description again; if someone changed it on GitHub since you started, nothing is written, and **Show the new text** shows theirs while keeping your edit to merge by hand. Unsaved edits survive switching tabs and reviews until the app quits. The next AI run of this review gets the new description. Saving needs a token that can publish reviews.

- **GitHub tab** (right panel, PR reviews only): all threads, open first, then review summaries and the PR conversation. It says when it was read (it doesn't update by itself; use **Refresh**, and it re-reads after the Publish dialog closes), and whether the read was partial or failed. A failed read says earlier comments may exist; it never shows as "no discussion".
- **With a token** (or the GitHub CLI login), one read-only GraphQL query per 50 threads (up to 500), since only GraphQL reports resolved and outdated threads. **Without a token**, REST is used for public repositories, and resolved state is shown as unknown.
- Limits: 30 comments per thread, 100 reviews and 100 conversation comments, and 20,000 characters per comment. Anything cut is counted in the panel. Comment text is third-party text: it is shown as plain text, and links are shown only when they point to `github.com`.

## Publishing a review to GitHub

Reviews opened from a pull request show **Publish** in the header; its tooltip says how many comments it would send (never published, or edited since). For branches, the app looks up their pull request: it asks GitHub for PRs whose head is `owner:branch`, where the owner comes from the remote the branch is pushed to (its upstream, or `origin`). It lists open ones first, and caches the answer for two minutes. The branch preview in Browse and branch reviews both show that PR with **Open PR review**. On a branch review with no PR, the button is shown disabled with the reason. **Open PR review** carries the branch review's comments into the PR review (see [Carrying comments forward](#carrying-comments-forward)). Nothing is published automatically unless you turn on [automatic review](#automatic-review), and saving locally never sends anything.

1. **Add comments to your pending review.** The dialog lists the snapshot's comments with checkboxes. Selected comments go into your _pending_ review on the PR, which only you can see, attached to the snapshot's head commit. The first comment creates the pending review; later ones are added to it. GitHub allows one pending review per person per PR. If you already started one on GitHub for the same commit, the app adds to it. If yours is on a different commit, publishing is blocked with an explanation, since mixing commits would misplace comments.
2. **Submit** as Comment, Approve or Request changes, with an optional summary (required for Comment and Request changes when there are no comments). Submitting needs a second confirmation, because it is public and can't be undone. You can also finish on GitHub instead.

   Next to the verdict, the dialog shows CI for the snapshot's head commit: how many checks failed, haven't finished and passed, with the names on hover and **Refresh**. CI often fails after a review is done. So when you choose **Approve**, the app reads the checks again before asking you to confirm. If any failed or haven't finished, the confirmation says so, naming the most recent failure and how long ago it happened, and the button reads **Approve anyway**. Nothing is blocked; it makes sure you know before you approve.

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

### Automatic review

Off by default. With **Review requests automatically with AI** on (**Settings · GitHub**), the app reviews a pull request by itself when your review is requested and submits the review on GitHub **as you**, approvals included. Ticking the box opens a warning first; it is turned on only from there, with **Turn on automatic review**. Unticking turns it off at once.

- **When**: the review-request check (every minute while the app runs) sees a new request, a request after you already reviewed, or a draft marked ready, in a repository you have opened here. New commits on a pull request you reviewed do not start one. It also runs with notifications off. Your own pull requests and drafts are skipped, and each head commit is reviewed at most once.
- **What runs**: the model or team chosen for AI reviews, on every changed file, the same as **Run** with everything the run normally reads (project context, related code, CI facts, your earlier dismissals). The pull request is opened in the background, so what is on screen doesn't change; the snapshot appears in the review list like any other. One review at a time: if you are running an AI review it waits for yours, and while it runs, starting your own says an automatic review is running. Opening other reviews or repositories doesn't stop it; **Cancel** in its own review does, and then nothing is posted.
- **What is posted**: findings at the levels under **Add to the code when a run finishes** (**Settings → AI providers → Finding levels**), as comments, the same ones the app would add for you; findings the double-check shows likely wrong, and findings marked **Read before posting**, are left in the app. The review is then submitted with a short summary that says it was written by AI on your behalf, naming the model or team:
  - **Request changes** when a blocking finding stands (not dismissed, held back, shown likely wrong or marked **Read before posting**).
  - **Approve** only when every file was reviewed, nothing was posted, no blocking, should-fix or question finding is left, no finding was kept back as **Read before posting**, and CI for the head commit finished without a failure. If unfinished CI is the only thing in the way, it waits for it, reading the checks again every minute for up to 20 minutes. Meanwhile the next request waits its turn. If CI is still running after that, failed, or can't be read, it comments instead and says why, naming a failed check.
  - **Comment** otherwise, saying how many findings were posted and how many were left for a person to check, and when files were not reviewed.
- **When it doesn't post**: you already have a pending review on that pull request (submitting would send your comments too), the pull request is closed, the run fails or is cancelled, or you turn it off before it posts. Each case shows a notification saying why. If posting fails halfway, the comments already sent stay in your pending review on GitHub.
- **Afterwards**: a notification says what it did (shown even with review-request notifications off, with the sound setting); clicking it opens the pull request's review. The comments are in the snapshot like ones you added, linked to their findings. If that review is open on screen, they appear there too.

It needs a token that can publish reviews and a model chosen for AI reviews. A run cancelled by quitting the app isn't retried at the next start.

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

**Test connection** only lists models. It sends no repository content and runs no inference. Once a connection has tested OK, its model list also refreshes by itself: when the app starts, when you come back to it after five minutes or more, and when you open the model picker. Models you add on the provider's side, such as in OmniRoute's dashboard, show up without testing again. If a background refresh fails, the previous list and status stay as they were. **Test model** is a separate, explicit action: it sends one small synthetic request (a four-line made-up diff) to confirm that the model answers in the findings schema.

Models are labelled by source:

- **Available**: listed by the provider for this key.
- **Catalog**: from the built-in list in `src/main/ai/catalog.ts`, not yet verified for your account.
- **Manual**: an ID you typed.
- **Tested**: passed "Test model".

After a successful test, catalog entries the account doesn't list are no longer offered.

**Prices.** Each model shows its price in US dollars per million input and output tokens. Click it to enter your own. Prices come from, in order: your own price for that model on that connection; the provider's model list (OpenRouter reports prices); free for connections made from the Ollama and LM Studio presets; and the catalog's list prices. Catalog prices are dated with the catalog and may be out of date, so costs worked out from them are marked **estimated**. A model with no price, such as one on a gateway or a custom endpoint, shows **Set price**, and runs on it show no cost until you set one. Costs use list prices at the standard tier. Prompt-cache reads and writes are billed at their own prices. Higher long-context prices (Claude Haiku over 100,000 input tokens, for example) aren't applied.

The run details show the cost next to the tokens, and team runs show it for each member. A run is costed at the price its models had when it started, so changing a price later doesn't change earlier runs. A request that reported no usage, or used a model without a price, isn't counted. The cost then reads "at least …", never a lower number that looks complete.

### Choosing a model

The picker next to **Run AI review…** groups models by connected provider. Only text models are listed: image, video and embedding models that a gateway such as OmniRoute reports (by `type` or `output_modalities`) are left out, since they can't answer a review. It supports search, keyboard navigation (↑/↓, Enter, Esc) and a **Manage providers…** link, and it remembers the last valid choice across restarts. If that model or provider goes away, the picker says why instead of picking another one.

The Run dialog reviews **All files**, the **Current file**, or only the **Unviewed** files: the ones you haven't marked viewed in the file tree. Unviewed is offered once some, but not all, files are marked viewed. The other files are still listed to the model as outside the requested scope, and related code and lookups can still read them.

After new commits, the dialog also offers **Changed**: only the files whose diff is different from when the last finished run of the same pull request or branch reviewed them. It is chosen by default when it's offered. Every other file keeps that run's coverage and findings, shown as carried, and a finding you dismissed or added as a comment there stays dismissed or added. A file carries only when that run reviewed it fully; one it skipped, reviewed partly, or left out of its scope is reviewed again. A rebase that leaves a file's diff as it was doesn't count as a change. Changed isn't offered when the earlier run used another model or team, other rules (such as Bugs & security only), other finding levels or an older prompt: then every file is reviewed again, and the dialog says why. An unchanged file is reviewed again when its added lines use a name whose definition changed since that run (a changed signature, or a name removed or renamed), and the dialog and the run summary say which names. A change to a function's body alone doesn't do this, or every caller would go along; related code and lookups can still read the unchanged files, but a problem there is only caught if the reviewer looks. Only changes in the pull request's own files count: a definition changed on the base branch and merged in doesn't send its users for review again.

When a review starts, the chosen connection, provider, protocol, model, endpoint and credential are fixed for the whole run. Changing the picker only affects later runs. Disconnecting a provider, replacing its key or changing its endpoint cancels a run that is using it, and any late responses are discarded. After an error the app never switches to another provider or credential. Each run stores its provenance (connection, provider, protocol, model, endpoint, prompt version, the limits actually used), so past reviews stay readable after a provider is disconnected.

### Credentials

- API keys go from the renderer to the main process through one validated IPC call (`setCredential`). There is no call that reads a key back. The key field is cleared after saving.
- Keys are encrypted with Electron `safeStorage` (macOS Keychain, Windows DPAPI, Linux libsecret/KWallet) and stored in `<userData>/ai-credentials.json` (mode 0600). They are kept separate from the nonsecret `<userData>/ai-settings.json` and from `review-store.json`.
- If secure storage is unavailable, or on Linux the backend is `basic_text`/unknown, keys can only be used for the current session and are kept in memory. Nothing is written in plaintext, and the settings screen explains why.
- Each key is bound to the connection's endpoint and protocol. Changing a custom endpoint deletes the key, so you have to enter it again for the new endpoint. Disconnecting deletes the key.
- Error messages are scrubbed of the key and of anything that looks like one before they are shown or stored. SDK clients get every option explicitly, so they never read `OPENAI_*`, `ANTHROPIC_*` or `GOOGLE_*` variables. Git subprocesses don't receive provider variables either.

### Review teams

A review team splits the 16 rules between several models, so each one checks only its part. Create one with **+ New review team** in the model picker, or under **Settings → AI providers → Review teams**. A new team starts with four roles and a connected model suggested for each; you can rename roles, pick any connected model, add or remove reviewers (1 to 8), and choose who checks each rule:

| Role                  | Rules                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| Defects               | Bugs, missing or hidden error handling, performance                                              |
| Security              | Security                                                                                         |
| Callers & structure   | Breaking changes, a file taking on a second job, over-engineering, conventions, misleading names |
| Tests & leftover code | Test value, the 6 leftover-code signatures                                                       |

Every rule must have exactly one reviewer before a team can be saved. Pick a team in the model picker like a single model; choosing a model switches back.

**Focused passes** gets the same split without building a team: with a single model chosen, tick **Focused passes** in the Run dialog and the model runs once per default role (Defects, Security, Callers & structure, Tests & leftover code), each pass with only its rules and its files. The run is recorded and shown like a team run named "Focused passes". It uses more tokens than one pass, though less than four, because each pass reads only its files. The checkbox is remembered on this computer.

**Bugs & security only** is for a quick check: tick it in the Run dialog and the model checks only the bug and security rules, on only the files those rules apply to. With **Focused passes** also ticked, just the Defects and Security passes run, each with only that rule. The Findings panel lists the other rules as "not checked". The checkbox applies to one run and is not remembered, so a full review stays the default.

### Personas (lenses)

A persona is a lens on the same 16 rules, in the spirit of a well-known way of reviewing code. It tells the model where to look harder and how strict to be about evidence. It adds no rules and changes no limit, level or wording rule, so a Clean Code lens still never comments on function length or naming taste. Where the lens and the rules seem to differ, the rules win, and a finding never mentions the lens.

| Persona     | Inspired by                                              | Rules it owns in a persona team                               |
| ----------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| Clean Code  | Robert C. Martin (Uncle Bob), _Clean Code_               | File split, over-engineering, misleading names, leftover code |
| Test-driven | Kent Beck, _Test-Driven Development_                     | Test value                                                    |
| Pragmatic   | Andrew Hunt and David Thomas, _The Pragmatic Programmer_ | Bugs, missing or hidden error handling                        |
| Performance | Donald Knuth on premature optimization                   | Performance                                                   |
| Security    | The OWASP Top 10                                         | Security                                                      |
| API steward | Hyrum's Law                                              | Breaking changes, conventions                                 |

There are three ways to use them:

- **One model with a lens**: pick a **Lens** in the Run dialog. The model still checks every rule and looks harder where the lens says. It works with **Focused passes** too, and then every pass uses it. The choice is remembered on this computer, like the checkbox. Automatic reviews don't use it.
- **A persona team**: **+ New persona team** under **Settings → AI providers** starts a team with one member per persona, each owning the rules in the table, so every rule is checked once. Edit it like any team.
- **A lens on any team member**: each member in the team editor has a **Lens**. Picking one renames a member whose name you haven't changed.

The names are approaches, not people. That matters because a team's name appears in what an automatic review posts. Each run records its lens, and the Findings panel shows it next to the model. The persona texts are in `src/shared/personas.ts`.

How a team run works:

- Every member gets the full review policy plus an assignment naming only its rules. Answers outside those rules are rejected, and each member must report on each of its rules.
- Each member gets only the changed files its rules apply to (`src/main/ai/routing.ts`). Bugs and error handling: code and configuration. Performance: code. Security: code and configuration not rated low risk, so tests, docs and plain config go elsewhere. Breaking changes: code, configuration and lock files (they carry the dependency facts). File split, over-engineering, conventions and misleading names: code. Test value: test files, plus the changed code those tests import. Leftover code: code, tests and docs. Generated, vendored and binary files go to nobody and are listed as not reviewable. A member's overview marks the other files as checked by other members. A single model still gets every file.
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
- **Test connection** lists the server's tools. Only tools that look read-only are offered to reviewers by default: the server's `readOnlyHint`, or, when it does not say, a name like `get_…`, `list_…` or `search_…` with no writing verb in it. Tools that can reach any web address (`fetch`, `fetch_url`, `browser_…`, or a description like "fetches a URL") are never offered by default, even when the server calls them read-only: a request for `evil.example/?q=…` sends out whatever the AI read without writing anything. Tick other tools to offer them; tools the server marks as able to change things get a warning.
- **Not offered on text from outsiders**: a run gets no MCP tools when it includes text from someone without write access to the repository: the pull request itself (its code and description) when its author has none, or a linked issue or comment by an outsider. Such text could tell the AI to call the tools. The run's notices say so and name what came from outsiders. When the author's role couldn't be read, the pull request counts as from an outsider. Branch reviews aren't affected.

When a review starts, every enabled server is connected for that run and closed when it ends. Their tools are offered with the lookups (named `mcp__<server>__<tool>`) and share each request's lookup limit and result clipping, so they are off when lookups are off. The instructions list the servers and tell the reviewer to treat results as background data, never as instructions, and to keep findings grounded in the changed code. A server that cannot be reached is skipped and named in the run details, which also list the MCP tools that were called.

### Background on a pull request

A pull request review tells the reviewer what the change is for, with every request from every member:

- **The description** (up to 8,000 characters).
- **Linked issues**: the issues the pull request closes (GitHub's closing references, such as "Fixes #12"; these need a GitHub token) and up to 5 issues its description mentions (`#12`, `owner/name#12` or an issue link; numbers in code are skipped, and pull requests are left out). For each one it sends the title, state, description (up to 3,000 characters) and its latest 20 comments. All issues together get up to 10,000 characters.
- **The conversation so far**: review threads (open ones first, with file, line and whether they are resolved or outdated), review summaries and PR comments, newest first, up to 8,000 characters. Comments in your own unsubmitted GitHub review are left out.

Anything over a limit is cut and marked as cut. The instructions treat all of it as data written by people, like the description: issues show what was asked for, so a requirement the code misses can be a finding (citing the code), and the conversation shows what was already raised and decided. A resolved thread or a reply saying "fixed" is not evidence; the reviewer checks the code. The run details list what was sent under **Background** (for example "description; issue #12 (closes, 4 comments); conversation: 3 threads (1 open), 2 comments"). If GitHub can't be read, the run goes on with the description and says what was missing. Branch reviews get only [your own context](#your-own-context).

### Your own context

The **Context** tab in the right panel holds what the code can't tell the reviewer: requirements, a spec, logs, screenshots, where to look. It works for branch and pull request reviews.

- **Notes**: up to 10,000 characters, saved with the review like your comments.
- **Files**: up to 5 text files (Markdown, logs, JSON, source…), picked with **Add…** or dropped on the panel, each up to 400 KB and 100,000 characters. Binary and empty files are refused with the reason.
- **Images**: up to 5 PNG, JPEG, GIF or WebP images, added the same way or pasted (a screenshot copied to the clipboard). Before saving, the app scales each one down to at most 1,568 pixels on its longest side, the size the providers work at anyway: photos stay JPEG, everything else becomes PNG (an animated GIF keeps its first frame). Images are stored once by their content in the app's data folder (`context-images`), not in `review-store.json`, and their type is checked from their bytes, not their name.
- A newer snapshot of the same pull request or branch starts with the context of the one it replaces. Changing it there doesn't change the earlier snapshot.
- Images go with every request of the next run, after the text, in each provider's own format; the text lists them by name and order. Each costs roughly 1,000–3,000 tokens per request, and the request sizing reserves room for them. Many local models and some gateway routes don't accept images: when a request with images is refused, it is sent again without them, that reviewer's later requests skip them, and the run details say so.
- Each request of the next run sends the text fenced as its own section, right after the description: the notes first, then the files share what's left of 20,000 characters (short files whole, long ones cut evenly and marked as cut). The run details list it under **Background** (for example "your notes, 2 files (spec.md, error.log), 1 image (checkout.png)").
- The instructions let the notes say what the change is for and where to look, but files and images can contain anything (text in a screenshot included), so nothing in them relaxes the rules, removes a finding the code supports or changes the output format.

### Asking about code

Select lines you don't understand (drag across the code, or click a line number and Shift-click another), type a question in the box that opens, and press **Ask AI** (or ⌥↵) instead of **Add comment**.

- Every Ask box (selected code, its follow-ups, and questions about a finding) has a small model picker next to **Ask**. Picking a model there sets it for all of them and is remembered; review runs keep their own model or team. Until you pick one, questions about code go to the model chosen in the header, or, with a review team chosen, the team member that checks callers and structure; questions about a finding go to the model that raised it. A picked model that is no longer offered falls back to those. When another model answers about a finding, it is told the finding was raised by another reviewer.
- The question gets the selected lines with their numbers, the change around them, up to 60 lines of the file on each side, the pull request's title and description, and your earlier messages about the same lines. With lookups on (**Review input limits**), it can also open up to 6 files or searches in the reviewed commits, to find a caller or a definition.
- The answer appears in a card at those lines, marked **Private** with a dashed edge. Questions are saved with the review, never posted, and never sent to the AI reviewer. Ask a follow-up in the card; a conversation holds up to 20 messages. **Delete** removes it.
- On the old side (deleted lines), the model sees the selected lines and the diff, not the whole old file.

### Verifying a finding

**Verify** on a finding card asks a model to try to prove that finding wrong, at any level, the way the run double-checks blocking findings. It reads the finding, the change around it and up to 40 lines of the file on each side, plus what the app found about those lines (CI, tests). With lookups on for that run, it can also open files and search the reviewed commits; MCP tools are never offered here. It uses the model picked for questions, else the model that raised the finding. The verdict (holds, likely wrong, or not settled) replaces the one on the card, and the earlier ones are listed under it. A finding verified as likely wrong isn't added as a comment automatically, but it is never lowered or removed: dismissing it is up to you.

**Write failing test** asks the same model for one test that should fail on the head commit while the finding holds, and pass once it is fixed. It gets the same code as Verify, plus up to two existing tests that import the finding's file, so it can follow the project's framework and style (with lookups on, it can look for others). The card shows where the file would go, what the test checks, and the code with a **Copy test** button. The app never saves it to your working tree or runs it: run it yourself to see whether it fails. When the model says no test can show the finding (it needs a real external service, for example), the card says why. Writing it again replaces the test.

### Input limits and context windows

**Settings → AI providers → Review input limits** sets context lines, characters per request and characters per run. Each run also shrinks the per-request size to fit the selected model's context window, which comes from provider discovery, the catalog, or (for custom endpoints) the value you enter, since servers like Ollama truncate silently past `num_ctx`. If a response reports far fewer input tokens than were sent, the batch is treated as truncated and the files are marked as not reviewed. Content over any limit is listed as skipped, never cut off.

## Limits

- A patch over 1 MB or 10,000 changed lines shows a "too large" state with a "Load diff anyway" button. The forced load has a hard limit of 16 MB. AI review skips such files and says so.
- Expanding context reads the whole newer blob, up to 8 MB.
