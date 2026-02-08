# Agent Teams Monitor

VS Code extension that monitors Claude Code Agent Teams by reading JSON files from `~/.claude/teams/` and `~/.claude/tasks/`. Read-only observation — never writes to CC's files (except replay, which writes temporary frames).

## Build & Test

```bash
npm.cmd run compile      # TypeScript compilation
npm.cmd run package      # Build VSIX (runs compile first)
npm.cmd run watch        # Watch mode for development
npm.cmd run record       # Record a live agent team session
npm.cmd run replay       # CLI replay of a recording
```

Install after packaging:
```bash
"/c/Users/abelm/AppData/Local/Programs/Microsoft VS Code/bin/code" --install-extension agent-teams-monitor-0.1.0.vsix --force
```

No test framework yet. Verify changes by: compile, package, install, reload VS Code, run a replay.

## Architecture

- **`src/types.ts`** — All interfaces. Verified against real CC data (see SCHEMA-VERIFICATION.md)
- **`src/watchers/fileWatcher.ts`** — Watches `~/.claude/teams/` and `~/.claude/tasks/` with fs.watch + polling
- **`src/state/teamState.ts`** — Central state store. Members are merge-on-update (CC removes agents from config at shutdown, we persist them)
- **`src/views/dashboardPanel.ts`** — Main webview. Uses incremental DOM patching via postMessage (initial HTML render + subsequent `updateData` messages). All CSS is inline. All JS is inside a template literal — **backticks must be escaped as `\x60` in webview JS code**
- **`src/views/agent|task|messageTreeProvider.ts`** — Sidebar tree views
- **`src/replay/`** — In-extension replay system (writes frames to disk, file watcher picks them up)
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
