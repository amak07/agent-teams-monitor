import { Scenario } from './types';
import { buildConfig, buildTask, buildMessage, buildTypedMessage } from './helpers';

const TEAM = 'sim-quick';

export function createQuickSession(): Scenario {
  const config1 = buildConfig({
    name: TEAM,
    description: 'Quick bug fix session',
    members: [
      { name: 'team-lead', agentType: 'team-lead' },
    ],
  });

  const config2 = buildConfig({
    name: TEAM,
    description: 'Quick bug fix session',
    members: [
      { name: 'team-lead', agentType: 'team-lead' },
      { name: 'worker', color: 'blue', prompt: 'Fix the null pointer exception in PaymentService.' },
    ],
  });

  return {
    name: 'quick',
    description: 'Quick 5-step session (~10s): team, agent, tasks, messages, shutdown',
    teamNames: [TEAM],
    events: [
      {
        label: 'Team appears with lead only',
        delayAfterMs: 2000,
        actions: [
          { type: 'writeConfig', teamName: TEAM, config: config1 },
        ],
      },
      {
        label: 'Worker agent joins + 2 tasks created',
        delayAfterMs: 2000,
        actions: [
          { type: 'writeConfig', teamName: TEAM, config: config2 },
          {
            type: 'writeTask', teamName: TEAM,
            task: buildTask({
              id: '1', subject: 'worker',
              description: 'Investigate the null pointer exception in payment module',
              status: 'in_progress', blocks: ['2'],
            }),
          },
          {
            type: 'writeTask', teamName: TEAM,
            task: buildTask({
              id: '2', subject: 'worker',
              description: 'Add error handling for edge cases',
              status: 'pending', blockedBy: ['1'],
            }),
          },
        ],
      },
      {
        label: 'Worker sends progress message',
        delayAfterMs: 2000,
        actions: [
          {
            type: 'appendInbox', teamName: TEAM, agentName: 'team-lead',
            entry: buildMessage({
              from: 'worker',
              text: 'Found the bug. Null check missing in PaymentService.process(). Fixing now.',
              summary: 'Bug found, fixing',
              color: 'blue',
            }),
          },
        ],
      },
      {
        label: 'Worker completes + shutdown approved',
        delayAfterMs: 2000,
        actions: [
          {
            type: 'appendInbox', teamName: TEAM, agentName: 'team-lead',
            entry: buildMessage({
              from: 'worker',
              text: 'Fix applied and verified. Both tasks done.',
              summary: 'Fix complete',
              color: 'blue',
            }),
          },
          {
            type: 'writeTask', teamName: TEAM,
            task: buildTask({
              id: '1', subject: 'worker',
              description: 'Investigate the null pointer exception in payment module',
              status: 'completed', blocks: ['2'],
            }),
          },
          {
            type: 'writeTask', teamName: TEAM,
            task: buildTask({
              id: '2', subject: 'worker',
              description: 'Add error handling for edge cases',
              status: 'completed', blockedBy: ['1'],
            }),
          },
          {
            type: 'appendInbox', teamName: TEAM, agentName: 'team-lead',
            entry: buildTypedMessage({
              from: 'worker',
              typed: {
                type: 'shutdown_approved',
                requestId: 'shut-001',
                from: 'worker',
                timestamp: new Date().toISOString(),
                paneId: 'in-process',
                backendType: 'in-process',
              },
              color: 'blue',
            }),
          },
        ],
      },
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
