import { TeamMember, isTeamLead } from './types';

export function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export function deriveTeamStatus(
  lifecycleStates: Map<string, string>,
  members: TeamMember[]
): 'active' | 'winding_down' | 'completed' {
  const nonLeadLifecycles = [...lifecycleStates.entries()]
    .filter(([name]) => !members.find(m => isTeamLead(m) && m.name === name))
    .map(([, state]) => state);
  if (nonLeadLifecycles.length > 0 && nonLeadLifecycles.every(s => s === 'shutdown')) {
    return 'completed';
  }
  if (nonLeadLifecycles.some(s => s === 'shutting_down' || s === 'shutdown')) {
    return 'winding_down';
  }
  return 'active';
}
