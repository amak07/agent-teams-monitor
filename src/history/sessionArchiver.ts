import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TeamStateManager } from '../state/teamState';
import { TeamConfig, InboxEntry } from '../types';

interface SessionSummary {
  teamName: string;
  date: string;
  duration: string;
  members: string[];
  taskCount: number;
  completedTasks: number;
  messageCount: number;
  outcome: string;
  archivedAt: string;
}

const SNAPSHOT_INTERVAL = 30000; // 30 seconds

export class SessionArchiver {
  private historyDir: string | undefined;
  private snapshots = new Map<string, { config: TeamConfig; firstSeen: number }>();
  private snapshotTimer: NodeJS.Timeout | undefined;

  constructor(private state: TeamStateManager) {
    // Determine history directory from workspace
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      this.historyDir = path.join(workspaceFolders[0].uri.fsPath, '.agent-teams-history');
    }

    state.onDidChange(e => {
      if (e.type === 'teamUpdated') {
        this.onTeamDetected(e.teamName);
      } else if (e.type === 'teamRemoved') {
        this.onTeamRemoved(e.teamName);
      }
    });

    // Periodic snapshot refresh
    this.snapshotTimer = setInterval(() => this.refreshSnapshots(), SNAPSHOT_INTERVAL);
  }

  private onTeamDetected(teamName: string): void {
    const config = this.state.getTeam(teamName);
    if (!config) { return; }

    if (!this.snapshots.has(teamName)) {
      this.snapshots.set(teamName, { config, firstSeen: Date.now() });
    } else {
      // Update snapshot with latest config
      this.snapshots.get(teamName)!.config = config;
    }
  }

  private onTeamRemoved(teamName: string): void {
    const snapshot = this.snapshots.get(teamName);
    if (!snapshot) { return; }

    // Skip archiving replayed sessions
    if (this.state.isTeamReplaying(teamName)) { this.snapshots.delete(teamName); return; }

    // Archive the last known state
    this.archiveSession(teamName, snapshot.config, snapshot.firstSeen);
    this.snapshots.delete(teamName);
  }

  private refreshSnapshots(): void {
    for (const teamName of this.state.getTeamNames()) {
      const config = this.state.getTeam(teamName);
      if (config) {
        if (!this.snapshots.has(teamName)) {
          this.snapshots.set(teamName, { config, firstSeen: Date.now() });
        } else {
          this.snapshots.get(teamName)!.config = config;
        }
      }
    }
  }

  private archiveSession(teamName: string, config: TeamConfig, firstSeen: number): void {
    if (!this.historyDir) { return; }

    try {
      const dateStr = new Date(firstSeen).toISOString().slice(0, 10);
      const sessionDir = path.join(this.historyDir, `${dateStr}_${teamName}`);

      // Create archive directories
      fs.mkdirSync(path.join(sessionDir, 'tasks'), { recursive: true });
      fs.mkdirSync(path.join(sessionDir, 'inboxes'), { recursive: true });

      // Write config
      fs.writeFileSync(
        path.join(sessionDir, 'config.json'),
        JSON.stringify(config, null, 2)
      );

      // Write tasks
      const tasks = this.state.getTasks(teamName);
      for (const task of tasks) {
        fs.writeFileSync(
          path.join(sessionDir, 'tasks', `${task.id}.json`),
          JSON.stringify(task, null, 2)
        );
      }

      // Write inboxes
      const allMessages = this.state.getAllMessages().get(teamName);
      if (allMessages) {
        for (const [agentName, entries] of allMessages) {
          fs.writeFileSync(
            path.join(sessionDir, 'inboxes', `${agentName}.json`),
            JSON.stringify(entries, null, 2)
          );
        }
      }

      // Append to sessions.jsonl index
      const summary = this.buildSummary(teamName, config, firstSeen, tasks, allMessages);
      const jsonlPath = path.join(this.historyDir, 'sessions.jsonl');
      fs.appendFileSync(jsonlPath, JSON.stringify(summary) + '\n');

      console.log(`Archived Agent Team session: ${teamName}`);
    } catch (err) {
      console.warn(`Failed to archive session ${teamName}:`, err);
    }
  }

  private buildSummary(
    teamName: string,
    config: TeamConfig,
    firstSeen: number,
    tasks: import('../types').AgentTask[],
    messages?: Map<string, InboxEntry[]>
  ): SessionSummary {
    const now = Date.now();
    const durationMs = now - firstSeen;
    const durationMin = Math.round(durationMs / 60000);
    const duration = durationMin < 60
      ? `${durationMin}m`
      : `${Math.floor(durationMin / 60)}h${durationMin % 60}m`;

    const completedTasks = tasks.filter(t => t.status === 'completed').length;

    let messageCount = 0;
    if (messages) {
      for (const entries of messages.values()) {
        messageCount += entries.length;
      }
    }

    // Derive outcome from task completion
    let outcome: string;
    if (tasks.length === 0) {
      outcome = 'No tasks created';
    } else if (completedTasks === tasks.length) {
      outcome = 'All tasks completed';
    } else {
      outcome = `${completedTasks}/${tasks.length} tasks completed`;
    }

    return {
      teamName,
      date: new Date(firstSeen).toISOString(),
      duration,
      members: config.members.map(m => m.name),
      taskCount: tasks.length,
      completedTasks,
      messageCount,
      outcome,
      archivedAt: new Date(now).toISOString(),
    };
  }

  dispose(): void {
    if (this.snapshotTimer) { clearInterval(this.snapshotTimer); }
  }
}
