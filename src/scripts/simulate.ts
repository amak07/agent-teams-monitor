/**
 * Simulation Test Harness
 * Progressively writes files to ~/.claude/teams/ and ~/.claude/tasks/
 * to simulate real Claude Code agent team sessions.
 *
 * Usage:
 *   npm.cmd run simulate                         # all scenarios, sequential
 *   npm.cmd run simulate -- --scenario quick      # specific scenario
 *   npm.cmd run simulate -- --parallel            # all concurrent, 3s stagger
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SimAction, Scenario } from '../test/scenarios/types';
import { getScenarios } from '../test/scenarios';
import { InboxEntry } from '../types';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const TEAMS_DIR = path.join(CLAUDE_DIR, 'teams');
const TASKS_DIR = path.join(CLAUDE_DIR, 'tasks');

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function elapsed(startMs: number): string {
  const s = ((Date.now() - startMs) / 1000).toFixed(1);
  return `${s}s`;
}

class SimulationHarness {
  /** Track current inbox state per team/agent for appendInbox */
  private inboxState = new Map<string, InboxEntry[]>();

  private inboxKey(teamName: string, agentName: string): string {
    return `${teamName}/${agentName}`;
  }

  async runScenario(scenario: Scenario): Promise<void> {
    const start = Date.now();
    console.log(`\n=== Scenario: ${scenario.name} ===`);
    console.log(`  ${scenario.description}`);
    console.log(`  Teams: ${scenario.teamNames.join(', ')}`);
    console.log(`  Events: ${scenario.events.length}\n`);

    for (let i = 0; i < scenario.events.length; i++) {
      const event = scenario.events[i];
      console.log(`  [${elapsed(start)}] [${i + 1}/${scenario.events.length}] ${event.label}`);

      for (const action of event.actions) {
        this.executeAction(action);
      }

      if (event.delayAfterMs > 0 && i < scenario.events.length - 1) {
        await sleep(event.delayAfterMs);
      }
    }

    console.log(`\n  Scenario "${scenario.name}" complete (${elapsed(start)}).`);
  }

  private executeAction(action: SimAction): void {
    switch (action.type) {
      case 'writeConfig': {
        const teamDir = path.join(TEAMS_DIR, action.teamName);
        fs.mkdirSync(path.join(teamDir, 'inboxes'), { recursive: true });
        fs.writeFileSync(
          path.join(teamDir, 'config.json'),
          JSON.stringify(action.config, null, 2)
        );
        break;
      }
      case 'writeTask': {
        const taskDir = path.join(TASKS_DIR, action.teamName);
        fs.mkdirSync(taskDir, { recursive: true });
        fs.writeFileSync(
          path.join(taskDir, `${action.task.id}.json`),
          JSON.stringify(action.task, null, 2)
        );
        break;
      }
      case 'writeInbox': {
        const inboxDir = path.join(TEAMS_DIR, action.teamName, 'inboxes');
        fs.mkdirSync(inboxDir, { recursive: true });
        fs.writeFileSync(
          path.join(inboxDir, `${action.agentName}.json`),
          JSON.stringify(action.entries, null, 2)
        );
        const key = this.inboxKey(action.teamName, action.agentName);
        this.inboxState.set(key, [...action.entries]);
        break;
      }
      case 'appendInbox': {
        const key = this.inboxKey(action.teamName, action.agentName);
        const current = this.inboxState.get(key) ?? [];
        current.push(action.entry);
        this.inboxState.set(key, current);

        const inboxDir = path.join(TEAMS_DIR, action.teamName, 'inboxes');
        fs.mkdirSync(inboxDir, { recursive: true });
        fs.writeFileSync(
          path.join(inboxDir, `${action.agentName}.json`),
          JSON.stringify(current, null, 2)
        );
        break;
      }
      case 'deleteTeam': {
        fs.rmSync(path.join(TEAMS_DIR, action.teamName), { recursive: true, force: true });
        fs.rmSync(path.join(TASKS_DIR, action.teamName), { recursive: true, force: true });
        // Clear inbox state for this team
        for (const key of [...this.inboxState.keys()]) {
          if (key.startsWith(`${action.teamName}/`)) {
            this.inboxState.delete(key);
          }
        }
        break;
      }
    }
  }
}

// --- CLI ---

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const scenarioRegistry = getScenarios();
  const parallel = args.includes('--parallel');

  // Collect requested scenario names
  const requested: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scenario' && args[i + 1]) {
      requested.push(args[i + 1]);
      i++;
    }
  }

  // Default: run all
  const scenarioNames = requested.length > 0
    ? requested
    : [...scenarioRegistry.keys()];

  // Validate
  for (const name of scenarioNames) {
    if (!scenarioRegistry.has(name)) {
      console.error(`Unknown scenario: ${name}`);
      console.error(`Available: ${[...scenarioRegistry.keys()].join(', ')}`);
      process.exit(1);
    }
  }

  const harness = new SimulationHarness();
  const scenarios = scenarioNames.map(n => scenarioRegistry.get(n)!());

  console.log(`Simulation harness starting...`);
  console.log(`Mode: ${parallel ? 'parallel (3s stagger)' : 'sequential'}`);
  console.log(`Scenarios: ${scenarioNames.join(', ')}`);

  if (parallel) {
    const promises = scenarios.map((s, i) =>
      sleep(i * 3000).then(() => harness.runScenario(s))
    );
    await Promise.allSettled(promises);
  } else {
    for (const scenario of scenarios) {
      await harness.runScenario(scenario);
    }
  }

  console.log('\n========================================');
  console.log('All scenarios complete.');
  console.log('The extension should have detected all changes via FileWatcher.');
  console.log('Auto-recordings (if enabled) are in VS Code globalStorageUri.');
  console.log('To clean up: npm.cmd run simulate:clean');
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\n\nSimulation interrupted. Test team files may remain on disk.');
  console.log('Run: npm.cmd run simulate:clean');
  process.exit(0);
});

main().catch(err => {
  console.error('Simulation error:', err);
  process.exit(1);
});
