// ============================================================
// Agent Teams Monitor — Types
// Verified against real data from Claude Code 2.1.34
// See SCHEMA-VERIFICATION.md for field-by-field documentation
// ============================================================

// --- Team Config (from ~/.claude/teams/{name}/config.json) ---

export interface TeamConfig {
  name: string;
  description: string;
  leadAgentId: string;       // format: "name@team-name"
  leadSessionId: string;     // UUID
  createdAt: number;         // milliseconds
  members: TeamMember[];
}

export interface TeamMember {
  agentId: string;           // format: "name@team-name"
  name: string;
  agentType: string;         // "team-lead", "general-purpose", etc.
  model: string;             // full ID on lead, alias on teammates
  joinedAt: number;
  tmuxPaneId: string;        // "" on lead, "in-process" on teammates
  cwd: string;
  subscriptions: unknown[];
  // Teammate-only fields:
  prompt?: string;
  color?: string;            // Color NAME: "blue", "green" (not hex)
  planModeRequired?: boolean;
  backendType?: 'in-process' | 'tmux' | 'iterm2';
}

// --- Tasks (from ~/.claude/tasks/{name}/{n}.json) ---

export interface AgentTask {
  id: string;                // String: "1", "2"
  subject: string;           // Agent name (not a task title)
  description: string;       // Truncated ~100 chars
  status: 'pending' | 'in_progress' | 'completed';
  blocks: string[];
  blockedBy: string[];
  metadata?: { _internal?: boolean };
}

// --- Inbox Messages (from ~/.claude/teams/{name}/inboxes/{agent}.json) ---
// Each file is a JSON array of InboxEntry[]

export interface InboxEntry {
  from: string;              // Agent name
  text: string;              // Plain text OR stringified JSON with "type" field
  summary?: string;          // Human-readable summary (not always present)
  timestamp: string;         // ISO 8601
  color?: string;            // Color name (on messages FROM teammates, absent from lead)
  read: boolean;
}

// Typed messages are stringified JSON inside the `text` field.
// Use parseTypedMessage() to extract them.

export interface PermissionRequest {
  type: 'permission_request';
  request_id: string;
  agent_id: string;
  tool_name: string;
  tool_use_id: string;
  description: string;
  input: Record<string, unknown>;
  permission_suggestions: unknown[];
}

export interface PermissionResponse {
  type: 'permission_response';
  request_id: string;
  approve: boolean;
}

export interface IdleNotification {
  type: 'idle_notification';
  from: string;
  timestamp: string;
  idleReason?: string;
}

export interface ShutdownRequest {
  type: 'shutdown_request';
  requestId: string;
  from: string;
  reason: string;
  timestamp: string;
}

export interface ShutdownApproved {
  type: 'shutdown_approved';
  requestId: string;
  from: string;
  timestamp: string;
  paneId: string;
  backendType: string;
}

export interface PlanApprovalRequest {
  type: 'plan_approval_request';
  from: string;
  requestId: string;
  planFilePath: string;
  planContent: string;
  timestamp: string;
}

export interface PlanApprovalResponse {
  type: 'plan_approval_response';
  requestId: string;
  approved: boolean;
  feedback?: string;
  timestamp: string;
  permissionMode?: string;
}

export type TypedMessage =
  | PermissionRequest
  | PermissionResponse
  | IdleNotification
  | ShutdownRequest
  | ShutdownApproved
  | PlanApprovalRequest
  | PlanApprovalResponse;

/**
 * Attempt to parse the `text` field of an InboxEntry as a typed message.
 * Returns the parsed typed message, or null if it's a plain text message.
 */
export function parseTypedMessage(text: string): TypedMessage | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
      return parsed as TypedMessage;
    }
  } catch {
    // Not JSON — it's a plain text message
  }
  return null;
}

// --- Session History (persisted to sessions.jsonl) ---

export interface SessionRecord {
  version: number;
  teamName: string;
  teamDescription: string;
  startedAt: string;
  endedAt: string;
  duration: string;
  lead: string;
  agents: { name: string; model: string; role: string }[];
  tasks: { title: string; status: string; owner: string }[];
  stats: {
    totalTasks: number;
    completedTasks: number;
    messageCount: number;
    broadcastCount: number;
    planApprovals: number;
  };
  outcome: string;
  notes: string;
  recordingPath: string;
  frameCount: number;
}

// --- Helpers ---

export function isTeamLead(member: TeamMember): boolean {
  return member.agentType === 'team-lead';
}


