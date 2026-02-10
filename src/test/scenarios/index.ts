import { Scenario } from './types';
import { createQuickSession } from './quickSession';
import { createFullLifecycle } from './fullLifecycle';

/** All available scenarios, keyed by name. Factory functions for fresh timestamps. */
export function getScenarios(): Map<string, () => Scenario> {
  return new Map([
    ['quick', createQuickSession],
    ['lifecycle', createFullLifecycle],
  ]);
}

/** All known test team names (used by cleanup script for safe deletion) */
export const TEST_TEAM_NAMES = ['sim-quick', 'sim-lifecycle'];

/** Mock data team names from mockData.ts (also cleaned by simulate:clean) */
export const MOCK_TEAM_NAMES = ['test-team', 'data-pipeline', 'quick-fix'];
