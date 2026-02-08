import * as vscode from 'vscode';
import * as path from 'path';
import { TeamConfig, AgentTask, InboxEntry, parseTypedMessage, isTeamLead } from '../types';

type TeamStateEvent =
  | { type: 'teamAdded'; teamName: string }
  | { type: 'teamUpdated'; teamName: string }
  | { type: 'teamRemoved'; teamName: string }
  | { type: 'taskUpdated'; teamName: string; task: AgentTask }
  | { type: 'messageReceived'; teamName: string; agentName: string };

export class TeamStateManager {
  private teams = new Map<string, TeamConfig>();
  private tasks = new Map<string, AgentTask[]>();
  private messages = new Map<string, Map<string, InboxEntry[]>>(); // teamName -> agentName -> entries

  private workspacePaths: string[] = [];
  private showAll = false;
  replayMode = false;

  private _onDidChange = new vscode.EventEmitter<TeamStateEvent>();
  readonly onDidChange = this._onDidChange.event;

  // --- Teams ---

  updateTeam(name: string, config: TeamConfig): void {
    const existing = this.teams.get(name);
    if (existing) {
      // Merge: keep previously seen members that CC removed from config at shutdown
      const knownMembers = new Map(existing.members.map(m => [m.name, m]));
      for (const m of config.members) {
        knownMembers.set(m.name, m); // Update existing or add new
      }
      config = { ...config, members: [...knownMembers.values()] };
    }
    this.teams.set(name, config);
    this._onDidChange.fire({ type: existing ? 'teamUpdated' : 'teamAdded', teamName: name });
  }

  removeTeam(name: string): void {
    this.teams.delete(name);
    this.tasks.delete(name);
    this.messages.delete(name);
    this._onDidChange.fire({ type: 'teamRemoved', teamName: name });
  }

  getTeam(name: string): TeamConfig | undefined {
    return this.teams.get(name);
  }

  getAllTeams(): TeamConfig[] {
    return [...this.teams.values()];
  }

  getTeamNames(): string[] {
    return [...this.teams.keys()];
  }

  hasTeams(): boolean {
    return this.teams.size > 0;
  }

  // --- Tasks ---

  updateTasks(teamName: string, taskList: AgentTask[]): void {
    this.tasks.set(teamName, taskList);
    for (const task of taskList) {
      this._onDidChange.fire({ type: 'taskUpdated', teamName, task });
    }
  }

  updateTask(teamName: string, task: AgentTask): void {
    const existing = this.tasks.get(teamName) ?? [];
    const idx = existing.findIndex(t => t.id === task.id);
    if (idx >= 0) {
      existing[idx] = task;
    } else {
      existing.push(task);
    }
    this.tasks.set(teamName, existing);
    this._onDidChange.fire({ type: 'taskUpdated', teamName, task });
  }

  getTasks(teamName: string): AgentTask[] {
    return this.tasks.get(teamName) ?? [];
  }

  getAllTasks(): Map<string, AgentTask[]> {
    return this.tasks;
  }

  // --- Messages ---

  setMessages(teamName: string, agentName: string, entries: InboxEntry[]): void {
    if (!this.messages.has(teamName)) {
      this.messages.set(teamName, new Map());
    }
    this.messages.get(teamName)!.set(agentName, entries);
    this._onDidChange.fire({ type: 'messageReceived', teamName, agentName });
  }

