/**
 * Shared types for session recording and replay.
 */

export interface Frame {
  timestamp: string;
  elapsed_ms: number;
  teams: Record<string, { config: unknown; inboxes: Record<string, unknown[]> }>;
  tasks: Record<string, Record<string, unknown>>;
}

export interface Manifest {
  name: string;
  startedAt: string;
  endedAt: string;
  frameCount: number;
  teamNames: string[];
}
