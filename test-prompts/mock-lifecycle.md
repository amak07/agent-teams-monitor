# Mock Agent Team — Comprehensive Lifecycle Data Capture

## How to Run (Instructions for YOU, the human)

```
1. Terminal A:  npm.cmd run record -- --name mock-lifecycle
2. Terminal B:  claude                (start a Claude Code session)
3. Paste everything below the "---PASTE BELOW THIS LINE---" marker
4. IMPORTANT: When agents request tool permissions (Bash), APPROVE them at the CLI prompt
5. Wait for "Mock lifecycle complete" message
6. Recorder auto-stops when team files are cleaned up (or Ctrl+C)
```

**Expected cost:** ~$0.10-0.30 (3 haiku agents × 3-5 turns each, plus lead orchestration)
**Expected duration:** 3-8 minutes
**Expected frames:** 20-40+

---PASTE BELOW THIS LINE---

# Mock Agent Team — Lifecycle Orchestration

You are orchestrating a **MOCK** agent team. No real work is being done. The purpose is to generate realistic agent team file activity (config.json, task files, inbox messages) for testing a VS Code extension. A recorder is running in another terminal capturing JSON snapshots.

## Critical Rules

1. Use **haiku** model for ALL teammates — minimize token cost
2. All agent outputs are **fake/mocked** — short sentences, made-up numbers
3. **Do NOT skip or combine phases** — the recorder needs time to capture state changes between each step
4. Follow the phases IN ORDER. Wait for each phase to complete before moving to the next.
5. Always include a `summary` field when using SendMessage
6. This session exercises 22+ lifecycle events. Every phase matters.

## Phase 1: Create Team

Create a team named `mock-lifecycle` with description:
> "Mock 3-agent team for comprehensive lifecycle data capture. All results are simulated."

## Phase 2: Create Tasks with Dependencies

Create these 4 tasks. Set their initial status to "pending". Set up the dependency chain so blocked tasks have `blockedBy` populated:

| # | Title | Dependencies | Initial Owner |
|---|-------|-------------|---------------|
| 1 | "Analyze codebase structure" | None | (unassigned) |
| 2 | "Implement auth middleware" | Blocked by Task 1 | (unassigned) |
| 3 | "Write test suite" | Blocked by Task 2 | (unassigned) |
| 4 | "Update API documentation" | None | (unassigned) |

Verify with TaskList that tasks 2 and 3 show as blocked.

## Phase 3: Spawn 3 Agents

Spawn all 3 agents using the Task tool. Use `model: "haiku"` for ALL of them.

**IMPORTANT:** Spawn `agent-gamma` with `mode: "plan"` so it enters plan mode (requires plan approval before working).

---

### agent-alpha (researcher + docs)

```
You are a MOCK test agent generating fake data for a recording. Do NO real work.

ALLOWED TOOLS: SendMessage, TaskList, TaskUpdate only. Do not use Read, Grep, Glob, Bash, or any other tools.

STEPS — follow exactly:

1. Run TaskList to see available tasks.
2. Claim "Analyze codebase structure" using TaskUpdate — set status to in_progress and owner to your name.
3. Send team lead (via SendMessage, type "message"): "Starting codebase analysis. Scanning project structure and module boundaries." Include a summary.
4. Send team lead a second message with your mocked result: "Analysis complete. Found 23 source files across 4 modules: auth, api, models, utils. Entry point is src/index.ts. Architecture follows Express + TypeORM pattern. No circular dependencies detected." Include a summary.
5. Mark task completed using TaskUpdate (status: completed).
6. Run TaskList again. If "Update API documentation" is available and unassigned, claim it (in_progress, owner: your name).
7. Send team lead: "Picking up docs task. Reviewing existing API descriptions."
8. Send team lead: "Documentation updated. Added 3 new endpoint descriptions and 2 schema examples to openapi.yaml. Fixed 1 outdated response format."
9. Mark task 4 completed.
10. When any teammate sends you a DM, reply with a brief 1-sentence answer.
11. When you receive a shutdown request, approve it immediately.
```

---

### agent-beta (implementer)

```
You are a MOCK test agent generating fake data for a recording. Do NO real work.

ALLOWED TOOLS: SendMessage, TaskList, TaskUpdate, Bash. You MUST attempt one Bash command (this triggers a permission request for the recording).

STEPS — follow exactly:

1. Run TaskList. Note that "Implement auth middleware" is blocked by task 1.
2. Send team lead: "My implementation task is blocked by the research phase. Standing by." Include summary.
3. Go idle. WAIT for a message from team lead telling you your task is unblocked.
4. When you get that message: run TaskList, then claim "Implement auth middleware" (in_progress, owner: your name).
5. Send a peer DM to agent-alpha (via SendMessage type "message", recipient "agent-alpha"): "Quick question — did the analysis show JWT or session-based auth patterns?" Include summary.
6. Wait briefly for alpha's reply.
7. Run this Bash command: echo "mock: auth middleware compiled successfully"
   (This will trigger a permission request. The human operator will approve it.)
8. Send team lead your mocked result: "Implementation complete. Added JWT middleware in src/auth/middleware.ts, updated src/routes/api.ts and src/config/auth.ts. Changes: +67 lines, -4 lines across 3 files. Build verified." Include summary.
9. Mark task completed.
10. Check TaskList for any new tasks assigned to you. If you find one, claim it, send a brief mocked result, and mark it completed.
11. When you receive a shutdown request, approve it immediately.
```

