/**
 * Simulation Cleanup Script
 * Removes all test artifacts created by the simulation harness and mock data.
 *
 * Cleans:
 *   1. Team/task files from ~/.claude/ (matching known test prefixes)
 *   2. Auto-recordings from VS Code globalStorage
 *   3. Session history archives from workspace
 *
 * Usage: npm.cmd run simulate:clean
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { TEST_TEAM_NAMES, MOCK_TEAM_NAMES } from '../test/scenarios';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const TEAMS_DIR = path.join(CLAUDE_DIR, 'teams');
const TASKS_DIR = path.join(CLAUDE_DIR, 'tasks');

/** All team names to clean (simulation + mock data) */
const ALL_TEAM_NAMES = [...TEST_TEAM_NAMES, ...MOCK_TEAM_NAMES];

function cleanTeamFiles(): number {
  let cleaned = 0;
  for (const name of ALL_TEAM_NAMES) {
    const teamDir = path.join(TEAMS_DIR, name);
    const taskDir = path.join(TASKS_DIR, name);
    if (fs.existsSync(teamDir)) {
      fs.rmSync(teamDir, { recursive: true, force: true });
      console.log(`  Removed: teams/${name}`);
      cleaned++;
    }
    if (fs.existsSync(taskDir)) {
      fs.rmSync(taskDir, { recursive: true, force: true });
      console.log(`  Removed: tasks/${name}`);
      cleaned++;
    }
  }
  return cleaned;
}

function cleanAutoRecordings(): number {
  // VS Code globalStorageUri on Windows:
  // %APPDATA%/Code/User/globalStorage/<publisher.extension>/recordings/
  const appData = process.env.APPDATA;
  if (!appData) { return 0; }

  const autoRecordDir = path.join(
    appData, 'Code', 'User', 'globalStorage',
    'abel-dev.agent-teams-monitor', 'recordings'
  );

  if (!fs.existsSync(autoRecordDir)) { return 0; }

  let cleaned = 0;
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(autoRecordDir, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch { return 0; }

  for (const dir of dirs) {
    // Auto-recorded dirs: 2026-02-09_sim-quick_123456
    const matchesTestTeam = ALL_TEAM_NAMES.some(name => dir.name.includes(name));
    if (matchesTestTeam) {
      fs.rmSync(path.join(autoRecordDir, dir.name), { recursive: true, force: true });
      console.log(`  Removed auto-recording: ${dir.name}`);
      cleaned++;
    }
  }
  return cleaned;
}

function cleanHistory(): number {
  const historyDir = path.join(process.cwd(), '.agent-teams-history');
  if (!fs.existsSync(historyDir)) { return 0; }

  let cleaned = 0;
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(historyDir, { withFileTypes: true }).filter(d => d.isDirectory());
  } catch { return 0; }

  for (const dir of dirs) {
    const matchesTestTeam = ALL_TEAM_NAMES.some(name => dir.name.includes(name));
    if (matchesTestTeam) {
      fs.rmSync(path.join(historyDir, dir.name), { recursive: true, force: true });
      console.log(`  Removed history: ${dir.name}`);
      cleaned++;
    }
  }

  // Also clean entries from sessions.jsonl
  const jsonlPath = path.join(historyDir, 'sessions.jsonl');
  if (fs.existsSync(jsonlPath)) {
    try {
      const lines = fs.readFileSync(jsonlPath, 'utf-8').split('\n');
      const filtered = lines.filter(line => {
        if (!line.trim()) { return true; }
        try {
          const entry = JSON.parse(line);
          return !ALL_TEAM_NAMES.some(name => entry.teamName === name);
        } catch { return true; }
      });
      fs.writeFileSync(jsonlPath, filtered.join('\n'));
      console.log(`  Cleaned sessions.jsonl`);
    } catch { /* ignore */ }
  }

  return cleaned;
}

function main(): void {
  console.log('Cleaning up simulation + mock test artifacts...\n');

  console.log('Team files (~/.claude/):');
  const teamCount = cleanTeamFiles();
  if (teamCount === 0) { console.log('  (none found)'); }

  console.log('\nAuto-recordings (globalStorage):');
  const recordCount = cleanAutoRecordings();
  if (recordCount === 0) { console.log('  (none found)'); }

  console.log('\nSession history (.agent-teams-history/):');
  const historyCount = cleanHistory();
  if (historyCount === 0) { console.log('  (none found)'); }

  const total = teamCount + recordCount + historyCount;
  console.log(`\nDone. Cleaned ${total} item(s).`);
}

main();
