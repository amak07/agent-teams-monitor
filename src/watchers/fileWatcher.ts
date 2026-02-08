import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TeamStateManager } from '../state/teamState';
import { TeamConfig, AgentTask, InboxEntry } from '../types';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const TEAMS_DIR = path.join(CLAUDE_DIR, 'teams');
const TASKS_DIR = path.join(CLAUDE_DIR, 'tasks');

const POLL_INTERVAL = 5000;       // Check for directories every 5s
const DEBOUNCE_MS = 300;          // Wait 300ms after file change before reading
const FULL_SCAN_INTERVAL = 10000; // Full rescan every 10s (catches missed events)

export class FileWatcher {
  private pollTimer: NodeJS.Timeout | undefined;
  private scanTimer: NodeJS.Timeout | undefined;
  private teamsWatcher: fs.FSWatcher | undefined;
  private tasksWatcher: fs.FSWatcher | undefined;
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private watching = false;

  constructor(private state: TeamStateManager) {}

  start(): void {
    this.pollForDirectories();
    this.pollTimer = setInterval(() => this.pollForDirectories(), POLL_INTERVAL);
    this.scanTimer = setInterval(() => this.fullScan(), FULL_SCAN_INTERVAL);
  }

  private pollForDirectories(): void {
    const teamsExists = fs.existsSync(TEAMS_DIR);
    const tasksExists = fs.existsSync(TASKS_DIR);

    if (teamsExists && !this.teamsWatcher) {
      this.watchDirectory(TEAMS_DIR, 'teams');
      this.scanTeamsDir();
    }
    if (tasksExists && !this.tasksWatcher) {
      this.watchDirectory(TASKS_DIR, 'tasks');
      this.scanTasksDir();
    }

    // Detect cleanup: directory gone but we were watching
    if (!teamsExists && this.teamsWatcher) {
      this.teamsWatcher.close();
      this.teamsWatcher = undefined;
      // Notify state about removed teams
      for (const name of this.state.getTeamNames()) {
        this.state.removeTeam(name);
      }
    }
    if (!tasksExists && this.tasksWatcher) {
      this.tasksWatcher.close();
      this.tasksWatcher = undefined;
    }
  }

  private watchDirectory(dir: string, type: 'teams' | 'tasks'): void {
    try {
      const watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
        if (!filename) { return; }
        const fullPath = path.join(dir, filename);
        this.debouncedHandleChange(fullPath, type);
      });

      watcher.on('error', (err) => {
        console.warn(`FileWatcher error on ${type}:`, err.message);
        if (type === 'teams') {
          this.teamsWatcher = undefined;
        } else {
          this.tasksWatcher = undefined;
        }
      });

      if (type === 'teams') {
        this.teamsWatcher = watcher;
      } else {
        this.tasksWatcher = watcher;
      }
      this.watching = true;
    } catch (err) {
      console.warn(`Failed to watch ${dir}:`, err);
    }
  }

  private debouncedHandleChange(filePath: string, type: 'teams' | 'tasks'): void {
    const key = filePath;
    const existing = this.debounceTimers.get(key);
    if (existing) { clearTimeout(existing); }

    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key);
      this.handleFileChange(filePath, type);
    }, DEBOUNCE_MS));
  }

  private handleFileChange(filePath: string, type: 'teams' | 'tasks'): void {
    // Normalize path separators
    const normalized = filePath.replace(/\\/g, '/');

    if (type === 'teams') {
      if (normalized.endsWith('config.json')) {
        this.readTeamConfig(filePath);
      } else if (normalized.includes('/inboxes/') && normalized.endsWith('.json')) {
        this.readInbox(filePath);
      }
    } else if (type === 'tasks') {
      if (normalized.endsWith('.json') && !normalized.endsWith('.lock')) {
        this.readTask(filePath);
      }
    }
  }

  // --- Readers ---

  private readTeamConfig(filePath: string): void {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const config: TeamConfig = JSON.parse(content);
      if (config.name) {
        this.state.updateTeam(config.name, config);
      }
    } catch {
      // File may be mid-write or deleted
    }
  }

  private readInbox(filePath: string): void {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const entries: InboxEntry[] = JSON.parse(content);
      // Extract team name and agent name from path
      const normalized = filePath.replace(/\\/g, '/');
      const match = normalized.match(/teams\/([^/]+)\/inboxes\/([^/]+)\.json$/);
      if (match && Array.isArray(entries)) {
        const [, teamName, agentName] = match;
        this.state.setMessages(teamName, agentName, entries);
      }
    } catch {
      // File may be mid-write or deleted
    }
  }

  private readTask(filePath: string): void {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const task: AgentTask = JSON.parse(content);
      // Extract team name from path
      const normalized = filePath.replace(/\\/g, '/');
      const match = normalized.match(/tasks\/([^/]+)\/[^/]+\.json$/);
      if (match && task.id) {
        const [, teamName] = match;
        this.state.updateTask(teamName, task);
      }
    } catch {
      // File may be mid-write or deleted
    }
  }

  // --- Full scan (catches anything missed by fs.watch) ---

  private fullScan(): void {
    if (fs.existsSync(TEAMS_DIR)) {
      this.scanTeamsDir();
    }
    if (fs.existsSync(TASKS_DIR)) {
      this.scanTasksDir();
    }
  }

  private scanTeamsDir(): void {
    try {
      const teamDirs = fs.readdirSync(TEAMS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory());

      const dirsOnDisk = new Set(teamDirs.map(d => d.name));

      for (const dir of teamDirs) {
        const configPath = path.join(TEAMS_DIR, dir.name, 'config.json');
        if (fs.existsSync(configPath)) {
          this.readTeamConfig(configPath);
        }

        const inboxDir = path.join(TEAMS_DIR, dir.name, 'inboxes');
        if (fs.existsSync(inboxDir)) {
          const inboxFiles = fs.readdirSync(inboxDir)
            .filter(f => f.endsWith('.json'));
          for (const file of inboxFiles) {
            this.readInbox(path.join(inboxDir, file));
          }
        }
      }

      // Remove teams from state that no longer exist on disk
      for (const teamName of this.state.getTeamNames()) {
        if (!dirsOnDisk.has(teamName)) {
          this.state.removeTeam(teamName);
        }
      }
    } catch {
      // Directory may have been removed
    }
  }

  private scanTasksDir(): void {
    try {
      const teamDirs = fs.readdirSync(TASKS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory());

      for (const dir of teamDirs) {
        const taskDir = path.join(TASKS_DIR, dir.name);
        const taskFiles = fs.readdirSync(taskDir)
          .filter(f => f.endsWith('.json') && f !== '.lock');
        for (const file of taskFiles) {
          this.readTask(path.join(taskDir, file));
        }
      }
    } catch {
      // Directory may have been removed
    }
  }

  // --- Cleanup ---

  cleanTeam(teamName: string): void {
    const teamDir = path.join(TEAMS_DIR, teamName);
    const taskDir = path.join(TASKS_DIR, teamName);
    try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(taskDir, { recursive: true, force: true }); } catch { /* ignore */ }
    this.state.removeTeam(teamName);
  }

  // --- Lifecycle ---

  isWatching(): boolean {
    return this.watching;
  }

  dispose(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); }
    if (this.scanTimer) { clearInterval(this.scanTimer); }
    if (this.teamsWatcher) { this.teamsWatcher.close(); }
    if (this.tasksWatcher) { this.tasksWatcher.close(); }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}