---

### agent-gamma (tester) — PLAN MODE

```
You are a MOCK test agent generating fake data for a recording. Do NO real work.

You are in PLAN MODE. You must write a plan and get it approved before you can do real work.

PLAN MODE STEPS:
1. Write a brief plan to the plan file. The plan should say: "Test Plan: Will create unit tests for auth middleware (6 tests) and integration tests for API routes (2 tests). Will use Jest framework. Expected coverage target: 90%."
2. Call ExitPlanMode to submit your plan for approval.
3. You may receive a REJECTION with feedback. If so: update your plan to address the feedback, then call ExitPlanMode again.
4. Once approved, you exit plan mode and can proceed with the work steps below.

WORK STEPS (after plan is approved):
1. Run TaskList. Your task "Write test suite" may still be blocked. If so, send team lead: "Plan approved. Test task still blocked by implementation. Standing by." Then go idle and wait.
2. When you receive a message that your task is unblocked: claim it (in_progress, owner: your name).
3. Send team lead a progress update: "Writing tests for auth middleware module. Targeting 6 unit + 2 integration tests."
4. Send team lead your mocked result: "Test suite complete. Created 6 unit tests and 2 integration tests. All 8 passing. Auth module coverage: 91%. No regressions detected in existing suite."
5. Mark task completed.
6. When you receive a shutdown request, approve it immediately.

ALLOWED TOOLS (after plan approved): SendMessage, TaskList, TaskUpdate only.
```

## Phase 4: Broadcast Kickoff

Once all 3 agents are spawned, send a **broadcast** message (SendMessage type "broadcast") to all agents:

> "Project kickoff: all agents check the task list and begin working on any available (unblocked) tasks. This is a mock session — respond with simulated results only."

Include summary: "Project kickoff broadcast"

## Phase 5: Plan Approval Flow

Wait for agent-gamma to submit a plan (you'll receive a `plan_approval_request` message).

1. **REJECT the first plan** using SendMessage type "plan_approval_response" with `approve: false` and content: "Please add a section about error case coverage — we need tests for invalid tokens and expired sessions too."
2. Wait for gamma to revise and resubmit the plan.
3. **APPROVE the revised plan** using SendMessage type "plan_approval_response" with `approve: true`.

## Phase 6: Dependency Chain Orchestration

Monitor messages from agents. As tasks complete, manually nudge blocked agents:

1. **Wait** for agent-alpha to complete task 1 ("Analyze codebase structure").
2. When done, **message agent-beta**: "Research phase complete. Task 2 'Implement auth middleware' is now unblocked. Go ahead and claim it." Include summary.
3. **Wait** for agent-beta to complete task 2 ("Implement auth middleware").
4. When done, **message agent-gamma**: "Implementation is done. Task 3 'Write test suite' is now unblocked. Claim it and start your approved test plan." Include summary.
5. Agent-alpha should also be working on task 4 ("Update API documentation") in parallel. Let it finish.

## Phase 7: Dynamic Task Creation + Reassignment

After tasks 1 and 2 are completed but while agents are still working:

1. **Create a NEW task** (task 5): "Performance audit" — no dependencies. This demonstrates mid-session task creation.
2. **Assign task 5 to agent-alpha** using TaskUpdate (set owner to agent-alpha).
3. Wait a moment, then **REASSIGN task 5 to agent-beta** using TaskUpdate (change owner to agent-beta). This demonstrates task reassignment.
4. **Message agent-beta**: "New task assigned to you: Performance audit. Give a quick mocked result." Include summary.
5. Wait for agent-beta to complete it.

## Phase 8: Verify Completion

Run TaskList and verify all 5 tasks show status "completed". If any are still in progress, wait for the responsible agent to finish.

## Phase 9: Shutdown + Delete

Once ALL tasks are confirmed complete:

1. Send **shutdown_request** to agent-alpha. Wait for approval.
2. Send **shutdown_request** to agent-beta. Wait for approval.
3. Send **shutdown_request** to agent-gamma. Wait for approval.
4. After all 3 approvals, run **TeamDelete** to clean up the team.
5. Say: **"Mock lifecycle complete. All 22 lifecycle events captured across 9 phases."**
