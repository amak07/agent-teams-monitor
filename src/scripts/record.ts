/**
 * Session Recorder
 * Captures timestamped snapshots of ~/.claude/teams/ and ~/.claude/tasks/
 * during a live agent team session.
 *
 * Uses a hybrid approach: fs.watch for instant detection + polling as fallback.
 *
 * Usage:
 *   npm.cmd run record                     # Start recording
 *   npm.cmd run record -- --name my-test   # Custom session name
 *   Ctrl+C to stop
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { Frame, Manifest } from '../replay/types';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const TEAMS_DIR = path.join(CLAUDE_DIR, 'teams');
const TASKS_DIR = path.join(CLAUDE_DIR, 'tasks');

export interface RecorderOptions {
  sessionName: string;
  outputDir: string;
  debounceMs?: number;
  fallbackPollMs?: number;
  dirPollMs?: number;
}

export class SessionRecorder {
  private teamsWatcher: fs.FSWatcher | undefined;
  private tasksWatcher: fs.FSWatcher | undefined;
  private fallbackTimer: NodeJS.Timeout | undefined;
  private dirPollTimer: NodeJS.Timeout | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private frameCount = 0;
  private lastHash = '';
  private emptyCount = 0;
  private startTime = 0;
  private allTeamNames = new Set<string>();
  private stopped = false;
  private framesDir: string;

  private readonly debounceMs: number;
  private readonly fallbackPollMs: number;
  private readonly dirPollMs: number;

  constructor(private options: RecorderOptions) {
    this.debounceMs = options.debounceMs ?? 500;
    this.fallbackPollMs = options.fallbackPollMs ?? 10000;
    this.dirPollMs = options.dirPollMs ?? 5000;
    this.framesDir = path.join(options.outputDir, 'frames');
  }

  start(): void {
    this.startTime = Date.now();
    fs.mkdirSync(this.framesDir, { recursive: true });

    // Attach watchers if dirs exist
    this.attachWatchers();

    // Poll for directory existence (attach/detach watchers)
    this.dirPollTimer = setInterval(() => this.pollDirectories(), this.dirPollMs);

    // Fallback full-state poll
    this.fallbackTimer = setInterval(() => this.capture(), this.fallbackPollMs);

    // Initial capture
    this.capture();
  }

  stop(): Manifest {
    this.stopped = true;
    this.detachWatchers();
    if (this.fallbackTimer) { clearInterval(this.fallbackTimer); }
    if (this.dirPollTimer) { clearInterval(this.dirPollTimer); }
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); }

    const manifest = this.writeManifest();
    return manifest;
  }

  dispose(): void {
    if (!this.stopped) { this.stop(); }
  }

  private attachWatchers(): void {
    this.attachWatcher(TEAMS_DIR, 'teams');
    this.attachWatcher(TASKS_DIR, 'tasks');
  }

  private attachWatcher(dir: string, label: string): void {
    if (label === 'teams' && this.teamsWatcher) { return; }
    if (label === 'tasks' && this.tasksWatcher) { return; }
    if (!fs.existsSync(dir)) { return; }

    try {
      const watcher = fs.watch(dir, { recursive: true }, () => {
        this.onFileChange();
      });
      watcher.on('error', () => {
        // Watcher died — will re-attach on next dir poll
        if (label === 'teams') { this.teamsWatcher = undefined; }
        else { this.tasksWatcher = undefined; }
      });

      if (label === 'teams') { this.teamsWatcher = watcher; }
      else { this.tasksWatcher = watcher; }
    } catch {
      // fs.watch not supported or dir gone — rely on polling
    }
  }

  private detachWatchers(): void {
    try { this.teamsWatcher?.close(); } catch { /* ignore */ }
    try { this.tasksWatcher?.close(); } catch { /* ignore */ }
    this.teamsWatcher = undefined;
    this.tasksWatcher = undefined;
  }

  private pollDirectories(): void {
    // Re-attach watchers if dirs appeared
    if (!this.teamsWatcher && fs.existsSync(TEAMS_DIR)) {
      this.attachWatcher(TEAMS_DIR, 'teams');
    }
    if (!this.tasksWatcher && fs.existsSync(TASKS_DIR)) {
      this.attachWatcher(TASKS_DIR, 'tasks');
    }

    // Detach if dirs disappeared
    if (this.teamsWatcher && !fs.existsSync(TEAMS_DIR)) {
      try { this.teamsWatcher.close(); } catch { /* ignore */ }
      this.teamsWatcher = undefined;
    }
    if (this.tasksWatcher && !fs.existsSync(TASKS_DIR)) {
      try { this.tasksWatcher.close(); } catch { /* ignore */ }
      this.tasksWatcher = undefined;
    }

    // Also trigger a capture to detect empty state
    this.capture();
  }

  private onFileChange(): void {
    // Debounce rapid file changes into a single capture
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); }
    this.debounceTimer = setTimeout(() => this.capture(), this.debounceMs);
  }

  private capture(): void {
    if (this.stopped) { return; }

    const frame = captureState();
    const stats = countStats(frame);

    // Check for empty state (cleanup detection)
    if (stats.teams === 0 && stats.tasks === 0) {
      this.emptyCount++;
      if (this.emptyCount >= 3 && this.frameCount > 0) {
        this.saveFrame(frame);
        this.onRecordingComplete();
        return;
      }
      return;
    }
    this.emptyCount = 0;

    // Hash dedup — skip if nothing changed
    const hash = hashFrame(frame);
    if (hash === this.lastHash) { return; }
    this.lastHash = hash;

    // Track team names
    for (const name of Object.keys(frame.teams)) {
      this.allTeamNames.add(name);
    }

    this.saveFrame(frame);
    this.onFrameSaved(stats);
  }

  private saveFrame(frame: Frame): void {
    this.frameCount++;
    frame.elapsed_ms = Date.now() - this.startTime;
    const padded = String(this.frameCount).padStart(4, '0');
    fs.writeFileSync(
      path.join(this.framesDir, `${padded}.json`),
      JSON.stringify(frame, null, 2)
    );

    // Incremental manifest — survives hard kill
    this.writeManifest();
  }

  private writeManifest(): Manifest {
    const manifest: Manifest = {
      name: this.options.sessionName,
      startedAt: new Date(this.startTime).toISOString(),
      endedAt: new Date().toISOString(),
      frameCount: this.frameCount,
      teamNames: [...this.allTeamNames],
    };
    fs.writeFileSync(
      path.join(this.options.outputDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2)
    );
    return manifest;
  }

  // Override these for custom output
  protected onFrameSaved(stats: { teams: number; tasks: number; messages: number }): void {
    const elapsed = formatDuration(Date.now() - this.startTime);
    process.stdout.write(
      `\rFrame ${this.frameCount} | ${stats.teams} team${stats.teams !== 1 ? 's' : ''} | ` +
      `${stats.tasks} task${stats.tasks !== 1 ? 's' : ''} | ` +
      `${stats.messages} msg${stats.messages !== 1 ? 's' : ''} | ${elapsed}   `
    );
  }

  protected onRecordingComplete(): void {
    console.log('\nDirectories cleaned up by CC. Recording complete.');
    const manifest = this.stop();
    console.log(`\nSaved ${manifest.frameCount} frames to ${this.options.outputDir}`);
    process.exit(0);
  }
}

