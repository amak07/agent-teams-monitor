import * as crypto from 'crypto';
import { TeamConfig, TeamMember, AgentTask, InboxEntry } from '../../types';

const COLORS = ['blue', 'green', 'yellow', 'orange', 'purple', 'red'];

/** Generate a deterministic UUID from a seed string */
export function fakeUUID(seed: string): string {
  const hash = crypto.createHash('md5').update(seed).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

/** Build a TeamConfig with sensible defaults */
export function buildConfig(opts: {
  name: string;
  description?: string;
  cwd?: string;
  createdAt?: number;
  members: Array<{
    name: string;
    agentType?: string;
    model?: string;
    color?: string;
    prompt?: string;
    planModeRequired?: boolean;
    joinedAtOffset?: number; // ms after team creation
  }>;
}): TeamConfig {
  const createdAt = opts.createdAt ?? Date.now();
  const cwd = opts.cwd ?? process.cwd();

  return {
    name: opts.name,
    description: opts.description ?? `Simulated team: ${opts.name}`,
    leadAgentId: `team-lead@${opts.name}`,
    leadSessionId: fakeUUID(opts.name),
    createdAt,
    members: opts.members.map((m, i) => {
      const isLead = (m.agentType ?? (i === 0 ? 'team-lead' : 'general-purpose')) === 'team-lead';
      const member: TeamMember = {
        agentId: `${m.name}@${opts.name}`,
        name: m.name,
        agentType: m.agentType ?? (i === 0 ? 'team-lead' : 'general-purpose'),
        model: isLead ? 'claude-opus-4-6' : (m.model ?? 'sonnet'),
        joinedAt: createdAt + (m.joinedAtOffset ?? i * 2000),
        tmuxPaneId: isLead ? '' : 'in-process',
        cwd,
        subscriptions: [],
      };
      if (!isLead) {
        member.prompt = m.prompt ?? `Work on tasks for ${opts.name}`;
        member.color = m.color ?? COLORS[i % COLORS.length];
        member.planModeRequired = m.planModeRequired ?? false;
        member.backendType = 'in-process';
      }
      return member;
    }),
  };
}

/** Build an AgentTask */
export function buildTask(opts: {
  id: string;
  subject: string;
  description: string;
  status?: AgentTask['status'];
  blocks?: string[];
  blockedBy?: string[];
}): AgentTask {
  return {
    id: opts.id,
    subject: opts.subject,
    description: opts.description.slice(0, 100),
    status: opts.status ?? 'pending',
    blocks: opts.blocks ?? [],
    blockedBy: opts.blockedBy ?? [],
    metadata: { _internal: true },
  };
}

/** Build a plain text InboxEntry with a fresh timestamp */
export function buildMessage(opts: {
  from: string;
  text: string;
  summary?: string;
  color?: string;
  read?: boolean;
  timestampOffset?: number; // ms offset from "now"
}): InboxEntry {
  return {
    from: opts.from,
    text: opts.text,
    summary: opts.summary,
    timestamp: new Date(Date.now() + (opts.timestampOffset ?? 0)).toISOString(),
    color: opts.color,
    read: opts.read ?? false,
  };
}

/** Build a typed message (stringified JSON in text field) */
export function buildTypedMessage(opts: {
  from: string;
  typed: Record<string, unknown>;
  summary?: string;
  color?: string;
  read?: boolean;
  timestampOffset?: number;
}): InboxEntry {
  return {
    from: opts.from,
    text: JSON.stringify(opts.typed),
    summary: opts.summary,
    timestamp: new Date(Date.now() + (opts.timestampOffset ?? 0)).toISOString(),
    color: opts.color,
    read: opts.read ?? false,
  };
}
