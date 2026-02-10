import { TeamConfig, AgentTask, InboxEntry } from '../../types';

/**
 * A single event in a simulation scenario.
 * Each event writes specific files to disk, then waits `delayAfterMs`
 * before the next event fires.
 */
export interface SimEvent {
  /** Human-readable label for console output */
  label: string;

  /** Delay in ms AFTER this event is applied before the next event fires.
   *  FileWatcher has 5s poll + 300ms debounce. Use 2000ms+ between events
   *  to ensure the watcher picks up each change as a distinct state. */
  delayAfterMs: number;

  /** Actions to perform for this event */
  actions: SimAction[];
}

export type SimAction =
  | { type: 'writeConfig'; teamName: string; config: TeamConfig }
  | { type: 'writeTask'; teamName: string; task: AgentTask }
  | { type: 'writeInbox'; teamName: string; agentName: string; entries: InboxEntry[] }
  | { type: 'appendInbox'; teamName: string; agentName: string; entry: InboxEntry }
  | { type: 'deleteTeam'; teamName: string };

/**
 * A complete simulation scenario.
 */
export interface Scenario {
  /** Unique name (used as CLI arg) */
  name: string;

  /** Human description */
  description: string;

  /** Team name(s) this scenario creates (for cleanup) */
  teamNames: string[];

  /** Ordered sequence of events */
  events: SimEvent[];
}
