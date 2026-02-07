# Agent Teams Schema Verification Guide

Use this process to verify the Agent Teams JSON schema whenever Claude Code is updated. Compare new output against `test-fixtures/` to detect breaking changes.

## Prerequisites

- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` must be `"1"` in `~/.claude/settings.json`
- Claude Code CLI installed and authenticated

## Step 1: Check Claude Code Version

```bash
claude --version
```

**Last verified version:** 2.1.34 (February 7, 2026)

## Step 2: Spawn a Test Team

```bash
claude -p "Create an agent team with 2 teammates to research the top 3 JavaScript testing frameworks. Have one research unit testing and the other integration testing."
```

This will:
- Create `~/.claude/teams/{team-name}/config.json`
- Create `~/.claude/teams/{team-name}/inboxes/*.json`
- Create `~/.claude/tasks/{team-name}/*.json`

## Step 3: Capture Files While Team is Running

**IMPORTANT:** Files are cleaned up automatically when the team finishes. You must capture them while the team is active, or immediately after teammates report results but before cleanup.

```bash
# Watch for file creation
ls -laR ~/.claude/teams/ ~/.claude/tasks/

# Copy files immediately
cp -r ~/.claude/teams/ ./test-fixtures/teams-new/
cp -r ~/.claude/tasks/ ./test-fixtures/tasks-new/
```

## Step 4: Compare Against Known Schema

Diff the new files against the reference fixtures:

```bash
diff <(jq --sort-keys . test-fixtures/teams/js-testing-research/config.json) \
     <(jq --sort-keys . test-fixtures/teams-new/{team-name}/config.json)
```

### Key fields to check for changes:

**config.json:**
- `leadSessionId` (added in 2.1.34)
- `members[].subscriptions` (added in 2.1.34)
- `members[].color` — is it still a name string (`"blue"`) or has it changed to hex?
- `members[].backendType` — still only on teammates, not lead?
- Any new fields on members?

**Task files ({n}.json):**
- `id` — still a string?
- `subject` — still the agent name?
- `metadata._internal` — still present?
- Any new status values beyond `pending`, `in_progress`, `completed`?
- Any new fields like `owner`, `activeForm`, `createdAt`, `updatedAt`?

**Inbox messages:**
- `summary` field — still present on messages from lead?
- `color` field — still present on messages from teammates?
- `text` field — still contains stringified JSON for typed messages?
- Any new message types beyond:
  - `permission_request`
  - `permission_response`
  - `idle_notification`
  - `shutdown_request`
  - `shutdown_approved`

## Step 5: Update Fixtures

If the schema has changed, update the reference fixtures:

```bash
cp -r test-fixtures/teams-new/ test-fixtures/teams/
cp -r test-fixtures/tasks-new/ test-fixtures/tasks/
```

Then update `src/types.ts` to match the new schema.

---

## Schema History

### v2.1.34 (February 7, 2026) — Initial capture

**config.json fields:**
| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Team name |
| `description` | string | Team description |
| `createdAt` | number | Milliseconds timestamp |
| `leadAgentId` | string | Format: `name@team-name` |
| `leadSessionId` | string | UUID of lead session |
| `members` | array | See member schema below |

**Member fields:**
| Field | Type | Present On | Notes |
|-------|------|-----------|-------|
| `agentId` | string | All | Format: `name@team-name` |
| `name` | string | All | Agent display name |
| `agentType` | string | All | `"team-lead"`, `"general-purpose"`, etc. |
| `model` | string | All | Full ID on lead, alias on teammates |
| `joinedAt` | number | All | Milliseconds timestamp |
| `tmuxPaneId` | string | All | `""` on lead, `"in-process"` on teammates |
| `cwd` | string | All | Working directory |
| `subscriptions` | array | All | Empty array observed |
| `prompt` | string | Teammates only | Spawn prompt |
| `color` | string | Teammates only | Color name: `"blue"`, `"green"`, etc. |
| `planModeRequired` | boolean | Teammates only | |
| `backendType` | string | Teammates only | `"in-process"`, `"tmux"`, `"iterm2"` |

**Task file fields:**
| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Numeric string: `"1"`, `"2"` |
| `subject` | string | Agent name, not task title |
| `description` | string | Truncated task description |
| `status` | string | `"pending"`, `"in_progress"`, `"completed"` |
| `blocks` | string[] | Task IDs this blocks |
| `blockedBy` | string[] | Task IDs blocking this |
| `metadata` | object | `{ "_internal": true }` observed |

**Inbox message envelope:**
| Field | Type | Notes |
|-------|------|-------|
| `from` | string | Agent name |
| `text` | string | Plain text OR stringified JSON |
| `summary` | string? | Human-readable summary (optional, not always present) |
| `timestamp` | string | ISO 8601 |
| `color` | string? | Color name (only on messages FROM teammates) |
| `read` | boolean | Whether message has been read |

**Typed message formats (embedded as JSON strings in `text` field):**

```
permission_request:  { type, request_id, agent_id, tool_name, tool_use_id, description, input, permission_suggestions }
permission_response: { type, request_id, approve }
idle_notification:   { type, from, timestamp, idleReason }
shutdown_request:    { type, requestId, from, reason, timestamp }
shutdown_approved:   { type, requestId, from, timestamp, paneId, backendType }
```

**Important behavioral notes:**
- Files are **ephemeral** — cleaned up automatically when lead runs cleanup
- Team lead has no `color` or `backendType`
- Inbox is a **JSON array** of messages, not individual files per message
- `.lock` file exists in tasks directory for concurrent access control
- `description` on tasks is truncated (appears to be ~100 chars)
