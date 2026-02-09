import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { TeamStateManager } from '../state/teamState';
import { Frame, Manifest } from './types';
import { TeamConfig, InboxEntry } from '../types';

interface TeamRecording {
  teamName: string;
  outputDir: string;
  framesDir: string;
  frameCount: number;
  startTime: number;
  lastHash: string;
}

const CAPTURE_DEBOUNCE_MS = 500;

export class AutoRecorder {
  private recorders = new Map<string, TeamRecording>();
  private completedRecordings = new Map<string, string>(); // teamName -> outputDir
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private state: TeamStateManager,
    private outputBaseDir: string
  ) {}

  /** Called when FileWatcher detects a new team */
  startRecording(teamName: string): void {
    if (this.recorders.has(teamName)) { return; }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '');
    const outputDir = path.join(this.outputBaseDir, `${dateStr}_${teamName}_${timeStr}`);
    const framesDir = path.join(outputDir, 'frames');
    fs.mkdirSync(framesDir, { recursive: true });

    this.recorders.set(teamName, {
      teamName,
      outputDir,
      framesDir,
      frameCount: 0,
      startTime: Date.now(),
      lastHash: '',
    });

    // Capture initial frame
    this.captureFrame(teamName);
  }

  /** Called on state changes for tracked teams (debounced to batch rapid events) */
  captureFrame(teamName: string): void {
    if (!this.recorders.has(teamName)) { return; }

    // Debounce: batch rapid state changes into a single frame
    const existing = this.debounceTimers.get(teamName);
    if (existing) { clearTimeout(existing); }
    this.debounceTimers.set(teamName, setTimeout(() => {
      this.debounceTimers.delete(teamName);
      this.captureFrameImmediate(teamName);
    }, CAPTURE_DEBOUNCE_MS));
  }

  /** Capture a frame immediately (no debounce). Used internally and for final capture on stop. */
  private captureFrameImmediate(teamName: string): void {
    const recording = this.recorders.get(teamName);
    if (!recording) { return; }

    const frame = this.buildFrameFromState(teamName);
    const hash = this.hashFrame(frame);
    if (hash === recording.lastHash) { return; } // No change — deduplicate

    recording.lastHash = hash;
    recording.frameCount++;
    frame.elapsed_ms = Date.now() - recording.startTime;

    const padded = String(recording.frameCount).padStart(4, '0');
    fs.writeFileSync(
      path.join(recording.framesDir, `${padded}.json`),
      JSON.stringify(frame, null, 2)
    );

    // Incremental manifest (survives hard kill)
    this.writeManifest(recording);
  }

  /** Called when FileWatcher detects team disappeared. Returns manifest if recording was active. */
  stopRecording(teamName: string): Manifest | null {
    const recording = this.recorders.get(teamName);
    if (!recording) { return null; }

    // Flush any pending debounced capture, then capture final frame
    const pendingTimer = this.debounceTimers.get(teamName);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.debounceTimers.delete(teamName);
    }
    this.captureFrameImmediate(teamName);

    const manifest = this.writeManifest(recording);
    this.completedRecordings.set(teamName, recording.outputDir);
    this.recorders.delete(teamName);
    return manifest;
  }

  /** Get the recording directory for a team that was or is being recorded */
  getRecordingDir(teamName: string): string | undefined {
    return this.recorders.get(teamName)?.outputDir ?? this.completedRecordings.get(teamName);
  }

  /** Check if currently recording a team */
  isRecording(teamName: string): boolean {
    return this.recorders.has(teamName);
  }

  dispose(): void {
    // Clear any pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    // Finalize any in-progress recordings
    for (const teamName of [...this.recorders.keys()]) {
      this.stopRecording(teamName);
    }
  }

  // --- Private ---

  private buildFrameFromState(teamName: string): Frame {
    const frame: Frame = {
      timestamp: new Date().toISOString(),
      elapsed_ms: 0,
      teams: {},
      tasks: {},
    };

    const config = this.state.getTeam(teamName);
    if (!config) { return frame; }

    // Build team data from state
    const inboxes: Record<string, unknown[]> = {};
    const allMessages = this.state.getAllMessages().get(teamName);
    if (allMessages) {
      for (const [agentName, entries] of allMessages) {
        inboxes[agentName] = entries;
      }
    }
    frame.teams[teamName] = { config: config as unknown as Record<string, unknown>, inboxes };

    // Build tasks from state
    const tasks = this.state.getTasks(teamName);
    if (tasks.length > 0) {
      const taskMap: Record<string, unknown> = {};
      for (const t of tasks) { taskMap[t.id] = t; }
      frame.tasks[teamName] = taskMap;
    }

    return frame;
  }

  private hashFrame(frame: Frame): string {
    const content = JSON.stringify({ teams: frame.teams, tasks: frame.tasks });
    return crypto.createHash('md5').update(content).digest('hex');
  }

  private writeManifest(recording: TeamRecording): Manifest {
    const manifest: Manifest = {
      name: recording.teamName,
      startedAt: new Date(recording.startTime).toISOString(),
      endedAt: new Date().toISOString(),
      frameCount: recording.frameCount,
      teamNames: [recording.teamName],
    };

    fs.writeFileSync(
      path.join(recording.outputDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2)
    );

    return manifest;
  }
}