  getMessages(teamName: string, agentName?: string): InboxEntry[] {
    const teamMsgs = this.messages.get(teamName);
    if (!teamMsgs) { return []; }

    if (agentName) {
      return teamMsgs.get(agentName) ?? [];
    }

    // Return all messages across all inboxes, sorted by timestamp
    const all: InboxEntry[] = [];
    for (const entries of teamMsgs.values()) {
      all.push(...entries);
    }
    return all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  getAllMessages(): Map<string, Map<string, InboxEntry[]>> {
    return this.messages;
  }

  // --- Workspace Filtering ---

  setWorkspacePaths(paths: string[]): void {
    this.workspacePaths = paths.map(p => path.resolve(p).toLowerCase());
  }

  setShowAll(enabled: boolean): void {
    this.showAll = enabled;
    vscode.commands.executeCommand('setContext', 'agentTeams.showingAll', enabled);
    // Fire a generic event so all views refresh
    this._onDidChange.fire({ type: 'teamUpdated', teamName: '' });
  }

  private teamMatchesWorkspace(config: TeamConfig): boolean {
    if (this.showAll || this.workspacePaths.length === 0) { return true; }
    return config.members.some(m => {
      const memberCwd = path.resolve(m.cwd).toLowerCase();
      return this.workspacePaths.some(wp => memberCwd.startsWith(wp));
    });
  }

  private matchingTeamNames(): Set<string> {
    const names = new Set<string>();
    for (const [name, config] of this.teams) {
      if (this.teamMatchesWorkspace(config)) {
        names.add(name);
      }
    }
    return names;
  }

  getFilteredTeams(): TeamConfig[] {
    return this.getAllTeams().filter(t => this.teamMatchesWorkspace(t));
  }

  getFilteredTeamNames(): string[] {
    return [...this.matchingTeamNames()];
  }

  getFilteredTasks(): Map<string, AgentTask[]> {
    const filtered = new Map<string, AgentTask[]>();
    const names = this.matchingTeamNames();
    for (const [teamName, tasks] of this.tasks) {
      if (names.has(teamName)) {
        filtered.set(teamName, tasks);
      }
    }
    return filtered;
  }

  getFilteredMessages(): Map<string, Map<string, InboxEntry[]>> {
    const filtered = new Map<string, Map<string, InboxEntry[]>>();
    const names = this.matchingTeamNames();
    for (const [teamName, agentMsgs] of this.messages) {
      if (names.has(teamName)) {
        filtered.set(teamName, agentMsgs);
      }
    }
    return filtered;
  }

  // --- Derived Status ---

  /** Returns set of agent names that have shutdown_approved messages in team-lead's inbox */
  getShutdownAgents(teamName: string): Set<string> {
    const result = new Set<string>();
    const leadMsgs = this.messages.get(teamName)?.get('team-lead');
    if (!leadMsgs) { return result; }
    for (const entry of leadMsgs) {
      const typed = parseTypedMessage(entry.text);
      if (typed && typed.type === 'shutdown_approved') {
        result.add(entry.from);
      }
    }
    return result;
  }

  /** Returns effective task status considering agent shutdown messages */
  getEffectiveTaskStatus(teamName: string, task: AgentTask): AgentTask['status'] {
    if (task.status === 'completed') { return 'completed'; }
    if (task.status === 'in_progress') {
      const shutdown = this.getShutdownAgents(teamName);
      if (shutdown.has(task.subject)) { return 'completed'; }
    }
    return task.status;
  }

  /** Returns lifecycle state for a specific agent */
  getAgentLifecycleState(teamName: string, agentName: string): 'active' | 'idle' | 'shutting_down' | 'shutdown' {
    // 1. Check shutdown_approved in team-lead's inbox from this agent
    const leadMsgs = this.messages.get(teamName)?.get('team-lead') ?? [];
    for (const entry of leadMsgs) {
      const typed = parseTypedMessage(entry.text);
      if (typed && typed.type === 'shutdown_approved' && entry.from === agentName) {
        return 'shutdown';
      }
    }

    // 2. Check shutdown_request in agent's own inbox (lead sent shutdown request TO the agent)
    const agentMsgs = this.messages.get(teamName)?.get(agentName) ?? [];
    for (const entry of agentMsgs) {
      const typed = parseTypedMessage(entry.text);
      if (typed && typed.type === 'shutdown_request') {
        return 'shutting_down';
      }
    }

    // 3. Check if most recent message FROM this agent is idle_notification
    const allTeamMsgs = this.messages.get(teamName);
    if (allTeamMsgs) {
      let latest: { timestamp: string; isIdle: boolean } | null = null;
      for (const [, entries] of allTeamMsgs) {
        for (const entry of entries) {
          if (entry.from === agentName) {
            if (!latest || entry.timestamp > latest.timestamp) {
              const typed = parseTypedMessage(entry.text);
              latest = { timestamp: entry.timestamp, isIdle: typed?.type === 'idle_notification' };
            }
          }
        }
      }
      if (latest?.isIdle) { return 'idle'; }
    }

    return 'active';
  }

  /** Returns lifecycle states for all members in a team */
  getAgentLifecycleStates(teamName: string): Map<string, 'active' | 'idle' | 'shutting_down' | 'shutdown'> {
    const team = this.teams.get(teamName);
    const result = new Map<string, 'active' | 'idle' | 'shutting_down' | 'shutdown'>();
    if (!team) { return result; }
    for (const member of team.members) {
      if (isTeamLead(member)) {
        result.set(member.name, 'active'); // Lead is always "active"
      } else {
        result.set(member.name, this.getAgentLifecycleState(teamName, member.name));
      }
    }
    return result;
  }

  // --- Snapshot (for history archiving) ---

  getSnapshot(teamName: string): { config: TeamConfig; tasks: AgentTask[]; messages: Map<string, InboxEntry[]> } | undefined {
    const config = this.teams.get(teamName);
    if (!config) { return undefined; }
    return {
      config,
      tasks: this.getTasks(teamName),
      messages: this.messages.get(teamName) ?? new Map(),
    };
  }

  // --- Cleanup ---

  dispose(): void {
    this._onDidChange.dispose();
  }
}
