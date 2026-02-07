# AGENT TEAMS MONITOR

## VS Code Extension — Technical Plan & Build Guide

**Prepared for:** Abel
**Date:** February 7, 2026
**Version:** 1.0

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Market Opportunity & Competitive Landscape](#2-market-opportunity--competitive-landscape)
3. [Technical Architecture](#3-technical-architecture)
4. [Data Sources: What We Read & Watch](#4-data-sources-what-we-read--watch)
5. [File System Schema (The JSON Files)](#5-file-system-schema-the-json-files)
6. [VS Code Extension Structure](#6-vs-code-extension-structure)
7. [Core Implementation Plan](#7-core-implementation-plan)
8. [UX Design Specification](#8-ux-design-specification)
9. [MVP Feature Scope & Phased Roadmap](#9-mvp-feature-scope--phased-roadmap)
10. [Publishing to the VS Code Marketplace](#10-publishing-to-the-vs-code-marketplace)
11. [Launch & Growth Playbook](#11-launch--growth-playbook)
12. [Weekend Build Sprint Plan](#12-weekend-build-sprint-plan)

---

## 1. Executive Summary

Claude Code Agent Teams shipped on February 5, 2026 alongside Opus 4.6. This experimental feature lets a lead Claude Code session spawn multiple teammate instances that work in parallel, communicate through messages, and coordinate via a shared task list. Currently, the only way to visualize this is through tmux split panes, which are **not supported in VS Code's integrated terminal**.

This creates a clear gap: VS Code is the most popular editor, but Agent Teams users are forced to leave it and use tmux to see what their agents are doing. Our extension fills this gap by reading the structured JSON files that Agent Teams writes to disk and presenting them in a native VS Code sidebar panel.

**Why now:** Agent Teams is 2 days old. No VS Code extension exists for this. The Hacker News announcement threads generated 400+ comments. Developers are actively looking for solutions. First-mover advantage is real and available right now.

---

## 2. Market Opportunity & Competitive Landscape

No VS Code extension currently monitors Agent Teams. Here is the full competitive landscape:

| Tool | Type | What It Does | Gap |
|------|------|-------------|-----|
| Official Claude Code Extension | VS Code Extension | Single-session chat, diffs, permissions | No Agent Teams awareness |
| VS Code Agent Sessions | Built into VS Code | Manages Copilot/Claude/Codex sessions | Separate agents, not a coordinated team |
| Crystal (Stravu) | Desktop App (Electron) | Parallel CC sessions in git worktrees | Independent sessions, not Agent Teams |
| TmuxCC | Terminal TUI (Rust) | Monitors AI agents across tmux panes | Terminal-only, no VS Code integration |
| Claude Squad | Terminal TUI | Manages multiple agents in tmux | Terminal-only |
| Agent Deck | Terminal TUI (Go) | Session mgmt, forking, MCP mgmt | Terminal-only |
| Peky | Terminal TUI | Multi-project agent dashboard | Terminal-only |

**Key insight:** Every existing tool is either terminal-only (TUIs built on tmux) or manages independent sessions rather than a coordinated Agent Team. Our extension is the first to bring Agent Teams visibility into VS Code using the native JSON file system.

### Relevant Links

- TmuxCC: https://github.com/nyanko3141592/tmuxcc
- Crystal: https://github.com/stravu/crystal
- Claude Squad: https://github.com/smtg-ai/claude-squad
- Agent Deck: https://github.com/asheshgoplani/agent-deck
- Peky: https://github.com/regenrek/peky
- awesome-claude-code: https://github.com/hesreallyhim/awesome-claude-code
- Official Agent Teams docs: https://code.claude.com/docs/en/agent-teams
- Swarm Orchestration Skill (detailed schemas): https://gist.github.com/kieranklaassen/4f2aba89594a4aea4ad64d753984b2ea
- Hidden Swarm analysis: https://paddo.dev/blog/claude-code-hidden-swarm/

---

## 3. Technical Architecture

The extension uses a **read-only file watcher architecture**. It never sends commands to agents or modifies any files. It only observes.

### 3.1 Architecture Overview

```
┌────────────────────────────────────────────────┐
│  Claude Code Agent Teams (running in terminal)  │
│  Writes JSON files to ~/.claude/teams & tasks   │
└───────────────────────┬────────────────────────┘
                        │ (file system)
                        ▼
┌────────────────────────────────────────────────┐
│  File Watcher Service (chokidar)                │
│  Watches: ~/.claude/teams/**  ~/.claude/tasks/** │
└───────────────────────┬────────────────────────┘
                        │ (events)
                        ▼
┌────────────────────────────────────────────────┐
│  State Manager                                  │
│  Parses JSON → In-memory model → Diff events    │
└───────┬─────────────┬─────────────┬────────────┘
        │             │             │
        ▼             ▼             ▼
  [Sidebar Panel] [Status Bar] [Notifications]
```

### 3.2 Two Approaches (Hybrid Strategy)

**Primary (Approach B):** Watch the structured JSON files at `~/.claude/teams/` and `~/.claude/tasks/`. These are officially documented by Anthropic and contain team config, inter-agent messages (inboxes), and task states. This gives us clean, parsed data without any text scraping.

**Fallback (Approach A):** If the JSON files are not present (older CC version, different config), fall back to reading tmux pane contents via `tmux capture-pane`. This is fragile because it requires parsing raw terminal text, but it provides backwards compatibility.

**Recommendation:** Build Approach B first. It covers 95% of use cases. Only add Approach A if user demand requires it.

### 3.3 How Approach A Works (for reference)

tmux has a built-in command to read text from any pane:

```bash
# Read the last 50 lines of text from pane 1
tmux capture-pane -t mysession:0.1 -p -S -50
```

This returns raw terminal text that you'd parse with regex to guess agent status (e.g., checking for "wants to edit" → waiting for approval). This is what TmuxCC does. It's fragile because any wording changes in Claude Code's output break the parser.

---

## 4. Data Sources: What We Read & Watch

Agent Teams stores all state as JSON files on disk. Here are the exact paths and what they contain:

| Path | Contains | Updates When |
|------|----------|-------------|
| `~/.claude/teams/{name}/config.json` | Team metadata, member list with IDs, colors, models, agent types, working directories | Team created, member spawned or removed |
| `~/.claude/teams/{name}/inboxes/{agent}.json` | Messages sent TO that agent (from lead or other teammates) | Any agent sends a message |
| `~/.claude/tasks/{name}/{n}.json` | Individual task with status (pending/in_progress/completed), owner, dependencies | Task created, claimed, completed, or blocked |

**Environment variables available:** `CLAUDE_CODE_TEAM_NAME`, `CLAUDE_CODE_AGENT_ID`, `CLAUDE_CODE_AGENT_TYPE`. These can help identify active teams from within the extension.

**Internal tools (not callable externally, but good to know):** `Teammate` (spawnTeam, cleanup), `SendMessage` (message, broadcast, shutdown_request/response, plan_approval_response), `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet`.

---

## 5. File System Schema (The JSON Files)

### 5.1 Directory Structure

```
~/.claude/
├── teams/{team-name}/
│   ├── config.json              # Team metadata + member list
│   └── inboxes/
│       ├── team-lead.json       # Messages TO the leader
│       ├── worker-1.json        # Messages TO worker 1
│       └── worker-2.json        # Messages TO worker 2
│
└── tasks/{team-name}/
    ├── 1.json                   # Task #1
    ├── 2.json                   # Task #2
    └── 3.json                   # Task #3
```

### 5.2 config.json Schema

```json
{
  "name": "my-project",
  "description": "Working on feature X",
  "leadAgentId": "team-lead@my-project",
  "createdAt": 1706000000000,
  "members": [
    {
      "agentId": "team-lead@my-project",
      "name": "team-lead",
      "agentType": "team-lead",
      "color": "#4A90D9",
      "joinedAt": 1706000000000,
      "backendType": "in-process"
    },
    {
      "agentId": "worker-1@my-project",
      "name": "worker-1",
      "agentType": "Explore",
      "model": "haiku",
      "prompt": "Analyze the codebase structure...",
      "color": "#D94A4A",
      "planModeRequired": false,
      "joinedAt": 1706000001000,
      "tmuxPaneId": "in-process",
      "cwd": "/Users/me/project",
      "backendType": "in-process"
    }
  ]
}
```

### 5.3 Task JSON Schema (inferred)

Each task file (e.g., `1.json`) contains a single task object with three possible states: `pending`, `in_progress`, and `completed`. Tasks can have dependencies on other tasks (blocked until dependencies complete). Tasks can be assigned to a specific agent or left unassigned for self-claiming.

### 5.4 Inbox JSON Schema

Each agent's inbox file contains messages delivered to that agent. You can inspect them with:

```bash
cat ~/.claude/teams/{team}/inboxes/team-lead.json | jq '.'
```

---

## 6. VS Code Extension Structure

### 6.1 Project Layout

```
agent-teams-monitor/
├── package.json              # Extension manifest + keywords
├── tsconfig.json             # TypeScript config
├── src/
│   ├── extension.ts          # Entry point (activate/deactivate)
│   ├── watchers/
│   │   ├── teamWatcher.ts    # Watches ~/.claude/teams/
│   │   └── taskWatcher.ts    # Watches ~/.claude/tasks/
│   ├── state/
│   │   ├── teamState.ts      # In-memory team model
│   │   └── types.ts          # TypeScript interfaces
│   ├── views/
│   │   ├── agentTreeProvider.ts   # Tree view for agents
│   │   ├── taskTreeProvider.ts    # Tree view for tasks
│   │   └── messageWebview.ts      # Webview for message feed
│   ├── statusBar/
│   │   └── statusBarItem.ts  # Bottom bar indicator
│   └── notifications/
│       └── notifier.ts       # Toast notifications
├── resources/
│   ├── icon.png              # Extension icon (128x128)
│   └── icons/                # Agent status icons (SVG)
├── README.md                 # Marketplace page content
├── CHANGELOG.md
└── .vscodeignore
```

### 6.2 Key package.json Fields

```json
{
  "name": "agent-teams-monitor",
  "displayName": "Agent Teams Monitor",
  "description": "Monitor Claude Code Agent Teams in VS Code — see agents, tasks, and messages without tmux",
  "version": "0.1.0",
  "publisher": "your-publisher-id",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Other", "Visualization"],
  "keywords": [
    "claude", "claude-code", "agent-teams",
    "ai-agents", "anthropic", "tmux",
    "multi-agent", "swarm", "opus"
  ],
  "activationEvents": ["onStartupFinished"],
  "contributes": {
    "viewsContainers": {
      "activitybar": [{
        "id": "agent-teams",
        "title": "Agent Teams",
        "icon": "resources/icon.svg"
      }]
    },
    "views": {
      "agent-teams": [
        { "id": "agentTeams.agents", "name": "Agents" },
        { "id": "agentTeams.tasks", "name": "Tasks" },
        { "id": "agentTeams.messages", "name": "Messages" }
      ]
    }
  }
}
```

### 6.3 TypeScript Interfaces

```typescript
interface TeamConfig {
  name: string;
  description: string;
  leadAgentId: string;
  createdAt: number;
  members: TeamMember[];
}

interface TeamMember {
  agentId: string;
  name: string;
  agentType: string;
  color: string;
  model?: string;
  prompt?: string;
  planModeRequired?: boolean;
  joinedAt: number;
  tmuxPaneId?: string;
  cwd?: string;
  backendType: 'in-process' | 'tmux' | 'iterm2';
}

interface AgentTask {
  id: number;
  title: string;
  status: 'pending' | 'in_progress' | 'completed';
  owner?: string;
  dependsOn?: number[];
}

interface AgentMessage {
  from: string;
  to: string;
  content: string;
  timestamp: number;
}
```

---

## 7. Core Implementation Plan

### 7.1 File Watcher Service

Use the `chokidar` library (or VS Code's built-in `FileSystemWatcher`) to watch the `~/.claude/teams/` and `~/.claude/tasks/` directories for changes. When a file changes, read it, parse the JSON, diff against in-memory state, and emit events to update the UI.

```typescript
import * as chokidar from 'chokidar';
import * as os from 'os';
import * as path from 'path';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const TEAMS_DIR = path.join(CLAUDE_DIR, 'teams');
const TASKS_DIR = path.join(CLAUDE_DIR, 'tasks');

const watcher = chokidar.watch([TEAMS_DIR, TASKS_DIR], {
  persistent: true,
  ignoreInitial: false,
  awaitWriteFinish: { stabilityThreshold: 300 }
});

watcher.on('change', (filePath) => {
  if (filePath.endsWith('config.json')) {
    handleTeamConfigChange(filePath);
  } else if (filePath.includes('/inboxes/')) {
    handleMessageChange(filePath);
  } else if (filePath.match(/tasks\/.*\/\d+\.json/)) {
    handleTaskChange(filePath);
  }
});
```

### 7.2 State Manager

The state manager holds the in-memory representation of all active teams, their members, tasks, and recent messages. It exposes an EventEmitter so UI components can subscribe to changes.

```typescript
class TeamStateManager extends EventEmitter {
  private teams: Map<string, TeamConfig> = new Map();
  private tasks: Map<string, AgentTask[]> = new Map();
  private messages: Map<string, AgentMessage[]> = new Map();

  updateTeam(name: string, config: TeamConfig) {
    this.teams.set(name, config);
    this.emit('teamUpdated', name);
  }

  updateTask(teamName: string, task: AgentTask) {
    // merge into tasks map, emit event
    this.emit('taskUpdated', { teamName, task });
  }

  addMessage(teamName: string, msg: AgentMessage) {
    // append to messages, keep last 100
    this.emit('messageReceived', { teamName, msg });
  }
}
```

### 7.3 Tree View Providers

VS Code Tree Views are the standard pattern for sidebar content. Each provider implements the `TreeDataProvider` interface and refreshes when the state manager emits events.

```typescript
class AgentTreeProvider implements vscode.TreeDataProvider<AgentTreeItem> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private state: TeamStateManager) {
    state.on('teamUpdated', () => this._onDidChange.fire());
  }

  getTreeItem(el: AgentTreeItem): vscode.TreeItem { return el; }

  getChildren(el?: AgentTreeItem): AgentTreeItem[] {
    if (!el) {
      // Root level: list all teams
      return [...this.state.teams.values()].map(
        t => new AgentTreeItem(t.name, 'team')
      );
    }
    // Children: list agents in that team
    const team = this.state.teams.get(el.label);
    return team.members.map(
      m => new AgentTreeItem(m.name, 'agent', m.color)
    );
  }
}
```

### 7.4 Status Bar Item

A small indicator in VS Code's bottom status bar. Shows active agent count and remaining tasks. Clicking it opens the sidebar.

```typescript
const statusBar = vscode.window.createStatusBarItem(
  vscode.StatusBarAlignment.Right, 100
);
statusBar.text = '$(hubot) 3 agents · 2 tasks left';
statusBar.tooltip = 'Click to open Agent Teams Monitor';
statusBar.command = 'agentTeams.focus';
statusBar.show();
```

### 7.5 Notification System

Show VS Code toast notifications for key events: new messages, task completions, and agent status changes. Keep notifications non-intrusive by batching rapid-fire updates.

```typescript
state.on('messageReceived', ({ teamName, msg }) => {
  vscode.window.showInformationMessage(
    `[${teamName}] ${msg.from} → ${msg.to}: ${msg.content.slice(0, 80)}`
  );
});

state.on('taskUpdated', ({ teamName, task }) => {
  if (task.status === 'completed') {
    vscode.window.showInformationMessage(
      `[${teamName}] Task #${task.id} completed: ${task.title}`
    );
  }
});
```

---

## 8. UX Design Specification

### 8.1 Layout: Activity Bar + Sidebar

The extension registers an icon in VS Code's Activity Bar (left rail), just like the Explorer, Git, Docker, or Testing icons. Clicking it opens a sidebar with three collapsible sections: Agents, Tasks, and Messages.

```
┌──────────────────────────────────────────────┐
│ [Explorer] [Git] [🤖 Agent Teams] [Extensions]│
│                                               │
│  🤖 AGENT TEAMS                    ⟳ 🔔      │
│  ─────────────────────────────────────        │
│                                               │
│  ▼ Team: payment-refactor                     │
│    Status: Active · 3 agents · 12min          │
│                                               │
│    ┌─────────────────────────────────┐        │
│    │ 👑 team-lead        ● Active    │        │
│    │    Coordinating tasks           │        │
│    ├─────────────────────────────────┤        │
│    │ 🔵 api-worker       ● Working   │        │
│    │    Task #2: API endpoints       │        │
│    ├─────────────────────────────────┤        │
│    │ 🔴 db-worker        ◐ Waiting   │        │
│    │    Task #3: Blocked by #2       │        │
│    └─────────────────────────────────┘        │
│                                               │
│  ▼ TASKS                                      │
│    ✅ #1 Research auth patterns                │
│    🔄 #2 Implement API layer (api-worker)     │
│    ⏳ #3 DB migrations (blocked by #2)        │
│    ○  #4 Write tests (unassigned)             │
│                                               │
│  ▼ MESSAGES                          [filter] │
│    ┌─────────────────────────────────┐        │
│    │ 10:42 api-worker → team-lead    │        │
│    │ "Found a conflict in the        │        │
│    │  user schema, need to discuss"  │        │
│    ├─────────────────────────────────┤        │
│    │ 10:43 team-lead → db-worker     │        │
│    │ "Hold off on migrations until   │        │
│    │  api-worker resolves schema"    │        │
│    └─────────────────────────────────┘        │
└──────────────────────────────────────────────┘
```

### 8.2 Agents Section

A Tree View showing each active team as a root node. Expanding a team reveals its members. Each agent shows: name, role/agentType, color dot matching the config color, and current status (Active, Working, Waiting, Idle). The team lead gets a crown icon.

### 8.3 Tasks Section

A flat list of all tasks for the active team, with visual status indicators:
- ✅ Completed tasks — green checkmark
- 🔄 In-progress tasks — blue indicator with assigned agent's name
- ⏳ Blocked tasks — lock icon with blocking task number
- ○ Pending/unassigned tasks — grayed out empty circle

### 8.4 Messages Section

A reverse-chronological feed of inter-agent messages. Each message shows timestamp, sender, recipient, and content preview. Clicking a message expands to show the full text. A filter dropdown lets you filter by agent.

### 8.5 Status Bar

A compact indicator at the bottom of VS Code: `$(hubot) 3 agents · 2 tasks left`. Clicking it focuses the sidebar.

### 8.6 Notifications

Toast notifications for high-signal events only: agent completes a task, agent sends a message to the lead, new teammate spawned. Debounce rapid messages (max 1 notification per 5 seconds per agent).

### 8.7 Design Principles (from proven patterns)

- **Tree Views** — same pattern as VS Code Testing, Docker, Git sidebar. Users know how to interact with collapsible trees.
- **Color-coded status dots** — proven by TmuxCC and Agent Deck: green = active, blue = working, yellow = waiting, gray = idle.
- **Kanban-style task states** — same as Jira, Linear, Crystal: pending → in_progress → completed with visual icons.
- **Reverse-chronological message feed** — same pattern as Slack, Discord, VS Code Output panel.
- **Read-only to start** — do not attempt to send commands to agents in v1. Observation only.

---

## 9. MVP Feature Scope & Phased Roadmap

### 9.1 MVP (Weekend Build — Ship by Monday)

The MVP should be the smallest useful version. Everything below is required to ship v0.1.0:

1. Activity Bar icon and sidebar container with 3 sections
2. File watcher on `~/.claude/teams/` and `~/.claude/tasks/`
3. Agent Tree View showing team members with names, colors, and agent types
4. Task Tree View showing task IDs, titles, and status icons
5. Message list (even if basic) showing recent inbox entries
6. Status Bar item showing agent count and task count
7. Auto-refresh when JSON files change

### 9.2 v0.2.0 (Week 2)

- Toast notifications for task completions and new messages
- Click-to-expand on messages to see full content
- Filter messages by agent
- Empty state UI when no Agent Teams are running
- Settings: notification preferences, polling interval

### 9.3 v0.3.0 (Week 3-4)

- Task dependency visualization (show which tasks block others)
- Agent timeline: when each agent started, how long they've been working
- Token usage estimates (if CC exposes this data)
- Click-to-focus tmux pane (for users running tmux alongside VS Code)
- Webview panel alternative for a richer Messages UI

### 9.4 Future (v1.0+)

- Send messages to agents from VS Code (write to inbox files)
- Start/stop Agent Teams from within VS Code
- Historical session logs and replay
- Multi-team support (monitor multiple concurrent teams)
- Integration with Claude Code VS Code extension

---

## 10. Publishing to the VS Code Marketplace

### 10.1 One-Time Setup (~15 minutes)

1. **Install the CLI tool:** `npm install -g @vscode/vsce`
2. **Create an Azure DevOps account:** Go to dev.azure.com and sign in with your Microsoft or GitHub account. If you don't have an organization, create one.
3. **Create a Personal Access Token (PAT):** In Azure DevOps, go to User Settings → Personal Access Tokens → New Token. Set scope to "Marketplace: Manage". Copy the token immediately (it's shown only once).
4. **Create a publisher:** Go to marketplace.visualstudio.com/manage. Click "Create publisher". The only required fields are Name and ID. Use a memorable ID like "abel-dev" or your brand name.
5. **Login via CLI:** Run `vsce login your-publisher-id` and paste your PAT when prompted.

### 10.2 Publishing (1 minute each time)

```bash
# Package and test locally first
vsce package
# Creates agent-teams-monitor-0.1.0.vsix
# Install in VS Code: Extensions → ... → Install from VSIX

# Publish to marketplace
vsce publish

# Or publish with version bump
vsce publish patch   # 0.1.0 → 0.1.1
vsce publish minor   # 0.1.0 → 0.2.0
vsce publish major   # 0.1.0 → 1.0.0
```

### 10.3 Marketplace Optimization

- `README.md` is your marketing page. Include a hero GIF, feature list, and installation instructions.
- Add a 128x128 icon (`resources/icon.png`) referenced in `package.json`.
- Include a `CHANGELOG.md` showing version history.
- Add a `repository` field pointing to your GitHub repo.
- Set `galleryBanner` in `package.json` for a colored banner on your listing.

### 10.4 Also Publish to Open VSX

Open VSX is important for VS Code forks like Cursor, VSCodium, and Gitpod. Install the ovsx CLI (`npm install -g ovsx`), create a namespace at open-vsx.org, and publish your `.vsix` file there as well.

### 10.5 Automate with GitHub Actions

```yaml
name: Publish Extension
on:
  release:
    types: [created]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run compile
      - name: Publish to VS Marketplace
        uses: HaaLeo/publish-vscode-extension@v2
        with:
          pat: ${{ secrets.VS_MARKETPLACE_TOKEN }}
          registryUrl: https://marketplace.visualstudio.com
      - name: Publish to Open VSX
        uses: HaaLeo/publish-vscode-extension@v2
        with:
          pat: ${{ secrets.OPEN_VSX_TOKEN }}
```

---

## 11. Launch & Growth Playbook

**The #1 rule:** Timing is everything, and your timing is perfect. Agent Teams shipped 2 days ago. No extension exists. The HN threads had 400+ comments. People are actively looking for this solution right now.

### 11.1 Pre-Launch: Build in Public (This Weekend)

- **Twitter/X thread:** Post progress screenshots as you build. "I'm building a VS Code extension to monitor Claude Code Agent Teams. No more tmux required. 🧵" Tag @AnthropicAI and @code.
- **Record a demo GIF:** Use Kap, LICEcap, or Loom. Show Agent Teams running and your sidebar updating in real-time. This single asset will be used everywhere: README, marketplace, social media, Reddit, HN.

### 11.2 Launch Day (Ship Monday/Tuesday)

Hit all channels on the same day for maximum impact:

1. **Hacker News:** Post as "Show HN: VS Code extension to monitor Claude Code Agent Teams in your sidebar". HN loves dev tools. The Agent Teams announcement already had massive engagement.
2. **Reddit:** Post to r/vscode (~330k members), r/ClaudeAI (~200k+), r/programming, r/webdev, and r/cursor. Each subreddit gets a slightly different angle.
3. **Dev.to:** Write a "How I built a VS Code extension for Agent Teams in a weekend" article. Dev.to posts get indexed by Google quickly and appear in listicle-style search results.
4. **awesome-claude-code:** Submit a PR to github.com/hesreallyhim/awesome-claude-code. This is the canonical list of Claude Code tools and gets heavy traffic.

### 11.3 Week 2: Community Seeding

- **YouTube:** Record a 3-5 minute demo video titled "How to Monitor Agent Teams in VS Code". This will get organic search traffic as Agent Teams adoption grows.
- **Claude Code Discord/communities:** Share your extension in active Claude Code communities.
- **Ask early adopters for reviews:** Even 5-10 five-star reviews early on dramatically boost marketplace search rankings.

### 11.4 Ongoing Growth

- **Marketplace SEO:** Keywords in `package.json` drive search ranking. Include: claude, claude-code, agent-teams, ai-agents, anthropic, tmux, multi-agent, swarm, opus. The extension name itself should be searchable.
- **Ship updates regularly:** Each new version triggers a notification to existing users and shows activity on your marketplace page. Weekly patches show the extension is actively maintained.
- **GitHub stars:** Stars serve as social proof. Ask people to star the repo. Pin the repo on your GitHub profile.
- **Respond to issues fast:** Fast issue responses build trust and encourage contributions. The Claude Code community is very active right now.
- **Open source everything:** Every popular Claude Code tool (Crystal, Claude Squad, TmuxCC, Agent Deck) is open source. The community contributes, files issues, and spreads the word.

### 11.5 What Makes Extensions Go Viral

Based on analysis of successful extensions in this space, five factors consistently drive adoption:

1. **Solve a real, current pain point:** Not theoretical. People are frustrated right now that Agent Teams doesn't work in VS Code's terminal. You are building the fix.
2. **Great visual first impression:** A single screenshot or GIF that makes someone go "I need that." Crystal's success was driven by clean UI screenshots.
3. **Open source on GitHub:** Community contributions, issue tracking, and GitHub stars as social proof.
4. **Ride the wave:** Crystal launched when multi-session CC was new. TmuxCC launched as Agent Teams hype built. You are launching while Agent Teams is literally the hottest topic in Claude Code.
5. **Low friction:** One-click install from marketplace. Zero config needed. It should just work when Agent Teams is running.

---

## 12. Weekend Build Sprint Plan

### Saturday Morning (3-4 hours): Foundation

1. Scaffold extension with `yo code` (TypeScript template)
2. Set up `package.json` with contributes (activity bar, views, commands)
3. Define TypeScript interfaces (`TeamConfig`, `TeamMember`, `AgentTask`, `AgentMessage`)
4. Implement file watcher service (chokidar watching `~/.claude/teams` and `tasks`)
5. Build `TeamStateManager` class (in-memory model, EventEmitter)
6. Test: create mock JSON files in `~/.claude/teams/test/` and verify watcher fires

### Saturday Afternoon (3-4 hours): UI

1. Build `AgentTreeProvider` (tree view for sidebar)
2. Build `TaskTreeProvider` (task list with status icons)
3. Add status bar item with agent count and task count
4. Wire everything together in `extension.ts` (activate/deactivate)
5. Test with F5 (Extension Development Host) using mock data

### Sunday Morning (2-3 hours): Messages + Polish

1. Build basic message list (Tree View or Webview for inbox entries)
2. Add notification system for task completions
3. Create empty-state UI ("No Agent Teams detected")
4. Add extension icon (128x128 PNG/SVG)

### Sunday Afternoon (2-3 hours): Ship It

1. Write `README.md` with hero GIF, feature list, install instructions
2. Record 30-second demo GIF (Kap, LICEcap, or Loom)
3. Create Azure DevOps PAT and marketplace publisher account
4. Run `vsce package` and test the `.vsix` locally
5. Run `vsce publish` to publish v0.1.0
6. Push source to GitHub (public repo, MIT license)
7. Draft launch posts for HN, Reddit, Dev.to, Twitter

### Monday: Launch

1. Submit "Show HN" post
2. Post to r/vscode, r/ClaudeAI, r/programming
3. Publish Dev.to article
4. Tweet the announcement thread, tag @AnthropicAI and @code
5. Submit PR to awesome-claude-code list
6. Celebrate. You shipped. 🚀

---

## Pre-Launch Checklist

- [ ] Great README with GIF demo
- [ ] Keywords optimized in package.json
- [ ] GitHub repo is public and clean
- [ ] 30-second demo video/GIF ready
- [ ] HN "Show HN" post drafted
- [ ] Reddit posts drafted for r/vscode, r/ClaudeAI
- [ ] Dev.to article drafted
- [ ] PR ready for awesome-claude-code list
- [ ] Tweet thread drafted, tag @AnthropicAI

---

*Good luck this weekend, Abel. You have the technical plan, the data sources, the UX spec, the publishing steps, and the marketing playbook. The window is open right now. Go build it.*
