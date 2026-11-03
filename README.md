# rig

A small engine for running several Claude Code sessions as one team inside [herdr](https://herdr.dev), on Windows.

One session is the **orchestrator**. You talk to it. It turns agreed work into briefs and sends them to worker sessions called **lanes**: a coder, a reviewer, a gate runner and a board clerk. A **guard** script checks every tool call each session makes and blocks the unsafe ones.

This repo holds the engine only: the scripts, the guard, the tests and a template project called `example`. Your own projects live in folders next to it. Git ignores those folders, so they never enter this repo.

## Contents

1. [What the rig is](#1-what-the-rig-is)
2. [The seats](#2-the-seats)
3. [The loop for a ticket](#3-the-loop-for-a-ticket)
4. [Safety rules](#4-safety-rules)
5. [Requirements](#5-requirements)
6. [Setup on a new machine](#6-setup-on-a-new-machine)
7. [Adding a project](#7-adding-a-project)
8. [Daily use](#8-daily-use)
9. [Tests](#9-tests)
10. [Keeping machines in step](#10-keeping-machines-in-step)

In this file `<rig>` is the folder you cloned this repo into, and `~` is your home folder.

---

## 1. What the rig is

- **herdr** is a terminal multiplexer for coding agents. It gives you panes, tabs and spaces (workspaces).
- Each **lane** is one Claude Code session in one pane. It starts with its own settings file, its own role text and its own guard hook.
- The **orchestrator** is the only seat you talk to. It starts the lanes (with `lanes.ps1`) and prompts them. Lanes never talk to each other: everything goes through the orchestrator.
- The **guard** is a hook that runs before every tool call. It blocks pushes, deploys, secret reads, edits outside the allowed folders and more. See [Safety rules](#4-safety-rules).
- Each project gets its own herdr space and its own lane names, so two projects can run side by side.

The panes of one project, with the example project's lane names:

```
herdr space "example"

 tab 1                                   tab 2 ("seats")
 +-----------------+-----------------+   +-----------------+
 |                 | ex-coder        |   |                 |
 | ex-orchestrator +--------+--------+   | ex-pam          |
 | (you talk here) | ex-    | ex-    |   |                 |
 |                 | angela | oscar  |   |                 |
 +-----------------+--------+--------+   +-----------------+
```

`rig.ps1` names the space after the project and opens tab 2, `seats`, before the orchestrator starts. The orchestrator then runs `lanes.ps1`, which splits the orchestrator's pane to the right for the coder, splits the coder's pane down for angela, splits angela's pane to the right for oscar, and starts pam in the one pane of the `seats` tab. A lane that already runs is left alone.

Lane names are the project's ticket prefix plus the seat name: `ex-orchestrator`, `ex-coder`, `ex-angela`, `ex-oscar`, `ex-pam`.

## 2. The seats

Every seat is plain Claude Code started with its own flags, a settings file and a role file, all under `<rig>\<project>\rules\`.

| Seat | Model and effort | Does | Never does |
|---|---|---|---|
| orchestrator | opus, high | Talks ideas through with you, researches, writes briefs, runs the lanes, reports back, keeps the working notes. | Writes product code. Pushes, merges or deploys. Posts to the board (it may run the board script's reads and dry runs; only pam runs `--live`). |
| coder | opus, high | Builds the change inside one ticket's worktree. For a bug: a failing test first, then the fix. Commits on the worktree branch. | Edits outside the active worktree. Installs packages. Runs herdr. Writes to the rig folder. |
| angela | fable, max | Reviews the change adversarially, with proof: a failing test, an input and its wrong output, or a caller chain as `file:line`. Grades each finding BLOCKING, RESPOND or ADVISORY and ends with a verdict. | Edits anything. |
| oscar | sonnet, medium | The gate. Runs lint, tests, build and type-check in the worktree and reports PASS or FAIL per command against a known baseline. Checks the coder's red-to-green proof. | Edits anything. |
| pam (tab 2) | sonnet, medium | Posts the board updates the orchestrator drafted, only after you say "post". Dry-runs first and flags anything that contradicts the draft. | Edits files. Posts without the line `Jas approved: post` in her brief. |

Rules that hold for every seat:

- A lane runs every command in the foreground, so the orchestrator can tell when it is finished.
- A lane has no `Agent` tool and cannot use herdr.
- A lane answers in a fixed report format between `=== REPORT ===` and `=== END ===`. The orchestrator reads only that block (`report.cjs` extracts it).
- Each seat file has a section named "The project's CLAUDE.md". It is the same text in all four seat files, and `template.test.cjs` checks that.

## 3. The loop for a ticket

The orchestrator runs these seven steps. Nothing goes to a lane before you say "go".

1. **Agree.** You and the orchestrator settle the ticket and its "done when" line. If the ticket touches a core path (see [core scope](#core-scope)), the orchestrator says so and stops, unless you open it as a core ticket.
2. **Prepare.** The orchestrator makes a worktree for the ticket, rewrites the short `now.md` note, and writes one brief file per lane under `<rig>\<project>\work\briefs\`.
3. **Build.** The coder gets its brief, works in the worktree and replies with a report.
4. **Review.** angela gets her brief. A BLOCKING finding goes back to the coder as a second brief. Two rounds at most, then the orchestrator shows you both positions and stops.
5. **Gate.** oscar runs the gate. A FAIL goes back to the coder with the exact failing output.
6. **Report.** The orchestrator tells you the changed files, the commits, angela's verdict, oscar's table, and counters (prompts sent, review rounds, minutes). It appends one line to `work\log.md`.
7. **Close.** After you merge the branch yourself, the orchestrator removes the worktree, clears the lanes and shows you any lessons worth keeping.

The worktree commands, run by the orchestrator (lanes cannot run them):

```powershell
& '<rig>\wt-new.ps1' ex12-short-slug
& '<rig>\wt-new.ps1' ex12-short-slug -Resume
& '<rig>\wt-remove.ps1' ex12-short-slug
```

- The name is `<prefix><number>-<slug>`: lowercase prefix, digits, a dash, then a slug.
- The project is the one whose `profile.json` has that `ticketPrefix`.
- `wt-new.ps1` fetches `origin`, then makes the worktree at `<root>\.claude\worktrees\<name>` on branch `worktree-<name>`, from `origin/<defaultBranch>`. It copies the files the profile lists, links `node_modules` when the profile asks for it and the lock files match, and records the worktree in `<rig>\<project>\active-worktree`. The coder may edit only there.
- It stops, creating nothing, when a listed file is missing, when the root's install is stale against `origin/<defaultBranch>`, or when the worktree exists. The message says what you must do (for example run `npm ci`).
- `-Resume` changes no git state. It makes an existing worktree the coder's again.
- `wt-remove.ps1` refuses a worktree with uncommitted changes. It deletes the branch only if it is part of `origin/<defaultBranch>`, and empties `active-worktree` if it pointed at the removed worktree.
- `wt.selftest.ps1` runs these scripts on throwaway repos, not on a real checkout. The first real `wt-new.ps1` on a project is the check against a real one.

## 4. Safety rules

The guard runs as a `PreToolUse` hook in every seat's settings file:

```
node <rig>/guard.cjs --project <name> --seat <seat> || exit 2
```

Exit 2 blocks the call and sends the reason back to the model. The `|| exit 2` makes a missing or crashing guard block too. The guard also blocks any call it cannot read. Every block message says which rule fired and points here.

### What it blocks

- **Production and money:** `git push` in any form, `vercel`, `supabase db push`, `supabase migration`, `supabase functions deploy`, `ssh`, `scp`, `npm publish`, writes through `gh`, Customer.io write and delete tools, scheduled tasks and jobs, and risky `git config` and plumbing commands.
- **Secrets:** reading `.env*` files (except `.env.example`) and any shell command that names one.
- **Outside services:** uploads to any host but localhost, claude.ai connector tools, remote agents, cloud routines, and `SendMessage`. Workers also lose web fetch and search; research goes through the orchestrator.
- **Core and money code:** edits to the paths and file names a project lists as core. See [core scope](#core-scope).
- **Seat limits:**
  - the coder edits only inside the active ticket's worktree, cannot use `git add -A`, cannot install packages, cannot write files from the shell and cannot name the rig folder;
  - angela, oscar and pam cannot write at all;
  - workers cannot run herdr or start a background command;
  - the orchestrator edits only its own project's knowledge folders and `work\` folder, runs only a fixed list of rig scripts, stays in the main checkout, and runs herdr only for its own lanes. It cannot start a lane, split a pane or open a tab itself: `lanes.ps1` and `rig.ps1` do that.
- **Worktree safety:** recursive deletes of worktrees or `node_modules`, `git clean`, and anyone but the orchestrator creating or removing worktrees.
- **The rules themselves:** edits anywhere in `<rig>\` (except the orchestrator's own working files), to any `.claude\settings*.json`, to Obsidian settings, and to the herdr skill folder.
- **Agents the guard cannot see:** starting `claude` from a shell. A Claude started that way loads no rig settings and so has no guard. Lanes start only through `lanes.ps1`, which holds every lane's flags. The guard lets the orchestrator run it with its own project's name only, and never dot-sourced.
- **Unreadable commands:** `Invoke-Expression`, encoded commands, `bash -c` style wrappers, inline interpreter code and a program piped into an interpreter. For the orchestrator and pam, the two seats with a script list, also every call whose program or script is computed (`& $x`, `& (Get-Command herdr)`, `. $x`, and in Bash a command word `$x`, `"$x"`, `$(...)` or a backtick), Bash `.` and `source`, `Import-Module`, `Invoke-Command` and `Add-Type`, and a program started through .NET, WMI or COM. A dot-source with no blank after the dot (`.'<path>'`) counts as a dot-source. The orchestrator may read herdr's `HERDR_*` variables but not change them: `lanes.ps1` trusts them to know its pane, tab and space.

### Core scope

A project's `profile.json` lists core folders (`coreDirs`), core files (`coreFiles`) and money file names (`moneyNames`). The guard blocks every seat's edit to them.

A ticket that has to change core code is opened on purpose by a file only you write: `<rig>\<project>\core-scope.json`. It holds exactly two fields: the ticket's worktree name and the core paths that ticket may touch.

```json
{ "ticket": "ex12-short-slug", "paths": ["/src/core/file.ts", "/src/core/folder/"] }
```

While that worktree is the active one, the coder's Edit and Write may reach those paths and nothing else core. A money file opens only by its own path, never through a folder. Without the file nothing changes. A broken file opens nothing. Git ignores it, and you delete it when the ticket merges or is parked. The orchestrator gives you the `Set-Content` and `Remove-Item` lines to run; no lane can write the file.

### Known limits

Read these before you trust the rig with anything you cannot undo.

- **The guard is a seatbelt, not a sandbox.** It stops accidents and obvious workarounds. It does not stop a determined attacker.
- **The orchestrator runs with permission prompts off.** `rig.ps1` starts it with Claude Code's `--dangerously-skip-permissions` flag, so for that session the guard is the only barrier: nothing asks you before a call the guard allows.
- **It does not read code a lane runs.** A test, script, build step, git hook or package that the coder writes and then runs executes outside the guard, with your permissions. The coder's worktree code runs by design, so you review the diff before you merge.
- **The coder's shell copy or move after a `cd` out of its worktree is not caught yet.** The guard checks a shell command against the rig folder only by the common spellings of its path. A copy or move that follows a `cd` out of the worktree, or that uses a name built from `$env:HOMEDRIVE$env:HOMEPATH`, can reach rig files and a project's `core-scope.json`. The coder's role text forbids it, and a later change is meant to close it. The same gap lets a shell reach another project's checkout.
- **A text filter has a ceiling.** A command name built at run time (`$(echo claude)`, `& $c`), a name with a stray backslash, and a few other tricks are not read in the coder's, angela's and oscar's shells; the orchestrator and pam refuse every computed call (see [What it blocks](#what-it-blocks)). A name assembled from pieces inside a string the guard can't read, such as `'her' + 'dr'` handed to a .NET call, is past any text filter. The role texts tell each lane not to work around a block.
- **It can block harmless text.** A commit message that holds the word `powershell`, or a command that holds `herdr` or `claude` next to some punctuation, can be stopped. Each block says which rule fired.
- **Approvals are a role rule.** The guard cannot tell whether you really said "post". pam posts only when her brief holds the line `Jas approved: post`, and only the orchestrator writes that line, only after you say it.

## 5. Requirements

| Needs | Notes |
|---|---|
| Windows 10 or 11 | The guard and scripts assume Windows paths. |
| Windows PowerShell 5.1 | The `.ps1` scripts are written for 5.1. Windows client PowerShell refuses local scripts by default: see the execution-policy step in [Start the project](#start-the-project). |
| Node.js 18.17 or newer | Runs the guard, the hooks and every `.cjs` suite. `template.test.cjs` needs 18.17. |
| git | Worktrees and the push gate. |
| herdr 0.9.5 | Install it first (setup step 1). Check with `herdr --version`. The rig was first written for 0.8.2. |
| Claude Code | The `claude` command on your PATH, logged in. |
| GitNexus | The MCP server `gitnexus` in each project's `rules\mcp.json`, started as `gitnexus mcp`, so the `gitnexus` command must be on your PATH. The roles use it for impact analysis before an edit (callers, `detect_changes`, dry-run renames) and for angela's caller checks. Each project's repo must be indexed already: the lanes never index it (`gitnexus analyze` is yours to run). |
| The status line script | `statusline.ps1`, wired in `~\.claude\settings.json` (step 5 of setup). |

The roles carry every herdr command they need, so the rig does not need the herdr skill. The guard does block edits to the skill folder. Your rig folder path must not contain a space, `'` or `$`: `new-project.ps1` refuses one.

### Verify on first run

The rig was written against herdr 0.8.2 and checked against `--help` of 0.9.5 only. No 0.9.5 server was available for the check, so test these once on your machine, inside a herdr pane, before you trust a shift.

Findings from `--help` (no rig command lost an option; 12 of 13 commands unchanged, 1 changed in behaviour):

- Every option the guard allows still exists in 0.9.5. 0.9.5 added optional options the guard does not allow, and the guard refuses them: `--timeout` on `agent start`, `--workspace` on `pane list` and `tab list`, `--ansi` and `--raw` on reads. That is fine unless you need one.
- `agent prompt` changed in behaviour. A `blocked` agent is rejected with `agent_blocked` before any input is sent. With `--wait`, the call needs a working or blocked state within 5000 ms of the submission, otherwise it returns `agent_prompt_stalled`. `--wait` does not track turns: an already-working agent's current turn can satisfy it.
- `agent start` now succeeds only when the agent is detected ready in the pane, within a default of 30 s. `lanes.ps1` does not pass `--timeout`, so it does not extend that.
- `pane current` has `--current` and `--pane <ID>`, but the help does not say what `--current` means.

Commands to run:

```powershell
herdr --version
herdr pane current --current
$env:HERDR_PANE_ID; $env:HERDR_TAB_ID; $env:HERDR_WORKSPACE_ID
herdr agent list
herdr agent get <lane>
herdr tab list
herdr pane list
```

Check that:

1. `herdr pane current --current`, run in a lane's pane, returns that lane's own pane, not the focused one. `rig.ps1` and `close.ps1` depend on it. The three variables name the pane they are read in, its tab and its space (herdr sets them in every pane it manages). `lanes.ps1` depends on them.
2. The JSON that `rig.ps1`, `lanes.ps1` and `close.ps1` read is unchanged under the `result` wrapper. They are the only scripts that read herdr JSON. `report.cjs` and `statusline.ps1` read none (`report.cjs` takes the plain text of `agent read` on stdin). The fields:
   - `pane current --current`: `result.pane.pane_id`, `result.pane.workspace_id`, `result.pane.tab_id`.
   - `agent get <lane>`: `result.agent.pane_id`, `result.agent.workspace_id`, `result.agent.agent_status`. `close.ps1` compares the status with `working`, `blocked` and `unknown`.
   - `pane list`: `result.panes[]` with `pane_id`, `tab_id` and `agent`. `agent` must be empty or absent once the lane has exited.
   - `tab list`: `result.tabs[]` with `tab_id`, `workspace_id` and `label` (compared with `seats`).
   - `pane split` (`lanes.ps1`): `result.pane.pane_id`. `tab create` (`rig.ps1`): `result.tab.tab_id`.
   - Every call above exits 0 on success and non-zero on failure.
3. `herdr agent get <lane>` for a lane that is not running still fails with text that contains `agent_not_found`.
4. `agent prompt <lane> '/exit'` on a `blocked` lane now fails with `agent_blocked`. `close.ps1 -Force` should print "did not take /exit" and close the pane anyway.
5. `agent prompt <lane> "..." --wait --timeout 3600000` on a lane that starts working does not return `agent_prompt_stalled` for a normal brief, and `agent wait <lane> --until idle --until done` still returns when the lane finishes.
6. `lanes.ps1` starts each lane inside the 30 s readiness window. It asks again for up to 15 s while herdr answers `agent_pane_unavailable` (a new pane whose shell is not at its prompt yet). If a slow machine still times out, `lanes.ps1`'s start line needs `--timeout`.
7. `--env`, `--remote` and `--session` are still real herdr options in 0.9.5. Only the guard's allow lists keep them out.

## 6. Setup on a new machine

1. Install herdr 0.9.5 (see herdr's own install instructions at <https://herdr.dev>) and check it:

   ```powershell
   herdr --version
   ```

2. Clone the repo. Use a path with no spaces.

   ```powershell
   git clone <url> C:\rig
   cd C:\rig
   ```

   `<url>` is wherever you keep the repo; `C:\rig` is a suggestion, any folder without a space, `'` or `$` works.

3. Turn on the push gate. It refuses a push that contains a word from your private word list (see [the content gate](#the-content-gate)).

   ```powershell
   git config core.hooksPath .githooks
   ```

   In an engine clone, also set the repo's own commit identity to your GitHub noreply address, so engine commits never carry a work or private email:

   ```powershell
   git config user.email <your noreply address>
   git config user.name <your name>
   ```

4. Run the engine tests. All must pass before you go on. See [Tests](#9-tests) for the whole list; the quickest first check is:

   ```powershell
   node guard.test.cjs
   ```

5. Add the status line to `~\.claude\settings.json`. Merge this into the file; do not replace what is already there. It runs in place: a copy of `statusline.ps1` elsewhere loses its badges.

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\rig\\statusline.ps1"
     }
   }
   ```

   Replace `C:\\rig` with your own `<rig>` path, doubling each backslash (JSON needs `\\` for each `\`). The script shows the usual dev info (folder, branch, model, context, cost), plugin badges and, in a rig lane, a guard shield plus the active ticket and its age.

6. Hooks: you do not add any to `~\.claude\settings.json`. Each seat's own settings file carries its hooks, and a lane loads that file through `--settings` when the orchestrator starts it. They are:
   - the guard on every tool call, in every seat (`PreToolUse`);
   - `refocus.cjs` on session start, `/clear` and compaction, in every seat: it prints `work\now.md` and the seat's notes, plus (a second hook, `--claude-md`) the project's own CLAUDE.md;
   - `context-check.cjs`, orchestrator only, on every prompt: it warns when the session is getting long, so you can rotate (see [Daily use](#8-daily-use)).

7. Make your first project. See [Adding a project](#7-adding-a-project).

### The content gate

`content-gate.cjs` scans every tracked file and its path, and each commit's message, author and committer, for words you do not want to leave your machine. It is for keeping private or work-specific words (names, clients, ids) out of this repo, which holds only the engine. The word list is never in the repo. Put one word per line in `<rig>\.content-gate.local`. Git ignores that file, and the list is per machine.

Save the list as UTF-8, for example `Set-Content -Encoding utf8 <rig>\.content-gate.local` (it then asks for the words, one per prompt; an empty line ends the list). A UTF-16 list, which Windows PowerShell 5.1's `>` and `Out-File` write, is refused.

```powershell
node content-gate.cjs
```

- No list: it prints `skipped: no local list` and exits 0.
- A list that is UTF-16, or that holds no words: it prints one line saying what is wrong and exits 2.
- A hit: it prints one `<where>: <word>` line per hit and exits 1. A word matches only as a whole word, in any case.
- With `core.hooksPath` set as in step 3, `.githooks\pre-push` runs it on every commit of each push (that commit's files, paths, message, author and committer) and refuses the push if it finds anything.

Options: `--list <file>`, `--tree <rev>`, `--messages <rev-range>`.

## 7. Adding a project

A project is a folder in `<rig>` with a `profile.json`, a `rules\` folder and a `work\` folder. `example\` is the template. Make a copy with your paths filled in:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\new-project.ps1 -Name myapp -Root C:\code\myapp -Prefix ma
```

| Parameter | Rule |
|---|---|
| `-Name` | Lowercase letters, digits and `-`, not starting with `-`. The new folder is `<rig>\<name>`. |
| `-Root` | The project's main checkout. It must already exist. |
| `-Prefix` | Lowercase letters only. It becomes the ticket prefix and the start of every lane name (`ma-coder`). |

It refuses, and writes nothing, when:

- the name folder exists, or the name is not in the shape above;
- the name is one the engine tracks (`example`, `test`, `.githooks`) or a Windows device name (`con`, `prn`, `aux`, `nul`, `com1` to `com9`, `lpt1` to `lpt9`);
- the prefix is not lowercase letters, or is `ex` (example's own);
- the root is not an existing folder;
- the rig path or the root holds a space, `'` or `$`.

Otherwise it fills in the name, the root, the prefix and the rig path, then runs `node projects.check.cjs myapp` on the result. If the check fails, or anything breaks while copying, it removes the new folder and exits 1.

What you get:

```
<rig>\myapp\
  profile.json            root, default branch, ticket prefix, lane names, core paths, flags
  rules\
    orchestrator.md       the orchestrator's role text
    orchestrator.settings.json, coder.settings.json, angela.settings.json,
    oscar.settings.json, pam.settings.json
    mcp.json              the MCP servers the lanes may see
    seats\coder.md, angela.md, oscar.md, pam.md
  work\
    notes\                one notes file per seat
    later.md              ideas parked for later
    log.md                one line per finished ticket
    briefs\, pms\         empty folders the lanes write into
```

### The FILL IN parts

The role texts keep the process and the safety rules and leave the project's facts to you. Search for them:

```powershell
Select-String -Path .\myapp\rules\*.md, .\myapp\rules\seats\*.md -Pattern 'FILL IN'
```

Each `FILL IN:` paragraph says what to write. Expect to cover:

- the test, lint, build and type-check commands, and the baseline of known failures;
- the core and money paths, and why each is core;
- risky areas the reviewer should read first;
- the ticket prefix and the board, or "none";
- the rules in the repo's own CLAUDE.md that work differently in the rig.

Edit `profile.json` for the same facts. Its fields:

| Field | Meaning |
|---|---|
| `name`, `root`, `defaultBranch`, `ticketPrefix` | The folder name, the main checkout (forward slashes), the branch worktrees start from, the prefix. |
| `lanes` | The five lane names: `orchestrator`, `coder`, `angela`, `oscar`, `pam`. |
| `knowledgeDirs` | Folders in the main checkout that only the orchestrator may write. |
| `coreDirs`, `coreFiles`, `moneyNames` | The core folders (`/src/lib/`), core files (`/src/lib/x.ts`) and money file names. |
| `boardScript` | `null`, or a script the orchestrator may run in the main checkout. |
| `worktreeCopy` | Files copied from the root into each new worktree (for example an env file). |
| `nodeModulesJunction` | `true` links the root's `node_modules` into each worktree when the lock files match. |
| `projectSettings` | `false` keeps the repo's own `.claude\settings.json` out of every rig session. |
| `pms` | Optional. The project's board: `{ "projectId": "...", "envFile": "..." }`, the env file relative to the root. |

The guard validates the profile on every call. A wrong field blocks every call of that project, and `rig.ps1` shows the reason before it starts Claude.

When the profile is right, run the project check:

```powershell
node projects.check.cjs myapp
```

### Start the project

Open herdr and make a space for the project, with its first pane in the project's root:

```powershell
herdr workspace create --cwd C:\code\myapp --label myapp
```

(Or make the space from herdr's own UI. The orchestrator is not allowed to create spaces.)

Windows client PowerShell refuses local scripts by default, and `rig.ps1`, `lanes.ps1`, `wt-new.ps1`, `wt-remove.ps1` and `close.ps1` all run without `-ExecutionPolicy Bypass`. Allow them once:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

If you got the rig as a zip download rather than a `git clone`, Windows marks the files as downloaded and RemoteSigned still refuses them; clear the mark first:

```powershell
Get-ChildItem -Recurse <rig> | Unblock-File
```

Then, in that space's first pane, run `rig.ps1` by its full path. The pane starts in the project's root, not in `<rig>`. With the rig in `C:\rig` as in setup:

```powershell
& 'C:\rig\rig.ps1' myapp
```

`rig.ps1` takes the project name as its one parameter. It asks the guard to accept the profile, names the herdr space after the project, opens the space's `seats` tab if it has none, moves to the project's root and starts the orchestrator. A herdr step that fails only warns, and it warns if you are not inside a herdr pane. The orchestrator then runs `lanes.ps1`, which starts the four lanes.

## 8. Daily use

1. **Start.** In the project's herdr space, run `& '<rig>\rig.ps1' <name>` (by its full path: the pane starts in the project's root, not in `<rig>`). The orchestrator reads what Refocus printed, runs `lanes.ps1` to start any missing lane (it repeats every line that is not "running" or "started", such as a dialog to answer in a lane's pane) and tells you in three lines: the mission, the current ticket and what it proposes next. It also repeats every `[rig] WARNING` line first and names any `FILL IN:` paragraph still unwritten.
2. **Talk.** Most of the time you just talk with the orchestrator about ideas, bugs and trade-offs. When you agree on a piece of work, say "go". The orchestrator then runs [the loop](#3-the-loop-for-a-ticket).
3. **Briefs.** Each brief is a file under `<rig>\<project>\work\briefs\`. The orchestrator prompts a lane with `herdr agent prompt <lane> "Read <brief> and do it." --wait --timeout 3600000`, and extracts the report with:

   ```powershell
   herdr agent read <lane> --source recent-unwrapped --lines 400 | node <rig>/report.cjs --ticket EX-12
   ```

   `report.cjs` prints the last complete report block whose `Ticket:` line matches, or nothing.

4. **Reports.** You get the changed files, the verdicts and the counters. You review the diff, then merge and push yourself. Nothing leaves the machine without you.
5. **A lane waiting on an approval prompt** shows as `blocked`. The orchestrator tells you which lane. Answer the prompt in that lane yourself.
6. **Rotation.** The orchestrator's session fills up. Once its context reaches 400,000 tokens, `context-check.cjs` prints a warning on each prompt. (Set the environment variable `RIG_CONTEXT_LIMIT` to change the limit.) The orchestrator finishes its step, writes a handoff file (`## Start here` block, 20 lines at most) in `.agent\handoffs\` of the project's main checkout and tells you to type `/clear`. After the clear, Refocus loads `now.md` and the handoff, and the session carries on from the handoff's next action.
7. **Close.** Say "close" (or "close anyway"). The orchestrator checks that no lane is working, writes a handoff, and runs its last command:

   ```powershell
   & '<rig>\close.ps1' <name>
   ```

   `close.ps1` checks everything first, then sends each lane `/exit` and closes its pane, closes the `seats` tab if only lanes were in it, and closes the orchestrator's own pane last. It refuses if a lane is `working`, `blocked` or `unknown`; `-Force` ("close anyway") overrides that. It never stops the herdr server or closes the space. It needs `HERDR_ENV=1`, which herdr sets inside its panes.

## 9. Tests

Run every command from `<rig>`. Each suite reads only the repo, temp folders and read-only `--help` output. A fresh clone passes them all with no project folder present. Each `node` suite prints its pass count and exits non-zero on a miss. Each PowerShell selftest prints `ok` or `FAIL` lines and sets its exit code.

```powershell
node guard.test.cjs
node helpers.test.cjs
node pms.test.cjs
node config.test.cjs
node template.test.cjs
node projects.check.test.cjs
node content-gate.test.cjs
powershell -NoProfile -ExecutionPolicy Bypass -File close.selftest.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File rig.selftest.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File lanes.selftest.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File statusline.check.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File wt.selftest.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File new-project.selftest.ps1
```

| Suite | Covers | Count at the last run |
|---|---|---|
| `guard.test.cjs` | The guard's decisions: at least one blocked and one allowed case per rule, run on `example` and a second fixture. | 3085 checks |
| `helpers.test.cjs` | `report.cjs`, `refocus.cjs`, `context-check.cjs`. | 79 checks |
| `pms.test.cjs` | The board client's dry runs, refusals and filters, against a fake board on localhost. | 305 checks |
| `config.test.cjs` | The profile validator, the `.gitignore` globs, `rig.ps1`, `lanes.ps1` and the worktree scripts, and `example`'s settings. | 175 checks |
| `template.test.cjs` | The template: the shared CLAUDE.md section, its one placeholder, its hooks and its `lanes.ps1` line against the guard, its FILL IN paragraphs. | 7 checks (6 when there is no local word list) |
| `projects.check.test.cjs` | The real-project check below. | 12 cases |
| `content-gate.test.cjs` | The content gate and the pre-push hook. | 20 cases |
| `close.selftest.ps1` | `close.ps1` against a fake herdr on an isolated PATH. About a minute. | 63 ok lines |
| `rig.selftest.ps1` | `rig.ps1`'s herdr steps against the same fake herdr and a fake `claude`. About 20 seconds. | 35 ok lines |
| `lanes.selftest.ps1` | `lanes.ps1` against the same fake herdr. About 2 minutes: one case waits out the 15 s retry. | 48 ok lines |
| `statusline.check.ps1` | The status line output. | 24 ok lines |
| `wt.selftest.ps1` | The worktree scripts on temp repos. | 18 ok lines |
| `new-project.selftest.ps1` | `new-project.ps1`, on temp folders only. Slow: about 10 minutes. | 37 ok lines |

What green means:

- Green means the engine behaves as designed for the fixtures. It does not mean your real projects are set up right. For that, run:

  ```powershell
  node projects.check.cjs
  ```

  It checks every project folder except `example`: the profile loads, every hook that runs a rig script starts with `node <rig>/`, names `--project <name>` and points at a script that exists, lane names, ticket prefixes and roots are unique, and every profile lists the other projects' knowledge folders. Name projects (`node projects.check.cjs myapp`) to check only those. With no project it prints `projects: none besides example` and passes. `node projects.check.cjs --rig-dir` prints the rig path as the guard writes it.

Known limit: a `TEMP` path that holds a space breaks some suites (`new-project.ps1` refuses a rig path with a space, and the suites copy the rig into `TEMP`). Set `TEMP` to a folder without a space before you run them.

## 10. Keeping machines in step

Improvements flow both ways through git. On each machine, after every `git pull` and before the next shift:

```powershell
git pull
node guard.test.cjs
node helpers.test.cjs
node pms.test.cjs
node config.test.cjs
node template.test.cjs
node projects.check.test.cjs
node content-gate.test.cjs
powershell -NoProfile -ExecutionPolicy Bypass -File close.selftest.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File rig.selftest.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File lanes.selftest.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File statusline.check.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File wt.selftest.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File new-project.selftest.ps1
node projects.check.cjs
```

If any of them fails, do not start a shift until you know why.

A pull changes the engine and the `example` template. It does not change your real projects, which are git-ignored: a project made earlier keeps its own copies of the role texts and settings files, so carry a template change over by hand. A lane that was started before the pull keeps the hook commands and role text it started with. Close the shift and start it again after a pull that changes the guard or a settings file.

A project made before `lanes.ps1` still has `herdr agent start` and `herdr pane split` lines in its `rules\orchestrator.md`, and the guard now refuses them. Copy the template's startup steps and its "Starting lanes" section into it, with the project's name in the `lanes.ps1` line, and switch `supermemory@supermemory-plugins` off in its four worker settings files as the template does.

When you change the engine on one machine:

1. Run all the suites.
2. Run `node content-gate.cjs`.
3. Commit and push. The pre-push hook runs the gate again.
