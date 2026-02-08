/**
 * Session Replayer
 * Reads a recorded session and writes frames back to ~/.claude/teams/ and ~/.claude/tasks/
 * with realistic timing, so the extension can observe the full lifecycle.
 *
 * Usage:
 *   npm.cmd run replay -- recordings/2026-02-07_session
 *   npm.cmd run replay -- recordings/2026-02-07_session --speed 5     # 5x speed
 *   npm.cmd run replay -- recordings/2026-02-07_session --speed 0     # instant
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Frame, Manifest } from '../replay/types';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const TEAMS_DIR = path.join(CLAUDE_DIR, 'teams');
const TASKS_DIR = path.join(CLAUDE_DIR, 'tasks');

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function writeFrame(frame: Frame): Set<string> {
  const writtenTeams = new Set<string>();

  // Write teams
  for (const [teamName, teamData] of Object.entries(frame.teams)) {
    writtenTeams.add(teamName);
    const teamDir = path.join(TEAMS_DIR, teamName);
    const inboxDir = path.join(teamDir, 'inboxes');
    fs.mkdirSync(inboxDir, { recursive: true });

    // Write config
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify(teamData.config, null, 2)
    );

    // Write inboxes
    for (const [agentName, entries] of Object.entries(teamData.inboxes)) {
      fs.writeFileSync(
        path.join(inboxDir, `${agentName}.json`),
        JSON.stringify(entries, null, 2)
      );
    }
  }

  // Write tasks
  for (const [teamName, taskMap] of Object.entries(frame.tasks)) {
    writtenTeams.add(teamName);
    const taskDir = path.join(TASKS_DIR, teamName);
    fs.mkdirSync(taskDir, { recursive: true });

    for (const [taskId, task] of Object.entries(taskMap)) {
      fs.writeFileSync(
        path.join(taskDir, `${taskId}.json`),
        JSON.stringify(task, null, 2)
      );
    }
  }

  return writtenTeams;
}

function cleanup(teamNames: Set<string>): void {
  for (const name of teamNames) {
    const teamDir = path.join(TEAMS_DIR, name);
    const taskDir = path.join(TASKS_DIR, name);
    fs.rmSync(teamDir, { recursive: true, force: true });
    fs.rmSync(taskDir, { recursive: true, force: true });
  }
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

// --- Main ---

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const recordingDir = args.find(a => !a.startsWith('--'));
  const speedIdx = args.indexOf('--speed');
  const speed = speedIdx >= 0 && args[speedIdx + 1] ? parseFloat(args[speedIdx + 1]) : 1;
  const noCleanup = args.includes('--no-cleanup');

  if (!recordingDir) {
    console.error('Usage: npm.cmd run replay -- <recording-dir> [--speed N] [--no-cleanup]');
    console.error('  --speed 0     instant replay (no delays)');
    console.error('  --speed 5     5x speed');
    console.error('  --no-cleanup  leave files on disk after replay');
    process.exit(1);
  }

  const manifestPath = path.join(recordingDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`Manifest not found: ${manifestPath}`);
    process.exit(1);
  }

  const manifest: Manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const framesDir = path.join(recordingDir, 'frames');

  // Load all frames
  const frameFiles = fs.readdirSync(framesDir)
    .filter(f => f.endsWith('.json'))
    .sort();

  if (frameFiles.length === 0) {
    console.error('No frames found in recording.');
    process.exit(1);
  }

  console.log(`Replaying: ${manifest.name}`);
  console.log(`Teams: ${manifest.teamNames.join(', ')}`);
  console.log(`Frames: ${frameFiles.length} | Speed: ${speed === 0 ? 'instant' : `${speed}x`}`);
  console.log('');

  const allWrittenTeams = new Set<string>();
  let prevElapsed = 0;

  for (let i = 0; i < frameFiles.length; i++) {
    const frame: Frame = JSON.parse(fs.readFileSync(path.join(framesDir, frameFiles[i]), 'utf-8'));

    // Delay based on elapsed time difference
    if (i > 0 && speed > 0) {
      const delta = frame.elapsed_ms - prevElapsed;
      if (delta > 0) {
        await sleep(delta / speed);
      }
    }
    prevElapsed = frame.elapsed_ms;

    const written = writeFrame(frame);
    for (const name of written) { allWrittenTeams.add(name); }

    const teamCount = Object.keys(frame.teams).length;
    let taskCount = 0;
    for (const tasks of Object.values(frame.tasks)) {
      taskCount += Object.keys(tasks).length;
    }

    process.stdout.write(
      `\rFrame ${i + 1}/${frameFiles.length} (${formatDuration(frame.elapsed_ms)}) | ` +
      `${teamCount} team${teamCount !== 1 ? 's' : ''} | ${taskCount} task${taskCount !== 1 ? 's' : ''} | ` +
      `Speed: ${speed === 0 ? 'instant' : `${speed}x`}   `
    );
  }

  console.log('\n\nReplay complete.');

  if (noCleanup) {
    console.log('Files left on disk (--no-cleanup). Clean manually or run mock:clean.');
  } else {
    console.log('Cleaning up in 5 seconds... (Ctrl+C to keep files)');
    await sleep(5000);
    cleanup(allWrittenTeams);
    console.log('Cleaned up.');
  }
}

// Handle Ctrl+C during replay
process.on('SIGINT', () => {
  console.log('\n\nReplay interrupted. Files may remain on disk.');
  process.exit(0);
});

main().catch(err => {
  console.error('Replay error:', err);
  process.exit(1);
});
