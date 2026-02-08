import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Frame, Manifest } from './types';
import { TeamStateManager } from '../state/teamState';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const TEAMS_DIR = path.join(CLAUDE_DIR, 'teams');
const TASKS_DIR = path.join(CLAUDE_DIR, 'tasks');

interface RecordingInfo {
  label: string;
  description: string;
  dir: string;
  manifest: Manifest | null;
  frameCount: number;
}

export class ReplayManager implements vscode.Disposable {
  private _isReplaying = false;
  private _cancellation: vscode.CancellationTokenSource | undefined;
  private _statusBarItem: vscode.StatusBarItem;
  private _writtenTeams = new Set<string>();

  constructor(private state: TeamStateManager) {
    this._statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left, 200
    );
    this._statusBarItem.command = 'agentTeams.stopReplay';
  }

  get isReplaying(): boolean { return this._isReplaying; }

  async startReplay(): Promise<void> {
    if (this._isReplaying) {
      vscode.window.showInformationMessage('A replay is already in progress. Stop it first.');
      return;
    }

    // Find recordings
    const recordings = await this.findRecordings();
    if (recordings.length === 0) {
      vscode.window.showWarningMessage('No recordings found in recordings/ directory.');
      return;
    }

    // Pick recording(s) — multi-select to test multi-team scenarios
    const picked = await vscode.window.showQuickPick(
      recordings.map(r => ({ label: r.label, description: r.description, recording: r, picked: false })),
      { placeHolder: 'Select recording(s) to replay', canPickMany: true }
    );
    if (!picked || picked.length === 0) { return; }

    // Pick speed
    const speeds = [
      { label: '1x (Real-time)', speed: 1 },
      { label: '2x', speed: 2 },
      { label: '5x', speed: 5 },
      { label: '10x', speed: 10 },
      { label: 'Instant', speed: 0 },
    ];
    const speedPick = await vscode.window.showQuickPick(speeds, {
      placeHolder: 'Select replay speed'
    });
    if (!speedPick) { return; }

    // Safety check: warn if live data exists
    if (this.hasLiveData()) {
      const proceed = await vscode.window.showWarningMessage(
        'Live agent team data detected. Replay will overwrite it.',
        'Proceed', 'Cancel'
      );
      if (proceed !== 'Proceed') { return; }
    }

    // Begin playback — merge frames from all selected recordings
    const dirs = picked.map(p => p.recording.dir);
    const speed = speedPick.speed;
    await this.playRecordings(dirs, speed);
  }

  async stopReplay(): Promise<void> {
    if (!this._isReplaying) { return; }
    this._cancellation?.cancel();
  }

  private async playRecordings(recordingDirs: string[], speed: number): Promise<void> {
    // Load and merge frames from all recordings
    const frames: Frame[] = [];
    for (const dir of recordingDirs) {
      const framesDir = path.join(dir, 'frames');
      const frameFiles = fs.readdirSync(framesDir)
        .filter(f => f.endsWith('.json'))
        .sort();
      for (const f of frameFiles) {
        frames.push(JSON.parse(fs.readFileSync(path.join(framesDir, f), 'utf-8')));
      }
    }

    if (frames.length === 0) {
      vscode.window.showWarningMessage('Selected recording(s) have no frames.');
      return;
    }

    // Sort merged frames by elapsed_ms for interleaved playback
    frames.sort((a, b) => a.elapsed_ms - b.elapsed_ms);
    const recordingCount = recordingDirs.length;

    // Setup
    this._isReplaying = true;
    this._writtenTeams.clear();
    this._cancellation = new vscode.CancellationTokenSource();
    this.state.replayMode = true;
    vscode.commands.executeCommand('setContext', 'agentTeams.replaying', true);

    const token = this._cancellation.token;
    let prevElapsed = 0;

    try {
      for (let i = 0; i < frames.length; i++) {
        if (token.isCancellationRequested) { break; }

        const frame = frames[i];

        // Delay based on elapsed time
        if (i > 0 && speed > 0) {
          const delta = frame.elapsed_ms - prevElapsed;
          if (delta > 0) {
            await this.cancellableSleep(delta / speed, token);
            if (token.isCancellationRequested) { break; }
          }
        }
        prevElapsed = frame.elapsed_ms;

        // Write frame to disk
        this.writeFrame(frame);

        // Update status bar
        const elapsed = this.formatDuration(frame.elapsed_ms);
        const speedLabel = speed === 0 ? 'instant' : `${speed}x`;
        const recLabel = recordingCount > 1 ? ` · ${recordingCount} recordings` : '';
        this._statusBarItem.text = `$(play) Replay: ${i + 1}/${frames.length} (${speedLabel})`;
        this._statusBarItem.tooltip = `Frame ${i + 1}/${frames.length} · ${elapsed}${recLabel} · Click to stop`;
        this._statusBarItem.show();
      }
    } finally {
      this._statusBarItem.hide();
      vscode.commands.executeCommand('setContext', 'agentTeams.replaying', false);
      this.state.replayMode = false;
      this._isReplaying = false;
      this._cancellation?.dispose();
      this._cancellation = undefined;
    }

    if (token.isCancellationRequested) {
      const choice = await vscode.window.showInformationMessage(
        'Replay stopped.', 'Clean Up Files', 'Keep Files'
      );
      if (choice === 'Clean Up Files') { this.cleanup(); }
    } else {
      const choice = await vscode.window.showInformationMessage(
        'Replay complete.', 'Clean Up Files', 'Keep Files'
      );
      if (choice === 'Clean Up Files') {
        this.cleanup();
      } else {
        // Auto-cleanup after 30s if no choice made
        setTimeout(() => {
          if (this._writtenTeams.size > 0) { this.cleanup(); }
        }, 30000);
      }
    }
  }

  private writeFrame(frame: Frame): void {
    // Write teams
    for (const [teamName, teamData] of Object.entries(frame.teams)) {
      this._writtenTeams.add(teamName);
      const teamDir = path.join(TEAMS_DIR, teamName);
      const inboxDir = path.join(teamDir, 'inboxes');
      fs.mkdirSync(inboxDir, { recursive: true });

      fs.writeFileSync(
        path.join(teamDir, 'config.json'),
        JSON.stringify(teamData.config, null, 2)
      );

      for (const [agentName, entries] of Object.entries(teamData.inboxes)) {
        fs.writeFileSync(
          path.join(inboxDir, `${agentName}.json`),
          JSON.stringify(entries, null, 2)
        );
      }
    }

    // Write tasks
    for (const [teamName, taskMap] of Object.entries(frame.tasks)) {
      this._writtenTeams.add(teamName);
      const taskDir = path.join(TASKS_DIR, teamName);
      fs.mkdirSync(taskDir, { recursive: true });

      for (const [taskId, task] of Object.entries(taskMap)) {
        fs.writeFileSync(
          path.join(taskDir, `${taskId}.json`),
          JSON.stringify(task, null, 2)
        );
      }
    }
  }

  private cleanup(): void {
    for (const name of this._writtenTeams) {
      const teamDir = path.join(TEAMS_DIR, name);
      const taskDir = path.join(TASKS_DIR, name);
      try { fs.rmSync(teamDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(taskDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    this._writtenTeams.clear();
  }

  private async findRecordings(): Promise<RecordingInfo[]> {
    const results: RecordingInfo[] = [];
    const seen = new Set<string>();

    // Collect candidate directories: workspace folders + extension root (for F5 dev)
    const searchRoots: string[] = [];
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      for (const folder of workspaceFolders) {
        searchRoots.push(folder.uri.fsPath);
      }
    }
    // Extension root (out/replay/ → project root)
    const extensionRoot = path.resolve(__dirname, '..', '..');
    searchRoots.push(extensionRoot);

    for (const root of searchRoots) {
      const recordingsDir = path.join(root, 'recordings');
      if (!fs.existsSync(recordingsDir)) { continue; }

      const dirs = fs.readdirSync(recordingsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());

      for (const dir of dirs) {
        const fullDir = path.join(recordingsDir, dir.name);
        const normalized = fullDir.toLowerCase();
        if (seen.has(normalized)) { continue; }
        seen.add(normalized);

        const framesDir = path.join(fullDir, 'frames');
        if (!fs.existsSync(framesDir)) { continue; }

        const frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith('.json'));
        if (frameFiles.length === 0) { continue; }

        // Try to load manifest
        let manifest: Manifest | null = null;
        const manifestPath = path.join(fullDir, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
          try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); } catch { /* ignore */ }
        }

        // Infer info from first frame if no manifest
        let teamNames: string[] = [];
        if (manifest) {
          teamNames = manifest.teamNames;
        } else {
          try {
            const firstFrame: Frame = JSON.parse(
              fs.readFileSync(path.join(framesDir, frameFiles.sort()[0]), 'utf-8')
            );
            teamNames = Object.keys(firstFrame.teams);
          } catch { /* ignore */ }
        }

        const name = manifest?.name || dir.name.replace(/^\d{4}-\d{2}-\d{2}_/, '');
        results.push({
          label: name,
          description: `${frameFiles.length} frames · ${teamNames.join(', ') || 'unknown team'}`,
          dir: fullDir,
          manifest,
          frameCount: frameFiles.length,
        });
      }
    }

    return results;
  }

  private hasLiveData(): boolean {
    try {
      if (fs.existsSync(TEAMS_DIR)) {
        const entries = fs.readdirSync(TEAMS_DIR, { withFileTypes: true });
        if (entries.some(e => e.isDirectory())) { return true; }
      }
    } catch { /* ignore */ }
    return false;
  }

  private cancellableSleep(ms: number, token: vscode.CancellationToken): Promise<void> {
    return new Promise(resolve => {
      if (token.isCancellationRequested) { resolve(); return; }
      const timer = setTimeout(resolve, ms);
      const listener = token.onCancellationRequested(() => {
        clearTimeout(timer);
        listener.dispose();
        resolve();
      });
    });
  }

  private formatDuration(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
  }

  dispose(): void {
    this._cancellation?.cancel();
    this._cancellation?.dispose();
    this._statusBarItem.dispose();
  }
}
