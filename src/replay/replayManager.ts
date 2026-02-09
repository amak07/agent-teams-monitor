import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Frame, Manifest, TeamReplayState } from './types';
import { TeamStateManager } from '../state/teamState';
import { TeamConfig, AgentTask, InboxEntry } from '../types';

interface RecordingInfo {
  label: string;
  description: string;
  dir: string;
  manifest: Manifest | null;
  frameCount: number;
  source: 'project' | 'auto-recorded';
}

interface ActiveReplay {
  recordingDir: string;
  teamNames: string[];
  frames: Frame[];
  speed: number;
  cancellation: vscode.CancellationTokenSource;
}

export class ReplayManager implements vscode.Disposable {
  private activeReplays = new Map<string, ActiveReplay>();
  private _statusBarItem: vscode.StatusBarItem;
  private _recordingsCache: RecordingInfo[] | undefined;

  constructor(
    private state: TeamStateManager,
    private context: vscode.ExtensionContext
  ) {
    this._statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left, 200
    );
    this._statusBarItem.command = 'agentTeams.stopReplay';
  }

  get isReplaying(): boolean { return this.activeReplays.size > 0; }

  /**
   * Start replay. If recordingDir is provided, skip the picker and replay that recording directly.
   */
  async startReplay(recordingDir?: string): Promise<void> {
    let selectedRecordings: RecordingInfo[];
    let speed: number;

    if (recordingDir) {
      // Direct replay (from notification or per-session button)
      const recordings = await this.findRecordings();
      const match = recordings.find(r => r.dir === recordingDir);
      if (!match) {
        vscode.window.showWarningMessage('Recording not found.');
        return;
      }
      selectedRecordings = [match];

      // Pick speed
      const speedPick = await this.pickSpeed();
      if (speedPick === undefined) { return; }
      speed = speedPick;
    } else {
      // Show picker
      const recordings = await this.findRecordings();
      if (recordings.length === 0) {
        vscode.window.showWarningMessage('No recordings found.');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        recordings.map(r => ({
          label: r.label,
          description: `${r.description} (${r.source})`,
          recording: r,
          picked: false
        })),
        { placeHolder: 'Select recording(s) to replay', canPickMany: true }
      );
      if (!picked || picked.length === 0) { return; }
      selectedRecordings = picked.map(p => p.recording);

      const speedPick = await this.pickSpeed();
      if (speedPick === undefined) { return; }
      speed = speedPick;
    }

    // Check for team name conflicts with already-running replays
    for (const recording of selectedRecordings) {
      const teamNames = this.extractTeamNames(recording);
      for (const name of teamNames) {
        const existing = this.state.getTeamReplayState(name);
        if (existing && existing.status === 'playing') {
          vscode.window.showWarningMessage(
            `Team '${name}' is already being replayed. Stop it first.`
          );
          return;
        }
      }
    }

    // Open dashboard so user sees replay immediately
    vscode.commands.executeCommand('agentTeams.openDashboard');

    const speedLabel = speed === 0 ? 'instant' : `${speed}x`;
    const count = selectedRecordings.length;
    vscode.window.showInformationMessage(
      `Replay started: ${count} recording${count > 1 ? 's' : ''} (${speedLabel})`,
      'Stop All'
    ).then(choice => {
      if (choice === 'Stop All') { this.stopReplay(); }
    });

    // Launch all recordings in parallel
    const promises = selectedRecordings.map(r => this.playRecording(r, speed));
    await Promise.allSettled(promises);
  }

  /**
   * Replay a specific team's recording. Stops any existing replay for that team first.
   */
  async replayTeam(teamName: string, recordingDir: string): Promise<void> {
    // Stop existing replay for this team if running
    this.stopTeamReplay(teamName);
    // Clear existing state so it gets fresh data from the recording
    this.state.clearTeamReplayState(teamName);
    // Start replay for the recording
    await this.startReplay(recordingDir);
  }

  /**
   * Stop replay for a specific team (cancels the entire recording that contains it).
   */
  stopTeamReplay(teamName: string): void {
    for (const [dir, replay] of this.activeReplays) {
      if (replay.teamNames.includes(teamName)) {
        replay.cancellation.cancel();
        return;
      }
    }
  }

  /**
   * Stop all active replays.
   */
  async stopReplay(): Promise<void> {
    for (const replay of this.activeReplays.values()) {
      replay.cancellation.cancel();
    }
  }

  /** Invalidate recordings cache (call when auto-recorder saves a new recording) */
  invalidateRecordingsCache(): void {
    this._recordingsCache = undefined;
  }

  // --- Private: Playback ---

  private async playRecording(recording: RecordingInfo, speed: number): Promise<void> {
    const frames = this.loadFrames(recording.dir);
    if (frames.length === 0) { return; }

    const teamNames = this.extractTeamNames(recording, frames);
    const cancellation = new vscode.CancellationTokenSource();

    const replay: ActiveReplay = {
      recordingDir: recording.dir,
      teamNames,
      frames,
      speed,
      cancellation,
    };

    this.activeReplays.set(recording.dir, replay);
    this.updateContext();

    // Initialize replay state for each team
    for (const teamName of teamNames) {
      this.state.setTeamReplayState(teamName, {
        recordingDir: recording.dir,
        status: 'playing',
        speed,
        currentFrame: 0,
        totalFrames: frames.length,
        progressPct: 0,
      });
    }

    const token = cancellation.token;
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

        // Apply frame to in-memory state (no disk writes)
        this.applyFrame(frame);

        // Update replay progress for all teams in this recording
        const pct = Math.round(((i + 1) / frames.length) * 100);
        for (const teamName of teamNames) {
          this.state.setTeamReplayState(teamName, {
            recordingDir: recording.dir,
            status: 'playing',
            speed,
            currentFrame: i + 1,
            totalFrames: frames.length,
            progressPct: pct,
          });
        }

        this.updateStatusBar();
      }
    } finally {
      const finalStatus = token.isCancellationRequested ? 'stopped' as const : 'completed' as const;
      for (const teamName of teamNames) {
        // Guard: don't overwrite state if a new replay was already started for this team
        // (e.g., replayTeam() cancelled us and started a fresh replay)
        const current = this.state.getTeamReplayState(teamName);
        if (current && current.recordingDir !== recording.dir) { continue; }
        this.state.setTeamReplayState(teamName, {
          recordingDir: recording.dir,
          status: finalStatus,
          speed,
          currentFrame: current?.currentFrame ?? frames.length,
          totalFrames: frames.length,
          progressPct: finalStatus === 'completed' ? 100 : (current?.progressPct ?? 0),
        });
      }

      this.activeReplays.delete(recording.dir);
      cancellation.dispose();
      this.updateContext();
      this.updateStatusBar();
    }
  }

  /**
   * Apply a frame to in-memory state directly (no disk writes).
   */
  private applyFrame(frame: Frame): void {
    for (const [teamName, teamData] of Object.entries(frame.teams)) {
      this.state.updateTeam((teamData.config as TeamConfig).name, teamData.config as TeamConfig);
      for (const [agentName, entries] of Object.entries(teamData.inboxes)) {
        this.state.setMessages(teamName, agentName, entries as InboxEntry[]);
      }
    }
    for (const [teamName, taskMap] of Object.entries(frame.tasks)) {
      for (const [, task] of Object.entries(taskMap)) {
        this.state.updateTask(teamName, task as AgentTask);
      }
    }
  }

  private loadFrames(recordingDir: string): Frame[] {
    const framesDir = path.join(recordingDir, 'frames');
    try {
      const files = fs.readdirSync(framesDir)
        .filter(f => f.endsWith('.json'))
        .sort();
      return files.map(f => JSON.parse(fs.readFileSync(path.join(framesDir, f), 'utf-8')));
    } catch {
      return [];
    }
  }

  private extractTeamNames(recording: RecordingInfo, frames?: Frame[]): string[] {
    if (recording.manifest?.teamNames?.length) {
      return recording.manifest.teamNames;
    }
    // Infer from first frame
    const loadedFrames = frames ?? this.loadFrames(recording.dir);
    if (loadedFrames.length > 0) {
      return Object.keys(loadedFrames[0].teams);
    }
    return [];
  }

  // --- Private: UI ---

  private async pickSpeed(): Promise<number | undefined> {
    const speeds = [
      { label: '1x (Real-time)', speed: 1 },
      { label: '2x', speed: 2 },
      { label: '5x', speed: 5 },
      { label: '10x', speed: 10 },
      { label: 'Instant', speed: 0 },
    ];
    const pick = await vscode.window.showQuickPick(speeds, { placeHolder: 'Select replay speed' });
    return pick?.speed;
  }

  private updateContext(): void {
    vscode.commands.executeCommand('setContext', 'agentTeams.replaying', this.activeReplays.size > 0);
  }

  private updateStatusBar(): void {
    if (this.activeReplays.size === 0) {
      this._statusBarItem.hide();
      return;
    }

    // Aggregate status across all active replays
    let totalFrames = 0;
    let processedFrames = 0;
    let speedLabel = '';
    for (const replay of this.activeReplays.values()) {
      totalFrames += replay.frames.length;
      // Get current progress from state
      for (const teamName of replay.teamNames) {
        const rs = this.state.getTeamReplayState(teamName);
        if (rs) {
          processedFrames += rs.currentFrame;
          if (!speedLabel) { speedLabel = rs.speed === 0 ? 'instant' : `${rs.speed}x`; }
          break; // Only count once per recording
        }
      }
    }

    const count = this.activeReplays.size;
    if (count === 1) {
      this._statusBarItem.text = `$(play) Replay: ${processedFrames}/${totalFrames} (${speedLabel})`;
    } else {
      this._statusBarItem.text = `$(play) Replaying: ${count} sessions (${speedLabel})`;
    }
    this._statusBarItem.tooltip = 'Click to stop all replays';
    this._statusBarItem.show();
  }

  // --- Private: Recording Discovery ---

  async findRecordings(): Promise<RecordingInfo[]> {
    const results: RecordingInfo[] = [];
    const seen = new Set<string>();

    // 1. Project recordings/ directories (workspace + extension root for F5 dev)
    const searchRoots: string[] = [];
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
      for (const folder of workspaceFolders) {
        searchRoots.push(folder.uri.fsPath);
      }
    }
    const extensionRoot = path.resolve(__dirname, '..', '..');
    searchRoots.push(extensionRoot);

    for (const root of searchRoots) {
      this.scanRecordingsDir(path.join(root, 'recordings'), 'project', results, seen);
    }

    // 2. Auto-recorded sessions (globalStorageUri or custom path)
    const config = vscode.workspace.getConfiguration('agentTeams');
    const customPath = config.get<string>('recordingsPath', '');
    const autoRecordDir = customPath || path.join(this.context.globalStorageUri.fsPath, 'recordings');
    this.scanRecordingsDir(autoRecordDir, 'auto-recorded', results, seen);

    this._recordingsCache = results;
    return results;
  }

  private scanRecordingsDir(
    recordingsDir: string,
    source: 'project' | 'auto-recorded',
    results: RecordingInfo[],
    seen: Set<string>
  ): void {
    if (!fs.existsSync(recordingsDir)) { return; }

    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(recordingsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    } catch { return; }

    for (const dir of dirs) {
      const fullDir = path.join(recordingsDir, dir.name);
      const normalized = fullDir.toLowerCase();
      if (seen.has(normalized)) { continue; }
      seen.add(normalized);

      const framesDir = path.join(fullDir, 'frames');
      if (!fs.existsSync(framesDir)) { continue; }

      let frameFiles: string[];
      try {
        frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith('.json'));
      } catch { continue; }
      if (frameFiles.length === 0) { continue; }

      // Try to load manifest
      let manifest: Manifest | null = null;
      const manifestPath = path.join(fullDir, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); } catch { /* ignore */ }
      }

      // Infer team names
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
        source,
      });
    }
  }

  // --- Private: Utilities ---

  private cancellableSleep(ms: number, token: vscode.CancellationToken): Promise<void> {
    return new Promise(resolve => {
      if (token.isCancellationRequested) { resolve(); return; }
      const listener = token.onCancellationRequested(() => {
        clearTimeout(timer);
        listener.dispose();
        resolve();
      });
      const timer = setTimeout(() => {
        listener.dispose();
        resolve();
      }, ms);
    });
  }

  dispose(): void {
    for (const replay of this.activeReplays.values()) {
      replay.cancellation.cancel();
      replay.cancellation.dispose();
    }
    this.activeReplays.clear();
    this._statusBarItem.dispose();
  }
}