// --- Shared helpers ---

function readJsonSafe(filePath: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function captureState(): Frame {
  const frame: Frame = {
    timestamp: new Date().toISOString(),
    elapsed_ms: 0,
    teams: {},
    tasks: {},
  };

  if (fs.existsSync(TEAMS_DIR)) {
    const teamDirs = fs.readdirSync(TEAMS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of teamDirs) {
      const configPath = path.join(TEAMS_DIR, dir.name, 'config.json');
      const config = readJsonSafe(configPath);
      if (!config) { continue; }

      const inboxes: Record<string, unknown[]> = {};
      const inboxDir = path.join(TEAMS_DIR, dir.name, 'inboxes');
      if (fs.existsSync(inboxDir)) {
        for (const f of fs.readdirSync(inboxDir).filter(f => f.endsWith('.json'))) {
          const entries = readJsonSafe(path.join(inboxDir, f));
          if (Array.isArray(entries)) {
            inboxes[f.replace('.json', '')] = entries;
          }
        }
      }

      frame.teams[dir.name] = { config, inboxes };
    }
  }

  if (fs.existsSync(TASKS_DIR)) {
    const teamDirs = fs.readdirSync(TASKS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of teamDirs) {
      const taskDir = path.join(TASKS_DIR, dir.name);
      const taskMap: Record<string, unknown> = {};
      for (const f of fs.readdirSync(taskDir).filter(f => f.endsWith('.json') && f !== '.lock')) {
        const task = readJsonSafe(path.join(taskDir, f));
        if (task) {
          taskMap[f.replace('.json', '')] = task;
        }
      }
      if (Object.keys(taskMap).length > 0) {
        frame.tasks[dir.name] = taskMap;
      }
    }
  }

  return frame;
}

function hashFrame(frame: Frame): string {
  const content = JSON.stringify({ teams: frame.teams, tasks: frame.tasks });
  return crypto.createHash('md5').update(content).digest('hex');
}

function countStats(frame: Frame): { teams: number; tasks: number; messages: number } {
  let tasks = 0;
  let messages = 0;
  for (const team of Object.values(frame.teams)) {
    for (const inbox of Object.values(team.inboxes)) {
      messages += inbox.length;
    }
  }
  for (const teamTasks of Object.values(frame.tasks)) {
    tasks += Object.keys(teamTasks).length;
  }
  return { teams: Object.keys(frame.teams).length, tasks, messages };
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

// --- CLI Entry Point ---

if (require.main === module) {
  const args = process.argv.slice(2);
  const nameIdx = args.indexOf('--name');
  const sessionName = nameIdx >= 0 && args[nameIdx + 1] ? args[nameIdx + 1] : 'session';

  const dateStr = new Date().toISOString().slice(0, 10);
  const outputDir = path.join(process.cwd(), 'recordings', `${dateStr}_${sessionName}`);

  const recorder = new SessionRecorder({ sessionName, outputDir });

  console.log(`Recording agent teams session: ${sessionName}`);
  console.log(`Output: ${outputDir}`);
  console.log(`Watching with fs.watch + 10s fallback poll. Press Ctrl+C to stop.\n`);

  recorder.start();

  process.on('SIGINT', () => {
    console.log('\n\nStopping recorder...');
    const manifest = recorder.stop();
    console.log(`Saved ${manifest.frameCount} frames to ${outputDir}`);
    console.log(`Manifest: ${path.join(outputDir, 'manifest.json')}`);
    process.exit(0);
  });
}
