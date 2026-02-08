import * as vscode from 'vscode';
import * as path from 'path';
import { TeamConfig, AgentTask, InboxEntry } from '../types';

type TeamStateEvent =
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

  private _onDidChange = new vscode.EventEmitter<TeamStateEvent>();
  readonly onDidChange = this._onDidChange.event;

  // --- Teams ---

  updateTeam(name: string, config: TeamConfig): void {
    this.teams.set(name, config);
    this._onDidChange.fire({ type: 'teamUpdated', teamName: name });
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
