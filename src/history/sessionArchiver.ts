import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TeamStateManager } from '../state/teamState';
import { TeamConfig, AgentTask, InboxEntry, SessionRecord, parseTypedMessage, isTeamLead } from '../types';
import { AutoRecorder } from '../replay/autoRecorder';
import { Manifest } from '../replay/types';
import { formatDuration } from '../utils';

const SNAPSHOT_INTERVAL = 30000; // 30 seconds

export class SessionArchiver {
  private historyDir: string | undefined;
  private snapshots = new Map<string, { config: TeamConfig; firstSeen: number }>();
  private snapshotTimer: NodeJS.Timeout | undefined;
  private autoRecorder: AutoRecorder | undefined;
  private cachedHistory: SessionRecord[] | undefined;
  private cachedHistoryMtime = 0;

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

  /** Set auto-recorder reference so session records include recording paths */
  setAutoRecorder(recorder: AutoRecorder): void {
    this.autoRecorder = recorder;
  }

  /** Read all session records from sessions.jsonl (mtime-cached) */
  getSessionHistory(): SessionRecord[] {
    if (!this.historyDir) { return []; }
    const jsonlPath = path.join(this.historyDir, 'sessions.jsonl');
    if (!fs.existsSync(jsonlPath)) { return []; }

    try {
      const mtime = fs.statSync(jsonlPath).mtimeMs;
      if (this.cachedHistory && mtime === this.cachedHistoryMtime) {
        return this.cachedHistory;
      }

      const content = fs.readFileSync(jsonlPath, 'utf-8');
      const records: SessionRecord[] = [];
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) { continue; }
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.version) {
            records.push(parsed as SessionRecord);
          }
        } catch {
          // Skip malformed lines
        }
      }
      this.cachedHistory = records;
      this.cachedHistoryMtime = mtime;
      return records;
    } catch {
      return [];
    }
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
      // Ensure history directory exists
      fs.mkdirSync(this.historyDir, { recursive: true });

      // Build enriched session record
      const tasks = this.state.getTasks(teamName);
      const allMessages = this.state.getAllMessages().get(teamName);
      const record = this.buildSessionRecord(teamName, config, firstSeen, tasks, allMessages);

      // Append to sessions.jsonl index
      const jsonlPath = path.join(this.historyDir, 'sessions.jsonl');
      fs.appendFileSync(jsonlPath, JSON.stringify(record) + '\n');

      console.log(`Archived Agent Team session: ${teamName} (${record.stats.totalTasks} tasks, ${record.stats.messageCount} messages)`);
    } catch (err) {
      console.warn(`Failed to archive session ${teamName}:`, err);
    }
  }

  private buildSessionRecord(
    teamName: string,
    config: TeamConfig,
    firstSeen: number,
    tasks: AgentTask[],
    messages?: Map<string, InboxEntry[]>
  ): SessionRecord {
    const now = Date.now();
    const durationMs = now - firstSeen;

    // Agent info
    const agents = config.members
      .filter(m => !isTeamLead(m))
      .map(m => ({
        name: m.name,
        model: m.model ?? 'unknown',
        role: m.name, // Use agent name as role (prompt parsing is fragile)
      }));

    // Lead name (strip "@team-name" suffix if present)
    const lead = config.leadAgentId.includes('@')
      ? config.leadAgentId.split('@')[0]
      : config.leadAgentId;

    // Task summaries
    const taskSummaries = tasks.map(t => ({
      title: t.description || `Task ${t.id}`,
      status: t.status,
      owner: t.subject,
    }));
    const completedTasks = tasks.filter(t => t.status === 'completed').length;

    // Message stats
    let messageCount = 0;
    let broadcastCount = 0;
    let planApprovals = 0;
    if (messages) {
      // Count messages
      for (const entries of messages.values()) {
        messageCount += entries.length;
      }
      // Detect broadcasts: same text+timestamp appearing in multiple inboxes
      const msgFingerprints = new Map<string, number>();
      for (const entries of messages.values()) {
        for (const entry of entries) {
          const key = `${entry.text}|${entry.timestamp}`;
          msgFingerprints.set(key, (msgFingerprints.get(key) ?? 0) + 1);
        }
      }
      for (const count of msgFingerprints.values()) {
        if (count > 1) { broadcastCount++; }
      }
      // Count plan approvals
      for (const entries of messages.values()) {
        for (const entry of entries) {
          const typed = parseTypedMessage(entry.text);
          if (typed && typed.type === 'plan_approval_response') {
            planApprovals++;
          }
        }
      }
    }

    // Derive outcome
    let outcome: string;
    if (tasks.length === 0) {
      outcome = 'no-tasks';
    } else if (completedTasks === tasks.length) {
      outcome = 'completed';
    } else if (completedTasks > 0) {
      outcome = 'partial';
    } else {
      outcome = 'abandoned';
    }

    // Recording info from auto-recorder
    let recordingPath = '';
    let frameCount = 0;
    if (this.autoRecorder) {
      const dir = this.autoRecorder.getRecordingDir(teamName);
      if (dir) {
        recordingPath = dir;
        // Read frame count from manifest if available
        try {
          const manifestPath = path.join(dir, 'manifest.json');
          if (fs.existsSync(manifestPath)) {
            const manifest: Manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            frameCount = manifest.frameCount;
          }
        } catch {
          // Manifest not yet written or unreadable
        }
      }
    }

    return {
      version: 1,
      teamName,
      teamDescription: config.description || '',
      startedAt: new Date(firstSeen).toISOString(),
      endedAt: new Date(now).toISOString(),
      duration: formatDuration(durationMs),
      lead,
      agents,
      tasks: taskSummaries,
      stats: {
        totalTasks: tasks.length,
        completedTasks,
        messageCount,
        broadcastCount,
        planApprovals,
      },
      outcome,
      notes: '',
      recordingPath,
      frameCount,
    };
  }

  /** Remove expired sessions based on retention policy */
  cleanExpiredSessions(retentionDays: number): void {
    if (!this.historyDir || retentionDays <= 0) { return; }

    const jsonlPath = path.join(this.historyDir, 'sessions.jsonl');
    if (!fs.existsSync(jsonlPath)) { return; }

    try {
      const content = fs.readFileSync(jsonlPath, 'utf-8');
      const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
      const kept: string[] = [];
      let removed = 0;

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) { continue; }
        try {
          const record = JSON.parse(trimmed);
          const endedAt = new Date(record.endedAt || record.archivedAt).getTime();
          if (endedAt < cutoff) {
            // Delete recording directory if it exists
            if (record.recordingPath && fs.existsSync(record.recordingPath)) {
              fs.rmSync(record.recordingPath, { recursive: true, force: true });
            }
            removed++;
          } else {
            kept.push(trimmed);
          }
        } catch {
          kept.push(trimmed); // Keep malformed lines
        }
      }

      if (removed > 0) {
        fs.writeFileSync(jsonlPath, kept.join('\n') + (kept.length > 0 ? '\n' : ''));
        console.log(`Session cleanup: removed ${removed} expired session(s)`);
      }
    } catch (err) {
      console.warn('Failed to clean expired sessions:', err);
    }
  }

  dispose(): void {
    if (this.snapshotTimer) { clearInterval(this.snapshotTimer); }
  }
}
