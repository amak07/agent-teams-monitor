# Agent Teams Monitor

VS Code extension that monitors Claude Code Agent Teams by reading JSON files from `~/.claude/teams/` and `~/.claude/tasks/`. Read-only observation — never writes to CC's files.

## Build & Test

```bash
npm.cmd run compile      # TypeScript compilation
npm.cmd run package      # Build VSIX (runs compile first)
npm.cmd run watch        # Watch mode for development
npm.cmd run record       # Record a live agent team session
npm.cmd run replay       # CLI replay of a recording
```

### Simulation Harness

Writes files progressively to `~/.claude/teams/` and `~/.claude/tasks/` to simulate real CC sessions. Tests the full pipeline: detection, auto-recording, notifications, replay.

```bash
npm.cmd run simulate             # Run all scenarios sequentially
npm.cmd run simulate:quick       # Quick session (~10s, 5 events)
npm.cmd run simulate:lifecycle   # Full lifecycle (~30s, 15 events, 3 agents)
npm.cmd run simulate:parallel    # Both scenarios concurrently, 3s stagger
npm.cmd run simulate:clean       # Remove all test artifacts (teams, tasks, recordings, history)
```

Scenarios use `sim-` prefix for team names. Cleanup only touches those prefixes (plus mock data teams).

### Install & Verify

```bash
"/c/Users/abelm/AppData/Local/Programs/Microsoft VS Code/bin/code" --install-extension agent-teams-monitor-0.1.0.vsix --force
```

Verify: compile, package, install, reload VS Code, run `simulate:parallel`, watch dashboard.

## Architecture

- **`src/types.ts`** — All interfaces. Verified against real CC data (see SCHEMA-VERIFICATION.md)
- **`src/watchers/fileWatcher.ts`** — Watches `~/.claude/teams/` and `~/.claude/tasks/` with fs.watch + polling
- **`src/state/teamState.ts`** — Central state store. Members are merge-on-update (CC removes agents from config at shutdown, we persist them)
- **`src/views/dashboardPanel.ts`** — Main webview. Uses incremental DOM patching via postMessage (initial HTML render + subsequent `updateData` messages). All CSS is inline. All JS is inside a template literal — **backticks must be escaped as `\x60` in webview JS code**
- **`src/views/agent|task|messageTreeProvider.ts`** — Sidebar tree views
- **`src/replay/`** — Pure in-memory replay system + auto-recorder (records live sessions to globalStorageUri)
- **`src/extension.ts`** — Entry point, command registration

## Key Schema Gotchas

- Task `id` is a **string**, not number. Task `subject` is the **agent name**, not a title
- `color` on members is a name ("blue", "green"), NOT hex. Team lead has no `color` or `backendType`
- Inbox files are JSON arrays. Typed messages are **stringified JSON inside the `text` field** — must `JSON.parse(text)`
- CC removes members from `config.json` at shutdown — `updateTeam()` merges to preserve them
- Recordings are in `recordings/` with `frames/*.json` structure

## Code Style

- No frameworks — vanilla TypeScript, VS Code API only
- Webview HTML/CSS/JS is all in `dashboardPanel.ts` as a single template literal
- Escape HTML with `escapeHtml()` (TS) or `esc()` (webview JS). Use `formatPromptHtml()`/`formatPrompt()` for markdown-like text
- Keep SVG icons inline in the `SVG_ICONS` constant (no external assets)
- Agent lifecycle states: `active` > `idle` > `shutting_down` > `shutdown` (derived from inbox messages, not config)

## Workspace Filtering

Default behavior filters teams to the current VS Code workspace. The `teamMatchesWorkspace()` method checks if any member's `cwd` starts with a workspace folder path. Show-all toggle is hidden but the commands still exist.

## Landing the Plane (Session Completion)

When ending a work session, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**0. Code review** (before committing)

Launch a `superpowers:code-reviewer` subagent with this prompt template:

```
## Code Review Request

**What was implemented:** {DESCRIPTION}
**Plan/Requirements:** {PLAN_FILE_OR_SUMMARY}
**Base SHA:** {BASE_SHA}
**Head SHA:** {HEAD_SHA} (or "uncommitted changes")

Review the full diff and assess:

### 1. Objective Alignment
- Do the changes match the stated plan/requirements?
- Was anything added that wasn't in scope?
- Was anything from the plan skipped or partially done?

### 2. Production Code Safety
- List every non-test file modified and explain WHY it was changed
- Are production changes minimal (no logic/behavior changes beyond what's needed)?
- Could any production change affect users who aren't running tests?

### 3. Regression Detection
- For every piece of MODIFIED code: does the new version preserve 100% of the old behavior?
- For every piece of DELETED code: was it truly unused, or did something depend on it?
- For every REFACTORED function/assertion: compare old vs new — flag any semantic drift

### 4. Test Integrity
- Do modified tests still test the same thing, or did their meaning change?
- Are there tests that now pass for the wrong reason (e.g., weaker assertion, different route)?
- Do new tests actually verify what they claim to verify?

### 5. Action Items
- List issues as Critical (must fix), Important (should fix), or Suggestion (nice to have)
- For each issue, cite the exact file and line number
```

Fix all Critical and Important issues before proceeding. Push back on the reviewer with reasoning if you disagree.

**1. File issues for remaining work**

```bash
bd create --title="Follow-up: ..." --type=task --priority=2
```

**2. Run quality gates** (if code changed)

```bash
npx.cmd playwright test          # E2E tests (or from worktree)
./node_modules/.bin/tsc.cmd --noEmit  # Type check
```

**3. Update beads**

```bash
bd close <id1> <id2> ... --reason="done"   # Close finished work
bd sync                                     # Flush to .beads/issues.jsonl
```

**4. Clean up resources**

- Stop background dev servers (port 3000/3001)
- Remove worktrees: `git worktree remove ../worktree-name --force`
- Verify removal: `git worktree list`
- Prune stale branches if merged

**5. Commit and push** (MANDATORY)

```bash
git add <files>                  # Stage changes (including .beads/issues.jsonl)
git commit -m "..."              # Commit
git pull --rebase                # Sync with remote
git push                         # Push — work is NOT done until this succeeds
git status                       # MUST show "up to date with origin"
```

**Critical rules:**

- NEVER stop before pushing — that leaves work stranded locally
- NEVER say "ready to push when you are" — YOU must push
- If push fails, resolve and retry until it succeeds
- If worktree was used, push BOTH the worktree branch AND the main branch
