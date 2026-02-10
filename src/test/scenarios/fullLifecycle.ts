import { Scenario } from './types';
import { buildConfig, buildTask, buildMessage, buildTypedMessage, fakeUUID } from './helpers';

const TEAM = 'sim-lifecycle';

export function createFullLifecycle(): Scenario {
  const leadOnly = buildConfig({
    name: TEAM,
    description: 'Full lifecycle demo with 3 agents',
    members: [
      { name: 'team-lead', agentType: 'team-lead' },
    ],
  });

  const withAlpha = buildConfig({
    name: TEAM,
    description: 'Full lifecycle demo with 3 agents',
    members: [
      { name: 'team-lead', agentType: 'team-lead' },
      { name: 'agent-alpha', color: 'blue', prompt: 'Research the codebase and document findings.' },
    ],
  });

  const withAlphaBeta = buildConfig({
    name: TEAM,
    description: 'Full lifecycle demo with 3 agents',
    members: [
      { name: 'team-lead', agentType: 'team-lead' },
      { name: 'agent-alpha', color: 'blue', prompt: 'Research the codebase and document findings.' },
      { name: 'agent-beta', color: 'green', prompt: 'Implement the feature based on research.' },
    ],
  });

  const withAll = buildConfig({
    name: TEAM,
    description: 'Full lifecycle demo with 3 agents',
    members: [
      { name: 'team-lead', agentType: 'team-lead' },
      { name: 'agent-alpha', color: 'blue', prompt: 'Research the codebase and document findings.' },
      { name: 'agent-beta', color: 'green', prompt: 'Implement the feature based on research.' },
      { name: 'agent-gamma', color: 'orange', prompt: 'Write tests and validate implementation.', planModeRequired: true },
    ],
  });

  return {
    name: 'lifecycle',
    description: 'Full 15-step lifecycle (~30s): 3 agents, deps, plan mode, broadcasts, shutdown',
    teamNames: [TEAM],
    events: [
      // --- Event 1: Team created ---
      {
        label: 'Team created (lead only)',
        delayAfterMs: 2000,
        actions: [
          { type: 'writeConfig', teamName: TEAM, config: leadOnly },
        ],
      },
      // --- Event 2: Tasks with dependency chain ---
      {
        label: '4 tasks created with dependency chain',
        delayAfterMs: 2000,
        actions: [
          { type: 'writeTask', teamName: TEAM, task: buildTask({ id: '1', subject: 'agent-alpha', description: 'Research existing codebase patterns and architecture', status: 'pending', blocks: ['2', '3'] }) },
          { type: 'writeTask', teamName: TEAM, task: buildTask({ id: '2', subject: 'agent-beta', description: 'Implement feature based on research findings', status: 'pending', blockedBy: ['1'], blocks: ['4'] }) },
          { type: 'writeTask', teamName: TEAM, task: buildTask({ id: '3', subject: 'agent-gamma', description: 'Write test plan and initial test scaffolding', status: 'pending', blockedBy: ['1'] }) },
          { type: 'writeTask', teamName: TEAM, task: buildTask({ id: '4', subject: 'agent-gamma', description: 'Run full test suite and validate implementation', status: 'pending', blockedBy: ['2', '3'] }) },
        ],
      },
      // --- Event 3: Agent alpha joins ---
      {
        label: 'Agent alpha joins',
        delayAfterMs: 2000,
        actions: [
          { type: 'writeConfig', teamName: TEAM, config: withAlpha },
          { type: 'writeTask', teamName: TEAM, task: buildTask({ id: '1', subject: 'agent-alpha', description: 'Research existing codebase patterns and architecture', status: 'in_progress', blocks: ['2', '3'] }) },
        ],
      },
      // --- Event 4: Agent beta joins ---
      {
        label: 'Agent beta joins',
        delayAfterMs: 2000,
        actions: [
          { type: 'writeConfig', teamName: TEAM, config: withAlphaBeta },
        ],
      },
      // --- Event 5: Agent gamma joins (plan mode) ---
      {
        label: 'Agent gamma joins (planModeRequired)',
        delayAfterMs: 2000,
        actions: [
          { type: 'writeConfig', teamName: TEAM, config: withAll },
        ],
      },
      // --- Event 6: Broadcast kickoff ---
      {
        label: 'Lead broadcasts kickoff message',
        delayAfterMs: 2000,
        actions: [
          { type: 'appendInbox', teamName: TEAM, agentName: 'agent-alpha', entry: buildMessage({ from: 'team-lead', text: 'Welcome team! Alpha: start research. Beta: wait for research results. Gamma: prepare your test plan.' }) },
          { type: 'appendInbox', teamName: TEAM, agentName: 'agent-beta', entry: buildMessage({ from: 'team-lead', text: 'Welcome team! Alpha: start research. Beta: wait for research results. Gamma: prepare your test plan.' }) },
          { type: 'appendInbox', teamName: TEAM, agentName: 'agent-gamma', entry: buildMessage({ from: 'team-lead', text: 'Welcome team! Alpha: start research. Beta: wait for research results. Gamma: prepare your test plan.' }) },
        ],
      },
      // --- Event 7: Alpha working ---
      {
        label: 'Alpha sends progress update',
        delayAfterMs: 2000,
        actions: [
          { type: 'appendInbox', teamName: TEAM, agentName: 'team-lead', entry: buildMessage({ from: 'agent-alpha', text: 'Starting codebase analysis. Found 23 source files across 5 modules. Will document the key patterns.', summary: 'Starting codebase analysis', color: 'blue' }) },
        ],
      },
      // --- Event 8: Gamma plan request, lead rejects ---
      {
        label: 'Gamma submits plan; lead rejects',
        delayAfterMs: 2000,
        actions: [
          {
            type: 'appendInbox', teamName: TEAM, agentName: 'team-lead',
            entry: buildTypedMessage({
              from: 'agent-gamma',
              typed: {
                type: 'plan_approval_request',
                from: 'agent-gamma',
                requestId: 'plan-001',
                planFilePath: '~/.claude/plans/test-plan.md',
                planContent: '# Test Plan v1\n\n## Approach\n- Unit tests only\n- Skip integration tests\n- No E2E coverage',
                timestamp: new Date().toISOString(),
              },
              color: 'orange',
            }),
          },
          {
            type: 'appendInbox', teamName: TEAM, agentName: 'agent-gamma',
            entry: buildTypedMessage({
              from: 'team-lead',
              typed: {
                type: 'plan_approval_response',
                requestId: 'plan-001',
                approved: false,
                feedback: 'Please include integration tests. Unit tests alone are not sufficient for this feature.',
                timestamp: new Date().toISOString(),
              },
            }),
          },
        ],
      },
      // --- Event 9: Gamma revised plan approved ---
      {
        label: 'Gamma submits revised plan; lead approves',
        delayAfterMs: 2000,
        actions: [
          {
            type: 'appendInbox', teamName: TEAM, agentName: 'team-lead',
            entry: buildTypedMessage({
              from: 'agent-gamma',
              typed: {
                type: 'plan_approval_request',
                from: 'agent-gamma',
                requestId: 'plan-002',
                planFilePath: '~/.claude/plans/test-plan-v2.md',
                planContent: '# Test Plan v2\n\n## Approach\n- Unit tests for all modules\n- Integration tests for API layer\n- E2E smoke test for critical paths',
                timestamp: new Date().toISOString(),
              },
              color: 'orange',
            }),
          },
          {
            type: 'appendInbox', teamName: TEAM, agentName: 'agent-gamma',
            entry: buildTypedMessage({
              from: 'team-lead',
              typed: {
                type: 'plan_approval_response',
                requestId: 'plan-002',
                approved: true,
                timestamp: new Date().toISOString(),
                permissionMode: 'bypassPermissions',
              },
            }),
          },
        ],
      },
      // --- Event 10: Alpha completes task 1 ---
      {
        label: 'Alpha completes research (task 1)',
        delayAfterMs: 2000,
        actions: [
          { type: 'writeTask', teamName: TEAM, task: buildTask({ id: '1', subject: 'agent-alpha', description: 'Research existing codebase patterns and architecture', status: 'completed', blocks: ['2', '3'] }) },
          { type: 'appendInbox', teamName: TEAM, agentName: 'team-lead', entry: buildMessage({ from: 'agent-alpha', text: 'Research complete. Documented 5 patterns: Repository, Factory, Observer, Strategy, Decorator. All findings in /docs/architecture.md.', summary: 'Research complete, 5 patterns documented', color: 'blue' }) },
          // Peer DM: alpha tells beta results are ready
          { type: 'appendInbox', teamName: TEAM, agentName: 'agent-beta', entry: buildMessage({ from: 'agent-alpha', text: 'Research is done! Key finding: the codebase uses Repository pattern for data access. Check /docs/architecture.md for details.', summary: 'Research results ready', color: 'blue' }) },
        ],
      },
      // --- Event 11: Beta starts, permission request ---
      {
        label: 'Beta claims task 2; requests Bash permission',
        delayAfterMs: 2000,
        actions: [
          { type: 'writeTask', teamName: TEAM, task: buildTask({ id: '2', subject: 'agent-beta', description: 'Implement feature based on research findings', status: 'in_progress', blockedBy: ['1'], blocks: ['4'] }) },
          {
            type: 'appendInbox', teamName: TEAM, agentName: 'team-lead',
            entry: buildTypedMessage({
              from: 'agent-beta',
              typed: {
                type: 'permission_request',
                request_id: 'perm-001',
                agent_id: 'agent-beta',
                tool_name: 'Bash',
                tool_use_id: fakeUUID('perm-tool-001'),
                description: 'Claude wants to run: npm test',
                input: { command: 'npm test' },
                permission_suggestions: [],
              },
              color: 'green',
            }),
          },
          {
            type: 'appendInbox', teamName: TEAM, agentName: 'agent-beta',
            entry: buildTypedMessage({
              from: 'team-lead',
              typed: {
                type: 'permission_response',
                request_id: 'perm-001',
                approve: true,
              },
            }),
          },
        ],
      },
      // --- Event 12: Beta completes task 2, new task 5 ---
      {
        label: 'Beta completes task 2; new task 5 created',
        delayAfterMs: 2000,
        actions: [
          { type: 'writeTask', teamName: TEAM, task: buildTask({ id: '2', subject: 'agent-beta', description: 'Implement feature based on research findings', status: 'completed', blockedBy: ['1'], blocks: ['4'] }) },
          { type: 'writeTask', teamName: TEAM, task: buildTask({ id: '5', subject: 'agent-beta', description: 'Fix lint warnings introduced by new feature code', status: 'in_progress' }) },
          { type: 'appendInbox', teamName: TEAM, agentName: 'team-lead', entry: buildMessage({ from: 'agent-beta', text: 'Feature implementation complete. All tests pass. Found some lint warnings — created task 5 to clean them up.', summary: 'Feature done, cleaning lint', color: 'green' }) },
          { type: 'writeTask', teamName: TEAM, task: buildTask({ id: '3', subject: 'agent-gamma', description: 'Write test plan and initial test scaffolding', status: 'in_progress', blockedBy: ['1'] }) },
        ],
      },
      // --- Event 13: Final completions ---
      {
        label: 'All remaining tasks completed',
        delayAfterMs: 2000,
        actions: [
          { type: 'writeTask', teamName: TEAM, task: buildTask({ id: '3', subject: 'agent-gamma', description: 'Write test plan and initial test scaffolding', status: 'completed', blockedBy: ['1'] }) },
          { type: 'writeTask', teamName: TEAM, task: buildTask({ id: '4', subject: 'agent-gamma', description: 'Run full test suite and validate implementation', status: 'completed', blockedBy: ['2', '3'] }) },
          { type: 'writeTask', teamName: TEAM, task: buildTask({ id: '5', subject: 'agent-beta', description: 'Fix lint warnings introduced by new feature code', status: 'completed' }) },
          { type: 'appendInbox', teamName: TEAM, agentName: 'team-lead', entry: buildMessage({ from: 'agent-gamma', text: 'All tests passing: 42 unit tests, 8 integration tests, 2 E2E smoke tests. Coverage at 87%.', summary: 'All tests passing, 87% coverage', color: 'orange' }) },
          { type: 'appendInbox', teamName: TEAM, agentName: 'team-lead', entry: buildMessage({ from: 'agent-beta', text: 'Lint cleanup done. Zero warnings remaining.', summary: 'Lint clean', color: 'green' }) },
        ],
      },
      // --- Event 14: Shutdown sequence ---
      {
        label: 'Shutdown sequence (all 3 agents)',
        delayAfterMs: 2000,
        actions: [
          // Alpha shutdown
          {
            type: 'appendInbox', teamName: TEAM, agentName: 'agent-alpha',
            entry: buildTypedMessage({
              from: 'team-lead',
              typed: { type: 'shutdown_request', requestId: 'shut-alpha', from: 'team-lead', reason: 'All work complete', timestamp: new Date().toISOString() },
            }),
          },
          {
            type: 'appendInbox', teamName: TEAM, agentName: 'team-lead',
            entry: buildTypedMessage({
              from: 'agent-alpha',
              typed: { type: 'shutdown_approved', requestId: 'shut-alpha', from: 'agent-alpha', timestamp: new Date().toISOString(), paneId: 'in-process', backendType: 'in-process' },
              color: 'blue',
            }),
          },
          // Beta shutdown
          {
            type: 'appendInbox', teamName: TEAM, agentName: 'agent-beta',
            entry: buildTypedMessage({
              from: 'team-lead',
              typed: { type: 'shutdown_request', requestId: 'shut-beta', from: 'team-lead', reason: 'All work complete', timestamp: new Date().toISOString() },
            }),
          },
          {
            type: 'appendInbox', teamName: TEAM, agentName: 'team-lead',
            entry: buildTypedMessage({
              from: 'agent-beta',
              typed: { type: 'shutdown_approved', requestId: 'shut-beta', from: 'agent-beta', timestamp: new Date().toISOString(), paneId: 'in-process', backendType: 'in-process' },
              color: 'green',
            }),
          },
          // Gamma shutdown
          {
            type: 'appendInbox', teamName: TEAM, agentName: 'agent-gamma',
            entry: buildTypedMessage({
              from: 'team-lead',
              typed: { type: 'shutdown_request', requestId: 'shut-gamma', from: 'team-lead', reason: 'All work complete', timestamp: new Date().toISOString() },
            }),
          },
          {
            type: 'appendInbox', teamName: TEAM, agentName: 'team-lead',
            entry: buildTypedMessage({
              from: 'agent-gamma',
              typed: { type: 'shutdown_approved', requestId: 'shut-gamma', from: 'agent-gamma', timestamp: new Date().toISOString(), paneId: 'in-process', backendType: 'in-process' },
              color: 'orange',
            }),
          },
        ],
      },
      // --- Event 15: Team disappears ---
      {
        label: 'Team cleaned up (disappears)',
        delayAfterMs: 1000,
        actions: [
          { type: 'deleteTeam', teamName: TEAM },
        ],
      },
    ],
  };
}
