/**
 * Mock Data Script
 * Creates realistic Agent Teams files in ~/.claude/ for testing.
 * Creates 3 teams: 2 matching workspace CWD, 1 from a different project.
 * Run with: npm.cmd run mock
 * Clean with: npm.cmd run mock:clean
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const TEAM_NAMES = ['test-team', 'data-pipeline', 'quick-fix'];

interface MockMember {
  name: string;
  agentType: string;
  model: string;
  color?: string;
  prompt?: string;
  planModeRequired?: boolean;
}

interface MockTask {
  id: string;
  subject: string;
  description: string;
  status: string;
  blocks: string[];
  blockedBy: string[];
}

interface MockMessage {
  from: string;
  text: string;
  summary?: string;
  timestamp: string;
  color?: string;
  read: boolean;
}

function createTeam(
  name: string,
  cwd: string,
  members: MockMember[],
  tasks: MockTask[],
  inboxes: Record<string, MockMessage[]>
): void {
  const teamsDir = path.join(CLAUDE_DIR, 'teams', name);
  const tasksDir = path.join(CLAUDE_DIR, 'tasks', name);

  fs.mkdirSync(path.join(teamsDir, 'inboxes'), { recursive: true });
  fs.mkdirSync(tasksDir, { recursive: true });

  const now = Date.now();

  // config.json
  const config = {
    name,
    description: `Mock team: ${name}`,
    createdAt: now,
    leadAgentId: `team-lead@${name}`,
    leadSessionId: `00000000-0000-0000-0000-${name.replace(/[^a-z0-9]/g, '0').padEnd(12, '0').slice(0, 12)}`,
    members: members.map((m, i) => {
      const isLead = m.agentType === 'team-lead';
      const base: Record<string, unknown> = {
        agentId: `${m.name}@${name}`,
        name: m.name,
        agentType: m.agentType,
        model: m.model,
        joinedAt: now + i * 1000,
        tmuxPaneId: isLead ? '' : 'in-process',
        cwd,
        subscriptions: [],
      };
      if (!isLead) {
        base.prompt = m.prompt || `Work on ${name}`;
        base.color = m.color || 'blue';
        base.planModeRequired = m.planModeRequired ?? false;
        base.backendType = 'in-process';
      }
      return base;
    }),
  };
  fs.writeFileSync(path.join(teamsDir, 'config.json'), JSON.stringify(config, null, 2));

  // Tasks
  for (const task of tasks) {
    fs.writeFileSync(
      path.join(tasksDir, `${task.id}.json`),
      JSON.stringify({ ...task, metadata: { _internal: true } }, null, 2)
    );
  }

  // Inboxes
  for (const [agentName, messages] of Object.entries(inboxes)) {
    fs.writeFileSync(
      path.join(teamsDir, 'inboxes', `${agentName}.json`),
      JSON.stringify(messages, null, 2)
    );
  }

  // Lock file
  fs.writeFileSync(path.join(tasksDir, '.lock'), '');
}

function createAllMockData(): void {
  const now = Date.now();
  const thisCwd = process.cwd();

  // Team 1: test-team (matches workspace CWD)
  createTeam('test-team', thisCwd,
    [
      { name: 'team-lead', agentType: 'team-lead', model: 'claude-opus-4-6' },
      { name: 'frontend-dev', agentType: 'general-purpose', model: 'sonnet', color: 'blue', prompt: 'Build the React frontend components.' },
      { name: 'backend-dev', agentType: 'general-purpose', model: 'sonnet', color: 'green', prompt: 'Build the API endpoints and database layer.', planModeRequired: true },
    ],
    [
      { id: '1', subject: 'frontend-dev', description: 'Build login form with email/password fields and validation', status: 'completed', blocks: ['3'], blockedBy: [] },
      { id: '2', subject: 'backend-dev', description: 'Create /api/auth/login endpoint with JWT token generation', status: 'in_progress', blocks: ['3'], blockedBy: [] },
      { id: '3', subject: 'frontend-dev', description: 'Integrate login form with backend API', status: 'pending', blocks: [], blockedBy: ['1', '2'] },
      { id: '4', subject: 'backend-dev', description: 'Write unit tests for auth endpoints', status: 'pending', blocks: [], blockedBy: [] },
    ],
    {
      'team-lead': [
        { from: 'frontend-dev', text: 'Login form is complete with validation. Moving on to the integration task once the API is ready.', summary: 'Login form completed', timestamp: new Date(now + 60000).toISOString(), color: 'blue', read: true },
        { from: 'backend-dev', text: JSON.stringify({ type: 'permission_request', request_id: 'perm-mock-001', agent_id: 'backend-dev', tool_name: 'Bash', tool_use_id: 'toolu_mock001', description: 'Claude wants to run: npm test', input: { command: 'npm test' }, permission_suggestions: [] }), timestamp: new Date(now + 90000).toISOString(), color: 'green', read: true },
        { from: 'backend-dev', text: 'JWT endpoint is working. Using RS256 for token signing. Running tests now.', summary: 'API endpoint working, running tests', timestamp: new Date(now + 120000).toISOString(), color: 'green', read: false },
        { from: 'frontend-dev', text: JSON.stringify({ type: 'idle_notification', from: 'frontend-dev', timestamp: new Date(now + 130000).toISOString(), idleReason: 'available' }), timestamp: new Date(now + 130000).toISOString(), color: 'blue', read: false },
      ],
      'frontend-dev': [
        { from: 'team-lead', text: 'Good work on the login form. Stand by until backend-dev finishes the API.', summary: 'Stand by for API completion', timestamp: new Date(now + 65000).toISOString(), read: true },
      ],
      'backend-dev': [
        { from: 'team-lead', text: JSON.stringify({ type: 'permission_response', request_id: 'perm-mock-001', approve: true }), summary: 'Approve npm test', timestamp: new Date(now + 95000).toISOString(), read: true },
      ],
    }
  );

  // Team 2: data-pipeline (different CWD — filtered out by default)
  createTeam('data-pipeline', path.join(os.tmpdir(), 'other-project'),
    [
      { name: 'team-lead', agentType: 'team-lead', model: 'claude-opus-4-6' },
      { name: 'data-ingestion', agentType: 'general-purpose', model: 'sonnet', color: 'orange', prompt: 'Build the data ingestion layer.' },
      { name: 'data-transform', agentType: 'general-purpose', model: 'sonnet', color: 'purple', prompt: 'Build the data transformation pipeline.' },
      { name: 'data-validation', agentType: 'general-purpose', model: 'sonnet', color: 'red', prompt: 'Build the data validation and quality checks.' },
    ],
    [
      { id: '1', subject: 'data-ingestion', description: 'Set up Kafka consumer for event stream ingestion', status: 'in_progress', blocks: ['3'], blockedBy: [] },
      { id: '2', subject: 'data-transform', description: 'Implement Spark transformation jobs for cleaning and enrichment', status: 'in_progress', blocks: ['3'], blockedBy: [] },
      { id: '3', subject: 'data-validation', description: 'Create data quality checks and validation rules', status: 'in_progress', blocks: [], blockedBy: [] },
    ],
    {
      'team-lead': [
        { from: 'data-transform', text: JSON.stringify({ type: 'plan_approval_request', from: 'data-transform', requestId: 'plan-001', planContent: 'I will implement 3 Spark jobs: cleaner, enricher, aggregator.', timestamp: new Date(now + 50000).toISOString() }), timestamp: new Date(now + 50000).toISOString(), color: 'purple', read: false },
        { from: 'data-ingestion', text: 'Kafka consumer is running. Processing ~10k events/sec. Moving to schema validation.', summary: 'Kafka consumer running', timestamp: new Date(now + 80000).toISOString(), color: 'orange', read: true },
        { from: 'data-validation', text: 'Validation rules defined. Implementing Great Expectations suite.', summary: 'Validation rules defined', timestamp: new Date(now + 100000).toISOString(), color: 'red', read: false },
      ],
      'data-transform': [
        { from: 'team-lead', text: 'Plan looks good. Proceed with implementation.', summary: 'Plan approved', timestamp: new Date(now + 55000).toISOString(), read: true },
      ],
    }
  );

  // Team 3: quick-fix (matches workspace CWD, team wrapping up)
  createTeam('quick-fix', thisCwd,
    [
      { name: 'team-lead', agentType: 'team-lead', model: 'claude-opus-4-6' },
      { name: 'fixer', agentType: 'general-purpose', model: 'sonnet', color: 'blue', prompt: 'Fix the critical bug in the payment processing module.' },
    ],
    [
      { id: '1', subject: 'fixer', description: 'Fix race condition in payment processing that causes duplicate charges', status: 'completed', blocks: [], blockedBy: [] },
    ],
    {
      'team-lead': [
        { from: 'fixer', text: 'Fixed the race condition by adding a distributed lock using Redis. All tests passing.', summary: 'Bug fixed, tests passing', timestamp: new Date(now + 40000).toISOString(), color: 'blue', read: true },
        { from: 'fixer', text: JSON.stringify({ type: 'shutdown_request', requestId: 'shut-001', from: 'fixer', reason: 'Task completed successfully', timestamp: new Date(now + 45000).toISOString() }), timestamp: new Date(now + 45000).toISOString(), color: 'blue', read: true },
      ],
      'fixer': [
        { from: 'team-lead', text: JSON.stringify({ type: 'shutdown_approved', requestId: 'shut-001', from: 'team-lead', timestamp: new Date(now + 46000).toISOString(), paneId: 'in-process', backendType: 'in-process' }), summary: 'Shutdown approved', timestamp: new Date(now + 46000).toISOString(), read: true },
      ],
    }
  );

  console.log('Mock data created (3 teams):');
  for (const name of TEAM_NAMES) {
    const teamDir = path.join(CLAUDE_DIR, 'teams', name);
    console.log(`  ${name}: ${teamDir}`);
  }
  console.log(`\nWorkspace CWD: ${thisCwd}`);
  console.log('test-team + quick-fix match workspace (visible by default)');
  console.log('data-pipeline uses different CWD (visible with "Show All" toggle)');
  console.log(`\nTo clean up: npm.cmd run mock:clean`);
}

function cleanAllMockData(): void {
  for (const name of TEAM_NAMES) {
    fs.rmSync(path.join(CLAUDE_DIR, 'teams', name), { recursive: true, force: true });
    fs.rmSync(path.join(CLAUDE_DIR, 'tasks', name), { recursive: true, force: true });
  }
  console.log('All mock data cleaned up');
}

// CLI entry point
const arg = process.argv[2];
if (arg === 'clean') {
  cleanAllMockData();
} else {
  createAllMockData();
}
