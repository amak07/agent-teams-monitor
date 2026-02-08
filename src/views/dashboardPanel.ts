import * as vscode from 'vscode';
import { TeamStateManager } from '../state/teamState';
import { TeamConfig, AgentTask, InboxEntry, isTeamLead, parseTypedMessage } from '../types';

// Map agent color names to hex for webview rendering
const COLOR_HEX: Record<string, string> = {
  blue: '#4a9eff',
  green: '#4ec94e',
  red: '#f44747',
  yellow: '#e5c07b',
  orange: '#d19a66',
  purple: '#c678dd',
};

const LEAD_COLOR = '#e5c07b'; // gold

function statusIcon(status: string): string {
  switch (status) {
    case 'completed': return '\u2705';
    case 'in_progress': return '\uD83D\uDD04';
    case 'pending': return '\u25CB';
    default: return '\u25CB';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'completed': return 'done';
    case 'in_progress': return 'active';
    case 'pending': return 'pending';
    default: return status;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export class DashboardPanel {
  private static instance: DashboardPanel | undefined;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private state: TeamStateManager
  ) {
    this.panel = panel;

    // Listen for state changes
    const sub = state.onDidChange(() => this.update());
    this.disposables.push(sub);

    // Handle webview messages (clicks on tasks/messages)
    panel.webview.onDidReceiveMessage(msg => {
      if (msg.command === 'showMessage') {
        vscode.commands.executeCommand('agentTeams.showMessage', msg.entry);
      } else if (msg.command === 'showTask') {
        vscode.commands.executeCommand('agentTeams.showTask', msg.task);
      }
    }, undefined, this.disposables);

    // Clean up on close
    panel.onDidDispose(() => {
      DashboardPanel.instance = undefined;
      for (const d of this.disposables) { d.dispose(); }
      this.disposables = [];
    }, undefined, this.disposables);

    this.update();
  }

  static createOrShow(state: TeamStateManager): void {
    if (DashboardPanel.instance) {
      DashboardPanel.instance.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'agentTeamsDashboard',
      'Agent Teams Dashboard',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    DashboardPanel.instance = new DashboardPanel(panel, state);
  }

  update(): void {
    this.panel.webview.html = this.getHtml();
  }

  private getHtml(): string {
    const nonce = getNonce();
    const teams = this.state.getFilteredTeams();
    const allTasks = this.state.getFilteredTasks();
    const allMessages = this.state.getFilteredMessages();

    let teamsHtml = '';
    if (teams.length === 0) {
      teamsHtml = '<div class="empty">No Agent Teams detected. Start an Agent Team in Claude Code to see it here.</div>';
    }

    for (const team of teams) {
      const tasks = allTasks.get(team.name) ?? [];
      const teamMsgs = allMessages.get(team.name);
      const messages = this.collectMessages(team.name, teamMsgs);

      teamsHtml += this.renderTeam(team, tasks, messages);
    }

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Teams Dashboard</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px 24px;
      margin: 0;
      line-height: 1.5;
    }
    h1 {
      font-size: 1.4em;
      font-weight: 600;
      margin: 0 0 16px 0;
      color: var(--vscode-foreground);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    h1 .icon { opacity: 0.7; }
    .team-section {
      margin-bottom: 24px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      overflow: hidden;
    }
    .team-header {
      background: var(--vscode-sideBar-background);
      padding: 10px 16px;
      font-weight: 600;
      font-size: 1.1em;
      display: flex;
      align-items: center;
      gap: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .team-header .agent-count {
      font-weight: 400;
      opacity: 0.7;
      font-size: 0.9em;
    }
    .team-body {
      display: grid;
      grid-template-columns: 240px 1fr;
      min-height: 100px;
    }
    .agents-col {
      padding: 12px 16px;
      border-right: 1px solid var(--vscode-panel-border);
    }
    .tasks-col {
      padding: 12px 16px;
    }
    .section-label {
      text-transform: uppercase;
      font-size: 0.75em;
      font-weight: 600;
      letter-spacing: 0.05em;
      opacity: 0.6;
      margin-bottom: 8px;
    }
    .agent-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 0;
    }
    .color-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .agent-name {
      font-weight: 500;
    }
    .agent-meta {
      font-size: 0.85em;
      opacity: 0.6;
      margin-left: auto;
    }
    .task-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 3px 0;
      cursor: pointer;
      border-radius: 3px;
      padding-left: 4px;
      margin-left: -4px;
    }
    .task-row:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .task-id {
      opacity: 0.5;
      font-size: 0.85em;
      min-width: 28px;
    }
    .task-agent {
      font-size: 0.85em;
      opacity: 0.7;
      font-weight: 500;
    }
    .task-desc {
      flex: 1;
    }
    .status-badge {
      font-size: 0.75em;
      padding: 1px 6px;
      border-radius: 3px;
      font-weight: 500;
    }
    .status-completed {
      background: rgba(78, 201, 78, 0.15);
      color: #4ec94e;
    }
    .status-in_progress {
      background: rgba(74, 158, 255, 0.15);
      color: #4a9eff;
    }
    .status-pending {
      background: rgba(255, 255, 255, 0.08);
      color: var(--vscode-descriptionForeground);
    }
    .blocked-info {
      font-size: 0.8em;
      opacity: 0.5;
      margin-left: 4px;
    }
    .messages-section {
      padding: 12px 16px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .msg-row {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 6px 4px;
      cursor: pointer;
      border-radius: 3px;
      margin: 0 -4px;
    }
    .msg-row:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .msg-time {
      font-size: 0.8em;
      opacity: 0.5;
      min-width: 52px;
      flex-shrink: 0;
    }
    .msg-badge {
      font-size: 0.7em;
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .badge-permission { background: rgba(255, 165, 0, 0.15); color: #e5a033; }
    .badge-approved { background: rgba(78, 201, 78, 0.15); color: #4ec94e; }
    .badge-denied { background: rgba(244, 71, 71, 0.15); color: #f44747; }
    .badge-idle { background: rgba(255, 255, 255, 0.08); color: var(--vscode-descriptionForeground); }
    .badge-shutdown { background: rgba(244, 71, 71, 0.15); color: #f44747; }
    .badge-plan { background: rgba(198, 120, 221, 0.15); color: #c678dd; }
    .badge-system { background: rgba(255, 255, 255, 0.08); color: var(--vscode-descriptionForeground); }
    .msg-from {
      font-weight: 500;
      flex-shrink: 0;
    }
    .msg-arrow {
      opacity: 0.4;
      flex-shrink: 0;
    }
    .msg-to {
      opacity: 0.7;
      flex-shrink: 0;
    }
    .msg-text {
      flex: 1;
      opacity: 0.8;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .empty {
      padding: 32px;
      text-align: center;
      opacity: 0.6;
    }
  </style>
</head>
<body>
  <h1><span class="icon">\uD83D\uDC65</span> Agent Teams Dashboard</h1>
  ${teamsHtml}

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    document.addEventListener('click', (e) => {
      const taskEl = e.target.closest('[data-task]');
      if (taskEl) {
        const task = JSON.parse(taskEl.dataset.task);
        vscode.postMessage({ command: 'showTask', task });
        return;
      }
      const msgEl = e.target.closest('[data-message]');
      if (msgEl) {
        const entry = JSON.parse(msgEl.dataset.message);
        vscode.postMessage({ command: 'showMessage', entry });
        return;
      }
    });
  </script>
</body>
</html>`;
  }

  private renderTeam(
    team: TeamConfig,
    tasks: AgentTask[],
    messages: { entry: InboxEntry; inboxOwner: string }[]
  ): string {
    const agentCount = team.members.length;

    // Agents column
    let agentsHtml = '';
    for (const member of team.members) {
      const lead = isTeamLead(member);
      const color = lead ? LEAD_COLOR : (member.color ? COLOR_HEX[member.color] || '#888' : '#888');
      const meta = lead ? 'lead' : (member.agentType || '');
      agentsHtml += `
        <div class="agent-row">
          <span class="color-dot" style="background:${color}"></span>
          <span class="agent-name">${escapeHtml(member.name)}</span>
          <span class="agent-meta">${escapeHtml(meta)}</span>
        </div>`;
    }

    // Tasks column
    let tasksHtml = '';
    if (tasks.length === 0) {
      tasksHtml = '<div style="opacity:0.5;padding:4px 0">No tasks</div>';
    }
    for (const task of tasks) {
      const blocked = task.blockedBy.length > 0 ? `<span class="blocked-info">blocked by #${task.blockedBy.join(', #')}</span>` : '';
      const dataAttr = escapeHtml(JSON.stringify(task));
      tasksHtml += `
        <div class="task-row" data-task="${dataAttr}">
          <span class="task-id">#${escapeHtml(task.id)}</span>
          <span class="task-agent">${escapeHtml(task.subject)}</span>
          <span class="task-desc">${escapeHtml(task.description)}</span>
          <span class="status-badge status-${task.status}">${statusLabel(task.status)}</span>
          ${blocked}
        </div>`;
    }

    // Messages
    let messagesHtml = '';
    if (messages.length === 0) {
      messagesHtml = '<div style="opacity:0.5;padding:4px 0">No messages</div>';
    }
    // Show newest first, limit to 50
    const sorted = messages
      .sort((a, b) => b.entry.timestamp.localeCompare(a.entry.timestamp))
      .slice(0, 50);

    for (const { entry, inboxOwner } of sorted) {
      const time = formatTime(entry.timestamp);
      const typed = parseTypedMessage(entry.text);
      const dataAttr = escapeHtml(JSON.stringify(entry));

      let badgeHtml = '';
      let preview = '';
      if (typed) {
        const { badgeClass, badgeText } = getTypedBadge(typed);
        badgeHtml = `<span class="msg-badge ${badgeClass}">${badgeText}</span>`;
        preview = entry.summary || '';
      } else {
        preview = entry.summary || entry.text.slice(0, 120).replace(/\n/g, ' ');
      }

      messagesHtml += `
        <div class="msg-row" data-message="${dataAttr}">
          <span class="msg-time">${time}</span>
          ${badgeHtml}
          <span class="msg-from">${escapeHtml(entry.from)}</span>
          <span class="msg-arrow">\u2192</span>
          <span class="msg-to">${escapeHtml(inboxOwner)}</span>
          <span class="msg-text">${escapeHtml(preview)}</span>
        </div>`;
    }

    return `
    <div class="team-section">
      <div class="team-header">
        ${escapeHtml(team.name)}
        <span class="agent-count">${agentCount} agent${agentCount !== 1 ? 's' : ''}</span>
      </div>
      <div class="team-body">
        <div class="agents-col">
          <div class="section-label">Agents</div>
          ${agentsHtml}
        </div>
        <div class="tasks-col">
          <div class="section-label">Tasks</div>
          ${tasksHtml}
        </div>
      </div>
      <div class="messages-section">
        <div class="section-label">Messages</div>
        ${messagesHtml}
      </div>
    </div>`;
  }

  private collectMessages(
    teamName: string,
    teamMsgs: Map<string, InboxEntry[]> | undefined
  ): { entry: InboxEntry; inboxOwner: string }[] {
    if (!teamMsgs) { return []; }
    const result: { entry: InboxEntry; inboxOwner: string }[] = [];
    for (const [agentName, entries] of teamMsgs) {
      for (const entry of entries) {
        result.push({ entry, inboxOwner: agentName });
      }
    }
    return result;
  }
}

function getTypedBadge(typed: { type: string; approve?: boolean }): { badgeClass: string; badgeText: string } {
  switch (typed.type) {
    case 'permission_request':
      return { badgeClass: 'badge-permission', badgeText: 'permission' };
    case 'permission_response':
      return typed.approve
        ? { badgeClass: 'badge-approved', badgeText: 'approved' }
        : { badgeClass: 'badge-denied', badgeText: 'denied' };
    case 'idle_notification':
      return { badgeClass: 'badge-idle', badgeText: 'idle' };
    case 'shutdown_request':
      return { badgeClass: 'badge-shutdown', badgeText: 'shutdown' };
    case 'shutdown_approved':
      return { badgeClass: 'badge-shutdown', badgeText: 'shutdown ok' };
    case 'plan_approval_request':
      return { badgeClass: 'badge-plan', badgeText: 'plan review' };
    default:
      return { badgeClass: 'badge-system', badgeText: 'system' };
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
