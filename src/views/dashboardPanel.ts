import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
import { TeamStateManager } from '../state/teamState';
import { TeamConfig, TeamMember, AgentTask, InboxEntry, isTeamLead, parseTypedMessage } from '../types';
import { formatTime, deriveTeamStatus } from '../utils';

const md = new MarkdownIt({ html: false, breaks: true, linkify: true });

// Valid agent color names (used for CSS class mapping)
const AGENT_COLORS = new Set(['blue', 'green', 'red', 'yellow', 'orange', 'purple']);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


/** Returns a CSS class suffix: 'blue', 'green', 'lead', 'unknown', etc. */
function getMemberColorName(member: TeamMember): string {
  if (isTeamLead(member)) { return 'lead'; }
  return member.color && AGENT_COLORS.has(member.color) ? member.color : 'unknown';
}

/** Returns a CSS class suffix from an inbox entry's color field */
function getFromColorName(entry: InboxEntry): string {
  return entry.color && AGENT_COLORS.has(entry.color) ? entry.color : 'unknown';
}

export class DashboardPanel {
  private static instance: DashboardPanel | undefined;
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private _initialized = false;
  private _webviewReady = false;
  private _pendingScrollTo: { type: 'task' | 'message'; id: string; team: string } | undefined;

  private constructor(
    panel: vscode.WebviewPanel,
    private state: TeamStateManager
  ) {
    this.panel = panel;

    const sub = state.onDidChange(() => this.debouncedUpdate());
    this.disposables.push(sub);

    panel.webview.onDidReceiveMessage(msg => {
      if (msg.command === 'refresh') {
        vscode.commands.executeCommand('agentTeams.refresh');
      }
      if (msg.command === 'ready') {
        this._webviewReady = true;
        // Push fresh data to close race between getHtml() snapshot and state changes
        this.panel.webview.postMessage({
          command: 'updateData',
          data: this.getDataPayload(),
        });
        if (this._pendingScrollTo) {
          const p = this._pendingScrollTo;
          this._pendingScrollTo = undefined;
          this.panel.webview.postMessage({ command: 'scrollTo', type: p.type, id: p.id, team: p.team });
        }
      }
      if (msg.command === 'replayTeam') {
        vscode.commands.executeCommand('agentTeams.replaySession');
      }
      if (msg.command === 'cleanTeam' && msg.teamName) {
        vscode.commands.executeCommand('agentTeams.cleanTeam', { config: { name: msg.teamName } });
      }
    }, undefined, this.disposables);

    panel.onDidDispose(() => {
      DashboardPanel.instance = undefined;
      if (this.updateTimer) { clearTimeout(this.updateTimer); }
      for (const d of this.disposables) { d.dispose(); }
      this.disposables = [];
    }, undefined, this.disposables);

    this.update();
  }

  static createOrShow(state: TeamStateManager): DashboardPanel {
    if (DashboardPanel.instance) {
      DashboardPanel.instance.panel.reveal(vscode.ViewColumn.One);
      return DashboardPanel.instance;
    }

    const panel = vscode.window.createWebviewPanel(
      'agentTeamsDashboard',
      'Agent Teams Dashboard',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    DashboardPanel.instance = new DashboardPanel(panel, state);
    return DashboardPanel.instance;
  }

  /** Scroll to and expand a specific task or message in the dashboard */
  scrollTo(type: 'task' | 'message', id: string, teamName: string): void {
    this.panel.reveal(vscode.ViewColumn.One);
    if (this._webviewReady) {
      this.panel.webview.postMessage({ command: 'scrollTo', type, id, team: teamName });
    } else {
      // Queue until webview signals ready
      this._pendingScrollTo = { type, id, team: teamName };
    }
  }

  /** Debounce updates to avoid excessive re-renders destroying UI state */
  private debouncedUpdate(): void {
    if (this.updateTimer) { clearTimeout(this.updateTimer); }
    this.updateTimer = setTimeout(() => this.update(), 300);
  }

  update(): void {
    if (!this._initialized) {
      // First render: full HTML
      this.panel.webview.html = this.getHtml();
      this._initialized = true;
    } else {
      // Subsequent updates: send data via postMessage, let webview patch DOM
      this.panel.webview.postMessage({
        command: 'updateData',
        data: this.getDataPayload(),
      });
    }
  }

  private getDataPayload(): object {
    const teams = this.state.getFilteredTeams();
    const allTasks = this.state.getFilteredTasks();
    const allMessages = this.state.getFilteredMessages();

    return {
      replayMode: this.state.replayMode,
      teams: teams.map(team => {
        const tasks = allTasks.get(team.name) ?? [];
        const teamMsgs = allMessages.get(team.name);
        const messages = this.collectMessages(teamMsgs);
        const lifecycleStates = this.state.getAgentLifecycleStates(team.name);

        // Build agent color map for this team
        const memberColors: Record<string, string> = {};
        for (const m of team.members) {
          memberColors[m.name] = getMemberColorName(m);
        }

        const completed = tasks.filter(t =>
          this.state.getEffectiveTaskStatus(team.name, t) === 'completed'
        ).length;

        const teamStatus = deriveTeamStatus(lifecycleStates, team.members);

        return {
          name: team.name,
          memberCount: team.members.length,
          completedTasks: completed,
          totalTasks: tasks.length,
          teamStatus,
          members: team.members.map(m => {
            const colorName = getMemberColorName(m);
            const lead = isTeamLead(m);
            const lifecycle = lifecycleStates.get(m.name) || 'active';
            const model = m.model.length > 30 ? m.model.slice(0, 25) + '...' : m.model;
            return { name: m.name, colorName, lead, lifecycle, model };
          }),
          tasks: tasks.map(t => {
            const effectiveStatus = this.state.getEffectiveTaskStatus(team.name, t);
            const blockedBy = t.blockedBy ?? [];
            const blocks = t.blocks ?? [];
            const blocked = blockedBy.length > 0 && t.status === 'pending';
            const statusClass = blocked ? 'blocked' : effectiveStatus;
            const badgeLabel = blocked ? 'blocked' : (effectiveStatus === 'in_progress' ? 'active' : (effectiveStatus === 'completed' ? 'done' : 'pending'));
            const agentColorName = memberColors[t.subject] || 'unknown';
            const member = team.members.find(m => m.name === t.subject);
            const fullPrompt = member?.prompt || t.description || '';
            return {
              id: t.id, subject: t.subject, description: t.description || '',
              fullPromptHtml: formatPromptHtml(fullPrompt),
              statusClass, badgeLabel, agentColorName,
              blockedBy, blocks,
              teamName: team.name,
            };
          }),
          messages: messages
            .sort((a, b) => b.entry.timestamp.localeCompare(a.entry.timestamp))
            .slice(0, 50)
            .map(({ entry, inboxOwner }) => {
              const fromColor = getFromColorName(entry);
              const typed = parseTypedMessage(entry.text);
              let badgeClass = '', badgeText = '', preview = '', fullText = '';

              if (typed) {
                const badge = getTypedBadge(typed);
                badgeClass = badge.badgeClass;
                badgeText = badge.badgeText;
                preview = entry.summary || getTypedPreview(typed);
                fullText = JSON.stringify(typed, null, 2);
              } else {
                preview = entry.summary || entry.text.slice(0, 100).replace(/\n/g, ' ');
                if (preview.length < entry.text.length && !entry.summary) { preview += '...'; }
                fullText = entry.text;
              }

              return {
                id: `${entry.from}-${entry.timestamp}`,
                from: entry.from, to: inboxOwner,
                time: formatTime(entry.timestamp),
                fromColor, badgeClass, badgeText,
                preview, fullText, isTyped: !!typed,
                fullTextHtml: typed ? '' : formatPromptHtml(entry.text),
                teamName: team.name,
              };
            }),
        };
      }),
    };
  }

  private getHtml(): string {
    const nonce = getNonce();
    const teams = this.state.getFilteredTeams();
    const allTasks = this.state.getFilteredTasks();
    const allMessages = this.state.getFilteredMessages();

    // Build color map: agentName → color class name (across all teams)
    const agentColorMap = new Map<string, string>();
    for (const team of teams) {
      for (const m of team.members) {
        agentColorMap.set(m.name, getMemberColorName(m));
      }
    }

    // Build team option list for filter
    const teamOptions = teams.map(t =>
      `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)}</option>`
    ).join('');

    let teamsHtml = '';
    if (teams.length === 0) {
      teamsHtml = `<div class="empty-state">
        <div class="empty-icon">${SVG_ICONS.agents}</div>
        <div class="empty-title">No Agent Teams Detected</div>
        <div class="empty-text">Start an Agent Team in Claude Code to see it here.</div>
      </div>`;
    }

    for (const team of teams) {
      const tasks = allTasks.get(team.name) ?? [];
      const teamMsgs = allMessages.get(team.name);
      const messages = this.collectMessages(teamMsgs);
      teamsHtml += this.renderTeam(team, tasks, messages, agentColorMap);
    }

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Agent Teams Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      line-height: 1.5;

      /* Status colors (dark theme defaults) */
      --atm-status-green: #4ec94e;
      --atm-status-blue: #4a9eff;
      --atm-status-yellow: #e5c07b;
      --atm-status-red: #f44747;
      --atm-status-orange: #e5a033;
      --atm-status-purple: #c678dd;
      --atm-overlay-subtle: rgba(255,255,255,0.08);

      /* Agent colors (dark theme defaults) */
      --atm-agent-blue: #4a9eff;
      --atm-agent-green: #4ec94e;
      --atm-agent-red: #f44747;
      --atm-agent-yellow: #e5c07b;
      --atm-agent-orange: #d19a66;
      --atm-agent-purple: #c678dd;
      --atm-agent-lead: #e5c07b;
    }

    body.vscode-light {
      --atm-status-green: #2e8b2e;
      --atm-status-blue: #1a6fd1;
      --atm-status-yellow: #9c7a1e;
      --atm-status-red: #c72020;
      --atm-status-orange: #b07a15;
      --atm-status-purple: #8b4dab;
      --atm-overlay-subtle: rgba(0,0,0,0.06);

      --atm-agent-blue: #1a6fd1;
      --atm-agent-green: #2e8b2e;
      --atm-agent-red: #c72020;
      --atm-agent-yellow: #9c7a1e;
      --atm-agent-orange: #a06020;
      --atm-agent-purple: #8b4dab;
      --atm-agent-lead: #9c7a1e;
    }

    body.vscode-high-contrast {
      --atm-status-green: #73e673;
      --atm-status-blue: #6cb6ff;
      --atm-status-yellow: #ffd700;
      --atm-status-red: #ff6b6b;
      --atm-status-orange: #ffaa33;
      --atm-status-purple: #d9a0f0;
      --atm-overlay-subtle: rgba(255,255,255,0.12);

      --atm-agent-blue: #6cb6ff;
      --atm-agent-green: #73e673;
      --atm-agent-red: #ff6b6b;
      --atm-agent-yellow: #ffd700;
      --atm-agent-orange: #ffaa33;
      --atm-agent-purple: #d9a0f0;
      --atm-agent-lead: #ffd700;
    }

    /* ===== Toolbar ===== */
    .toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 20px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .toolbar-title {
      font-size: 1.15em;
      font-weight: 600;
      flex: 1;
    }
    .toolbar-controls {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .toolbar select {
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 4px;
      padding: 4px 24px 4px 8px;
      font-size: var(--vscode-font-size);
      font-family: var(--vscode-font-family);
      cursor: pointer;
      outline: none;
      -webkit-appearance: none;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 8px center;
    }
    .toolbar select:focus {
      border-color: var(--vscode-focusBorder);
    }
    .icon-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      border-radius: 4px;
      cursor: pointer;
      opacity: 0.7;
      transition: opacity 150ms, background 150ms;
    }
    .icon-btn:hover {
      opacity: 1;
      background: var(--vscode-toolbar-hoverBackground);
    }
    .icon-btn:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .icon-btn svg {
      width: 16px;
      height: 16px;
    }

    /* ===== Content ===== */
    .content {
      padding: 16px 20px 40px;
    }

    /* ===== Empty State ===== */
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      opacity: 0.7;
    }
    .empty-icon { margin-bottom: 12px; }
    .empty-icon svg { width: 48px; height: 48px; opacity: 0.4; }
    .empty-title { font-size: 1.1em; font-weight: 600; margin-bottom: 4px; }
    .empty-text { font-size: 0.9em; opacity: 0.7; }

    /* ===== Team Card ===== */
    .team-card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      margin-bottom: 16px;
      overflow: hidden;
    }
    .team-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      background: var(--vscode-sideBar-background);
      cursor: pointer;
      user-select: none;
      transition: background 150ms;
    }
    .team-header:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .team-header:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .chevron {
      transition: transform 200ms;
      opacity: 0.5;
      flex-shrink: 0;
    }
    .chevron.collapsed {
      transform: rotate(-90deg);
    }
    .team-name {
      font-weight: 600;
      font-size: 1.05em;
    }
    .team-stats {
      margin-left: auto;
      font-size: 0.85em;
      display: flex;
      gap: 6px;
      align-items: center;
    }
    .team-stats > span {
      opacity: 0.8;
    }
    .team-status-badge {
      font-size: 0.75em;
      padding: 1px 7px;
      border-radius: 3px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .team-status-badge.ts-completed {
      background: color-mix(in srgb, var(--atm-status-green) 15%, transparent);
      color: var(--atm-status-green);
    }
    .team-status-badge.ts-winding-down {
      background: color-mix(in srgb, var(--atm-status-orange) 15%, transparent);
      color: var(--atm-status-orange);
    }
    .team-status-badge.ts-active {
      background: color-mix(in srgb, var(--atm-status-blue) 15%, transparent);
      color: var(--atm-status-blue);
    }
    .team-actions {
      display: flex;
      gap: 2px;
      margin-left: 8px;
      flex-shrink: 0;
    }
    .team-action-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      border-radius: 4px;
      cursor: pointer;
      opacity: 0.5;
      transition: opacity 150ms, background 150ms;
    }
    .team-action-btn:hover {
      opacity: 1;
      background: var(--vscode-toolbar-hoverBackground);
    }
    .team-action-btn svg {
      width: 14px;
      height: 14px;
    }
    .team-body {
      overflow: hidden;
      transition: max-height 200ms ease;
    }
    .team-body.collapsed {
      max-height: 0 !important;
    }

    /* ===== Agent Strip ===== */
    .agent-strip {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .agent-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 0.85em;
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-focusBorder);
    }
    .agent-chip.shutdown {
      /* Full opacity — SHUTDOWN badge communicates status */
    }
    .agent-chip .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .agent-chip .lead-star {
      font-size: 0.75em;
      margin-right: -2px;
    }
    .agent-chip .model {
      opacity: 0.6;
      font-size: 0.9em;
    }
    .agent-status-badge {
      font-size: 0.65em;
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      background: var(--atm-overlay-subtle);
      color: var(--vscode-descriptionForeground);
    }

    /* ===== Section Headers ===== */
    .section-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      font-size: 0.8em;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      opacity: 0.55;
    }
    .progress-track {
      flex: 1;
      max-width: 120px;
      height: 4px;
      border-radius: 2px;
      background: var(--vscode-progressBar-background);
      opacity: 0.3;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      border-radius: 2px;
      background: var(--atm-status-green);
      transition: width 300ms;
    }
    .section-count {
      font-weight: 400;
    }

    /* ===== Task List ===== */
    .task-list {
      padding: 0 16px 12px;
    }
    .task-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 6px 8px;
      cursor: pointer;
      border-radius: 4px;
      transition: background 150ms;
    }
    .task-row:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .task-row:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    /* Status dots (CSS only, no emoji) */
    .status-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      flex-shrink: 0;
      margin-top: 4px;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .status-dot.completed {
      background: var(--atm-status-green);
    }
    .status-dot.completed::after {
      content: '';
      display: block;
      width: 3px;
      height: 6px;
      border: solid white;
      border-width: 0 1.5px 1.5px 0;
      transform: rotate(45deg);
      margin-top: -1px;
    }
    .status-dot.in_progress {
      background: var(--atm-status-blue);
      animation: pulse 2s ease-in-out infinite;
    }
    .status-dot.pending {
      background: transparent;
      border: 1.5px solid var(--vscode-descriptionForeground);
    }
    .status-dot.blocked {
      background: var(--atm-status-yellow);
    }
    .status-dot.blocked::after {
      content: '';
      display: block;
      width: 5px;
      height: 6px;
      border: 1.5px solid white;
      border-radius: 2px 2px 0 0;
      border-bottom: none;
      margin-top: -2px;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .task-content {
      flex: 1;
      min-width: 0;
    }
    .task-chevron {
      font-size: 0.7em;
      opacity: 0.4;
      transition: transform 200ms;
      flex-shrink: 0;
      display: inline-block;
      margin-top: 4px;
    }
    .task-row[aria-expanded="true"] .task-chevron {
      transform: rotate(90deg);
      opacity: 0.7;
    }
    .task-row[aria-expanded="true"] {
      background: var(--atm-overlay-subtle);
    }
    .task-header {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .task-id {
      font-size: 0.8em;
      opacity: 0.45;
      font-weight: 600;
    }
    .task-agent {
      font-size: 0.85em;
      font-weight: 500;
    }
    .task-desc-preview {
      font-size: 0.9em;
      opacity: 0.75;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 100%;
    }
    .status-badge {
      font-size: 0.7em;
      padding: 1px 6px;
      border-radius: 3px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      white-space: nowrap;
      margin-left: auto;
    }
    .status-badge.completed { background: color-mix(in srgb, var(--atm-status-green) 15%, transparent); color: var(--atm-status-green); }
    .status-badge.in_progress { background: color-mix(in srgb, var(--atm-status-blue) 15%, transparent); color: var(--atm-status-blue); }
    .status-badge.pending { background: var(--atm-overlay-subtle); color: var(--vscode-descriptionForeground); }
    .status-badge.blocked { background: color-mix(in srgb, var(--atm-status-yellow) 15%, transparent); color: var(--atm-status-yellow); }

    /* Task detail (accordion) */
    .task-detail {
      max-height: 0;
      overflow: hidden;
      transition: max-height 200ms ease, padding 200ms ease;
      padding: 0 8px 0 28px;
    }
    .task-detail.expanded {
      max-height: 300px;
      min-height: 40px;
      overflow-y: auto;
      padding: 8px 8px 12px 28px;
      background: color-mix(in srgb, var(--vscode-editor-background) 50%, var(--vscode-sideBar-background, transparent));
      border-left: 3px solid var(--vscode-panel-border);
      margin-left: 8px;
      margin-bottom: 4px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .task-detail-desc {
      font-size: 0.9em;
      line-height: 1.6;
      word-wrap: break-word;
      overflow-wrap: break-word;
      opacity: 0.85;
      margin-bottom: 6px;
    }
    .task-detail-desc strong {
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .task-deps {
      font-size: 0.8em;
      opacity: 0.5;
    }

    /* ===== Message Feed ===== */
    .message-feed {
      padding: 0 16px 12px;
    }
    .msg-row {
      display: flex;
      gap: 0;
      cursor: pointer;
      border-radius: 4px;
      margin-bottom: 2px;
      transition: background 150ms;
      overflow: hidden;
    }
    .msg-row:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .msg-row:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .msg-color-bar {
      width: 3px;
      flex-shrink: 0;
      border-radius: 3px 0 0 3px;
    }
    .msg-body-wrap {
      flex: 1;
      padding: 5px 10px;
      min-width: 0;
    }
    .msg-header {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .msg-chevron {
      font-size: 0.7em;
      opacity: 0.4;
      transition: transform 200ms;
      flex-shrink: 0;
      display: inline-block;
    }
    .msg-row[aria-expanded="true"] .msg-chevron {
      transform: rotate(90deg);
      opacity: 0.7;
    }
    .msg-row[aria-expanded="true"] {
      background: var(--atm-overlay-subtle);
    }
    .msg-from {
      font-weight: 500;
      font-size: 0.9em;
    }
    .msg-arrow {
      opacity: 0.35;
      font-size: 0.85em;
    }
    .msg-to {
      opacity: 0.6;
      font-size: 0.9em;
    }
    .msg-badge {
      font-size: 0.65em;
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .badge-permission { background: color-mix(in srgb, var(--atm-status-orange) 15%, transparent); color: var(--atm-status-orange); }
    .badge-approved { background: color-mix(in srgb, var(--atm-status-green) 15%, transparent); color: var(--atm-status-green); }
    .badge-denied { background: color-mix(in srgb, var(--atm-status-red) 15%, transparent); color: var(--atm-status-red); }
    .badge-idle { background: var(--atm-overlay-subtle); color: var(--vscode-descriptionForeground); }
    .badge-shutdown { background: color-mix(in srgb, var(--atm-status-red) 15%, transparent); color: var(--atm-status-red); }
    .badge-plan { background: color-mix(in srgb, var(--atm-status-purple) 15%, transparent); color: var(--atm-status-purple); }
    .badge-system { background: var(--atm-overlay-subtle); color: var(--vscode-descriptionForeground); }

    .msg-time {
      margin-left: auto;
      font-size: 0.75em;
      opacity: 0.4;
      white-space: nowrap;
    }
    .msg-preview {
      font-size: 0.85em;
      opacity: 0.6;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Message detail (accordion) */
    .msg-detail {
      max-height: 0;
      overflow: hidden;
      transition: max-height 200ms ease, padding 200ms ease;
      padding: 0 10px 0 10px;
    }
    .msg-detail.expanded {
      max-height: 400px;
      min-height: 60px;
      overflow-y: auto;
      padding: 8px 10px 10px 10px;
      background: color-mix(in srgb, var(--vscode-editor-background) 50%, var(--vscode-sideBar-background, transparent));
      border-left: 3px solid var(--vscode-panel-border);
      margin-left: 3px;
      margin-bottom: 4px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .msg-detail-text {
      font-size: 0.85em;
      line-height: 1.6;
      word-wrap: break-word;
      overflow-wrap: break-word;
      max-width: 70ch;
      opacity: 0.8;
      border-top: 1px solid var(--vscode-panel-border);
      padding-top: 6px;
    }
    .msg-detail-text pre {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      background: var(--vscode-textCodeBlock-background);
      padding: 8px;
      border-radius: 4px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    /* ===== Markdown content styles (from markdown-it) ===== */
    .task-detail-desc p, .msg-detail-text p,
    .task-desc-preview p {
      margin: 0 0 8px 0;
    }
    .task-detail-desc p:last-child, .msg-detail-text p:last-child,
    .task-desc-preview p:last-child {
      margin-bottom: 0;
    }
    .task-detail-desc h1, .task-detail-desc h2,
    .task-detail-desc h3, .task-detail-desc h4,
    .msg-detail-text h1, .msg-detail-text h2,
    .msg-detail-text h3, .msg-detail-text h4 {
      margin: 10px 0 4px 0;
      font-weight: 600;
      color: var(--vscode-foreground);
    }
    .task-detail-desc h1, .msg-detail-text h1 { font-size: 1.25em; }
    .task-detail-desc h2, .msg-detail-text h2 { font-size: 1.15em; }
    .task-detail-desc h3, .msg-detail-text h3 { font-size: 1.05em; }
    .task-detail-desc h4, .msg-detail-text h4 { font-size: 1.0em; }
    .task-detail-desc ul, .task-detail-desc ol,
    .msg-detail-text ul, .msg-detail-text ol {
      margin: 4px 0;
      padding-left: 24px;
    }
    .task-detail-desc li, .msg-detail-text li {
      margin-bottom: 2px;
    }
    .task-detail-desc code, .msg-detail-text code,
    .task-desc-preview code {
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
    }
    .task-detail-desc pre code, .msg-detail-text pre code {
      background: none;
      padding: 0;
    }
    .task-detail-desc pre, .msg-detail-text pre {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      background: var(--vscode-textCodeBlock-background);
      padding: 8px;
      border-radius: 4px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    .task-detail-desc table, .msg-detail-text table {
      border-collapse: collapse;
      margin: 8px 0;
      width: 100%;
      font-size: 0.95em;
    }
    .task-detail-desc th, .task-detail-desc td,
    .msg-detail-text th, .msg-detail-text td {
      border: 1px solid var(--vscode-panel-border);
      padding: 4px 8px;
      text-align: left;
    }
    .task-detail-desc th, .msg-detail-text th {
      font-weight: 600;
      background: var(--vscode-textCodeBlock-background);
    }
    .task-detail-desc hr, .msg-detail-text hr {
      border: none;
      border-top: 1px solid var(--vscode-panel-border);
      margin: 8px 0;
    }
    .task-detail-desc blockquote, .msg-detail-text blockquote {
      border-left: 3px solid var(--vscode-panel-border);
      margin: 4px 0;
      padding: 2px 12px;
      opacity: 0.85;
    }

    /* ===== Agent Color Classes (theme-aware) ===== */
    .agent-color-blue { background: var(--atm-agent-blue); }
    .agent-color-green { background: var(--atm-agent-green); }
    .agent-color-red { background: var(--atm-agent-red); }
    .agent-color-yellow { background: var(--atm-agent-yellow); }
    .agent-color-orange { background: var(--atm-agent-orange); }
    .agent-color-purple { background: var(--atm-agent-purple); }
    .agent-color-lead { background: var(--atm-agent-lead); }
    .agent-color-unknown { background: #888; }
    .agent-color-shutdown { background: #888; }

    .agent-text-blue { color: var(--atm-agent-blue); }
    .agent-text-green { color: var(--atm-agent-green); }
    .agent-text-red { color: var(--atm-agent-red); }
    .agent-text-yellow { color: var(--atm-agent-yellow); }
    .agent-text-orange { color: var(--atm-agent-orange); }
    .agent-text-purple { color: var(--atm-agent-purple); }
    .agent-text-lead { color: var(--atm-agent-lead); }
    .agent-text-unknown { color: var(--vscode-descriptionForeground); }

    /* ===== Lifecycle Badges ===== */
    .agent-status-badge.status-idle { color: var(--atm-status-yellow); }
    .agent-status-badge.status-shutting-down { color: var(--atm-status-orange); }
    .agent-status-badge.status-shutdown { color: var(--atm-status-red); }

    /* ===== Persistent Highlight ===== */
    .highlighted {
      outline: 2px solid var(--vscode-focusBorder);
      outline-offset: -1px;
      background: var(--atm-overlay-subtle);
    }

    /* ===== Disabled Button ===== */
    .icon-btn:disabled {
      opacity: 0.3;
      cursor: default;
    }
    .icon-btn:disabled:hover {
      background: transparent;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <span class="toolbar-title">Agent Teams</span>
    <div class="toolbar-controls">
      <select id="teamFilter" aria-label="Filter by team">
        <option value="__all__">All Teams</option>
        ${teamOptions}
      </select>
      <button class="icon-btn" id="collapseAllBtn" title="Collapse All" aria-label="Collapse all teams">
        ${SVG_ICONS.collapseAll}
      </button>
      <button class="icon-btn" id="refreshBtn" title="Re-scan team files from disk" aria-label="Re-scan team files"${this.state.replayMode ? ' disabled' : ''}>
        ${SVG_ICONS.refresh}
      </button>
    </div>
  </div>

  <div class="content" id="teamsContainer">
    ${teamsHtml}
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // ---- State restoration ----
    // vscode.getState() persists across HTML replacements (retainContextWhenHidden)
    const savedState = vscode.getState() || {};
    const collapsedTeams = savedState.collapsedTeams || {};
    const expandedItems = savedState.expandedItems || {};

    // Restore team filter
    const filterEl = document.getElementById('teamFilter');
    if (savedState.teamFilter && filterEl) {
      filterEl.value = savedState.teamFilter;
      applyFilter(savedState.teamFilter);
    }

    // Restore collapsed teams
    Object.entries(collapsedTeams).forEach(([team, collapsed]) => {
      if (collapsed) {
        const card = document.querySelector('[data-team="' + team + '"]');
        if (card) {
          const body = card.querySelector('.team-body');
          const chev = card.querySelector('.chevron');
          if (body) body.classList.add('collapsed');
          if (chev) chev.classList.add('collapsed');
        }
      }
    });

    // Restore expanded accordion items
    Object.entries(expandedItems).forEach(([key, expanded]) => {
      if (expanded) {
        const el = document.querySelector('[data-task-id="' + key + '"], [data-msg-id="' + key + '"]');
        if (el) {
          const detail = el.nextElementSibling;
          if (detail) {
            detail.classList.add('expanded');
            el.setAttribute('aria-expanded', 'true');
          }
        }
      }
    });

    // ---- Save state helper ----
    function saveState() {
      vscode.setState({
        teamFilter: filterEl ? filterEl.value : '__all__',
        collapsedTeams,
        expandedItems,
      });
    }

    // ---- Team filter ----
    if (filterEl) {
      filterEl.addEventListener('change', () => {
        applyFilter(filterEl.value);
        saveState();
      });
    }

    function applyFilter(val) {
      document.querySelectorAll('.team-card').forEach(card => {
        card.style.display = (val === '__all__' || card.dataset.team === val) ? '' : 'none';
      });
    }

    // ---- Collapse/expand all ----
    let allCollapsed = savedState.allCollapsed || false;
    document.getElementById('collapseAllBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      allCollapsed = !allCollapsed;
      document.querySelectorAll('.team-card').forEach(card => {
        const body = card.querySelector('.team-body');
        const chev = card.querySelector('.chevron');
        const teamName = card.dataset.team;
        if (allCollapsed) {
          body.classList.add('collapsed');
          chev.classList.add('collapsed');
          collapsedTeams[teamName] = true;
        } else {
          body.classList.remove('collapsed');
          chev.classList.remove('collapsed');
          collapsedTeams[teamName] = false;
        }
      });
      savedState.allCollapsed = allCollapsed;
      saveState();
    });

    // ---- Refresh ----
    document.getElementById('refreshBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });

    // ---- Delegated click handlers ----
    document.addEventListener('click', (e) => {
      // Clear highlight when clicking outside highlighted element
      const hl = document.querySelector('.highlighted');
      if (hl && !e.target.closest('.highlighted')) {
        hl.classList.remove('highlighted');
      }

      // Team action buttons (replay, clean)
      const actionBtn = e.target.closest('.team-action-btn');
      if (actionBtn) {
        e.stopPropagation();
        const action = actionBtn.dataset.action;
        const teamName = actionBtn.dataset.actionTeam;
        if (action && teamName) {
          vscode.postMessage({ command: action + 'Team', teamName: teamName });
        }
        return;
      }

      const header = e.target.closest('.team-header');
      if (header) {
        const card = header.closest('.team-card');
        const body = card.querySelector('.team-body');
        const chev = card.querySelector('.chevron');
        const teamName = card.dataset.team;
        body.classList.toggle('collapsed');
        chev.classList.toggle('collapsed');
        collapsedTeams[teamName] = body.classList.contains('collapsed');
        saveState();
        return;
      }

      const taskRow = e.target.closest('.task-row');
      if (taskRow) {
        const detail = taskRow.nextElementSibling;
        if (detail && detail.classList.contains('task-detail')) {
          detail.classList.toggle('expanded');
          const isExpanded = detail.classList.contains('expanded');
          taskRow.setAttribute('aria-expanded', String(isExpanded));
          const key = taskRow.dataset.taskId;
          if (key) {
            expandedItems[key] = isExpanded;
            saveState();
          }
        }
        return;
      }

      const msgRow = e.target.closest('.msg-row');
      if (msgRow) {
        const detail = msgRow.nextElementSibling;
        if (detail && detail.classList.contains('msg-detail')) {
          detail.classList.toggle('expanded');
          const isExpanded = detail.classList.contains('expanded');
          msgRow.setAttribute('aria-expanded', String(isExpanded));
          const key = msgRow.dataset.msgId;
          if (key) {
            expandedItems[key] = isExpanded;
            saveState();
          }
        }
        return;
      }
    });

    // ---- Escape HTML helper ----
    function esc(text) {
      const d = document.createElement('div');
      d.textContent = text;
      return d.innerHTML;
    }

    // ---- Handle messages from extension ----
    window.addEventListener('message', (event) => {
      const msg = event.data;

      if (msg.command === 'scrollTo') {
        const selector = msg.type === 'task'
          ? '[data-task-id="' + msg.id + '"][data-team="' + msg.team + '"]'
          : '[data-msg-id="' + msg.id + '"][data-team="' + msg.team + '"]';
        const el = document.querySelector(selector);
        if (el) {
          const card = el.closest('.team-card');
          if (card) {
            const body = card.querySelector('.team-body');
            const chev = card.querySelector('.chevron');
            body.classList.remove('collapsed');
            chev.classList.remove('collapsed');
            collapsedTeams[card.dataset.team] = false;
          }
          const detail = el.nextElementSibling;
          if (detail) {
            detail.classList.add('expanded');
            el.setAttribute('aria-expanded', 'true');
          }
          const prev = document.querySelector('.highlighted');
          if (prev) { prev.classList.remove('highlighted'); }
          el.classList.add('highlighted');
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          saveState();
        }
      }

      if (msg.command === 'updateData') {
        handleDataUpdate(msg.data);
      }
    });

    // ---- Incremental DOM update ----
    function handleDataUpdate(data) {
      // Update refresh button disabled state
      const refreshBtn = document.getElementById('refreshBtn');
      if (refreshBtn) { refreshBtn.disabled = !!data.replayMode; }

      const container = document.getElementById('teamsContainer');
      if (!container) return;

      const teamNames = new Set(data.teams.map(t => t.name));

      // Remove teams that no longer exist
      container.querySelectorAll('.team-card').forEach(card => {
        if (!teamNames.has(card.dataset.team)) {
          card.remove();
        }
      });

      // Handle empty state
      const emptyEl = container.querySelector('.empty-state');
      if (data.teams.length === 0) {
        if (!emptyEl) {
          container.innerHTML = '<div class="empty-state"><div class="empty-title">No Agent Teams Detected</div><div class="empty-text">Start an Agent Team in Claude Code to see it here.</div></div>';
        }
        // Update filter dropdown
        updateFilterOptions(data.teams);
        return;
      } else if (emptyEl) {
        emptyEl.remove();
      }

      for (const team of data.teams) {
        let card = container.querySelector('[data-team="' + team.name + '"]');
        if (!card) {
          // New team — insert full card
          const tmp = document.createElement('div');
          tmp.innerHTML = renderTeamCard(team);
          card = tmp.firstElementChild;
          container.appendChild(card);
          // Restore collapsed state
          if (collapsedTeams[team.name]) {
            const body = card.querySelector('.team-body');
            const chev = card.querySelector('.chevron');
            if (body) body.classList.add('collapsed');
            if (chev) chev.classList.add('collapsed');
          }
        } else {
          // Existing team — patch in place
          patchTeamCard(card, team);
        }
      }

      // Update filter dropdown
      updateFilterOptions(data.teams);
      // Re-apply filter
      if (filterEl) applyFilter(filterEl.value);
    }

    function updateFilterOptions(teams) {
      if (!filterEl) return;
      const current = filterEl.value;
      const opts = '<option value="__all__">All Teams</option>' +
        teams.map(t => '<option value="' + esc(t.name) + '">' + esc(t.name) + '</option>').join('');
      filterEl.innerHTML = opts;
      filterEl.value = current;
    }

    function patchTeamCard(card, team) {
      // Each section wrapped in try-catch so a failure in one doesn't prevent others
      try {
        // Update stats (including team status badge)
        var stats = card.querySelector('.team-stats');
        if (stats) {
          stats.innerHTML = teamStatusBadgeHtml(team.teamStatus) +
            '<span>' + team.memberCount + ' agent' + (team.memberCount !== 1 ? 's' : '') + '</span>' +
            '<span>&middot;</span>' +
            '<span>' + team.completedTasks + '/' + team.totalTasks + ' tasks done</span>';
        }
      } catch(e) { console.warn('[ATM] patchTeamCard stats error:', e); }

      try {
        // Update agent strip
        var strip = card.querySelector('.agent-strip');
        if (strip) {
          strip.innerHTML = team.members.map(function(m) {
            var lc = m.lifecycle || 'active';
            var dotClass = lc === 'shutdown' ? 'dot agent-color-shutdown' : 'dot agent-color-' + m.colorName;
            var chipClass = lc === 'shutdown' ? 'agent-chip shutdown' : lc === 'idle' ? 'agent-chip idle' : lc === 'shutting_down' ? 'agent-chip shutting-down' : 'agent-chip';
            var leadStar = m.lead ? '<span class="lead-star" aria-label="Team Lead">&#9733;</span>' : '';
            var statusBadge = lc === 'shutdown' ? '<span class="agent-status-badge status-shutdown">SHUTDOWN</span>' : lc === 'idle' ? '<span class="agent-status-badge status-idle">IDLE</span>' : lc === 'shutting_down' ? '<span class="agent-status-badge status-shutting-down">SHUTTING DOWN</span>' : '';
            return '<div class="' + chipClass + '"><span class="' + dotClass + '"></span>' +
              leadStar + esc(m.name) + statusBadge +
              '<span class="model">' + esc(m.model) + '</span></div>';
          }).join('');
        }
      } catch(e) { console.warn('[ATM] patchTeamCard strip error:', e); }

      try {
        // Update progress
        var progressPct = team.totalTasks > 0 ? Math.round((team.completedTasks / team.totalTasks) * 100) : 0;
        var sectionBars = card.querySelectorAll('.section-bar');
        if (sectionBars[0]) {
          var fill = sectionBars[0].querySelector('.progress-fill');
          if (fill) fill.style.width = progressPct + '%';
          var cnt = sectionBars[0].querySelector('.section-count');
          if (cnt) cnt.textContent = team.completedTasks + '/' + team.totalTasks;
        }
      } catch(e) { console.warn('[ATM] patchTeamCard progress error:', e); }

      try {
        // Update tasks — preserve expanded state
        var taskList = card.querySelector('.task-list');
        if (taskList) {
          patchList(taskList, team.tasks, 'task');
        }
      } catch(e) { console.warn('[ATM] patchTeamCard tasks error:', e); }

      try {
        // Update message count
        var sectionBars2 = card.querySelectorAll('.section-bar');
        if (sectionBars2[1]) {
          var mcnt = sectionBars2[1].querySelector('.section-count');
          if (mcnt) mcnt.textContent = String(team.messages.length);
        }
      } catch(e) { console.warn('[ATM] patchTeamCard msg count error:', e); }

      try {
        // Update messages — preserve expanded state
        var msgFeed = card.querySelector('.message-feed');
        if (msgFeed) {
          patchList(msgFeed, team.messages, 'msg');
        }
      } catch(e) { console.warn('[ATM] patchTeamCard messages error:', e); }
    }

    function patchList(container, items, type) {
      var idAttr = type === 'task' ? 'data-task-id' : 'data-msg-id';
      var rowClass = type === 'task' ? 'task-row' : 'msg-row';
      var detailClass = type === 'task' ? 'task-detail' : 'msg-detail';

      // Build map of existing expanded items and preserve scroll positions
      var existingExpanded = {};
      var scrollPositions = {};
      container.querySelectorAll('.' + detailClass + '.expanded').forEach(function(el) {
        var row = el.previousElementSibling;
        if (row) {
          var key = row.getAttribute(idAttr);
          if (key) {
            existingExpanded[key] = true;
            if (el.scrollTop > 0) { scrollPositions[key] = el.scrollTop; }
          }
        }
      });

      // Also check in-memory expanded state
      for (var k in expandedItems) {
        if (expandedItems[k]) existingExpanded[k] = true;
      }

      // Build new HTML
      var html = '';
      if (items.length === 0) {
        html = '<div style="padding:4px 8px;opacity:0.45;font-size:0.9em">No ' + (type === 'task' ? 'tasks assigned' : 'messages') + '</div>';
      } else {
        for (var i = 0; i < items.length; i++) {
          html += type === 'task' ? renderTaskRow(items[i]) : renderMsgRow(items[i]);
        }
      }
      container.innerHTML = html;

      // Restore expanded state and scroll positions
      for (var key in existingExpanded) {
        var row = container.querySelector('[' + idAttr + '="' + key + '"]');
        if (row) {
          var detail = row.nextElementSibling;
          if (detail && detail.classList.contains(detailClass)) {
            detail.classList.add('expanded');
            row.setAttribute('aria-expanded', 'true');
            if (scrollPositions[key]) { detail.scrollTop = scrollPositions[key]; }
          }
        }
      }
    }

    function renderTaskRow(t) {
      var id = String(t.id || '');
      var subject = String(t.subject || '');
      var statusClass = String(t.statusClass || 'pending');
      var badgeLabel = String(t.badgeLabel || 'pending');
      var colorName = String(t.agentColorName || 'unknown');
      var teamName = String(t.teamName || '');
      var blockedBy = Array.isArray(t.blockedBy) ? t.blockedBy : [];
      var blocks = Array.isArray(t.blocks) ? t.blocks : [];

      return '<div class="task-row" tabindex="0" role="button" aria-expanded="false" data-task-id="' + esc(id) + '" data-team="' + esc(teamName) + '">' +
        '<span class="task-chevron">&#9656;</span>' +
        '<span class="status-dot ' + statusClass + '" aria-label="' + badgeLabel + '"></span>' +
        '<div class="task-content"><div class="task-header">' +
        '<span class="task-id">#' + esc(id) + '</span>' +
        '<span class="task-agent agent-text-' + colorName + '">' + esc(subject) + '</span>' +
        '<span class="status-badge ' + statusClass + '">' + badgeLabel + '</span>' +
        '</div><div class="task-desc-preview">' + esc(t.description || '') + '</div></div></div>' +
        '<div class="task-detail"><div class="task-detail-desc">' + (t.fullPromptHtml || esc(t.description || '')) + '</div>' +
        (blockedBy.length > 0 ? '<div class="task-deps">Blocked by: #' + blockedBy.map(function(b) { return esc(String(b)); }).join(', #') + '</div>' : '') +
        (blocks.length > 0 ? '<div class="task-deps">Blocks: #' + blocks.map(function(b) { return esc(String(b)); }).join(', #') + '</div>' : '') +
        '</div>';
    }

    function renderMsgRow(m) {
      var badgeHtml = m.badgeClass ? '<span class="msg-badge ' + m.badgeClass + '">' + m.badgeText + '</span>' : '';
      return '<div class="msg-row" tabindex="0" role="button" aria-expanded="false" data-msg-id="' + esc(m.id) + '" data-team="' + esc(m.teamName || '') + '">' +
        '<div class="msg-color-bar agent-color-' + m.fromColor + '"></div>' +
        '<div class="msg-body-wrap"><div class="msg-header">' +
        '<span class="msg-chevron">&#9656;</span>' +
        '<span class="msg-from">' + esc(m.from) + '</span>' +
        '<span class="msg-arrow">&rarr;</span>' +
        '<span class="msg-to">' + esc(m.to) + '</span>' +
        badgeHtml +
        '<span class="msg-time">' + m.time + '</span>' +
        '</div><div class="msg-preview">' + esc(m.preview) + '</div></div></div>' +
        '<div class="msg-detail"><div class="msg-detail-text">' +
        (m.isTyped ? '<pre>' + esc(m.fullText) + '</pre>' : (m.fullTextHtml || esc(m.fullText))) +
        '</div></div>';
    }

    function teamStatusBadgeHtml(ts) {
      if (ts === 'completed') return '<span class="team-status-badge ts-completed">completed</span>';
      if (ts === 'winding_down') return '<span class="team-status-badge ts-winding-down">winding down</span>';
      return '<span class="team-status-badge ts-active">active</span>';
    }

    var ICON_REPLAY = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5z"/></svg>';
    var ICON_TRASH = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 1.5h5M2.5 4h11M6 7v4M10 7v4M3.5 4l.75 8.5a1 1 0 0 0 1 .9h5.5a1 1 0 0 0 1-.9L12.5 4" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    function teamActionsHtml(teamName) {
      return '<div class="team-actions">' +
        '<button class="team-action-btn" data-action="replay" data-action-team="' + esc(teamName) + '" title="Replay this session">' + ICON_REPLAY + '</button>' +
        '<button class="team-action-btn" data-action="clean" data-action-team="' + esc(teamName) + '" title="Remove team files from disk">' + ICON_TRASH + '</button>' +
        '</div>';
    }

    function renderTeamCard(team) {
      var agentCount = team.memberCount;
      var progressPct = team.totalTasks > 0 ? Math.round((team.completedTasks / team.totalTasks) * 100) : 0;

      var agentsHtml = team.members.map(function(m) {
        var lc = m.lifecycle || 'active';
        var dotClass = lc === 'shutdown' ? 'dot agent-color-shutdown' : 'dot agent-color-' + m.colorName;
        var chipClass = lc === 'shutdown' ? 'agent-chip shutdown' : lc === 'idle' ? 'agent-chip idle' : lc === 'shutting_down' ? 'agent-chip shutting-down' : 'agent-chip';
        var leadStar = m.lead ? '<span class="lead-star" aria-label="Team Lead">&#9733;</span>' : '';
        var statusBadge = lc === 'shutdown' ? '<span class="agent-status-badge status-shutdown">SHUTDOWN</span>' : lc === 'idle' ? '<span class="agent-status-badge status-idle">IDLE</span>' : lc === 'shutting_down' ? '<span class="agent-status-badge status-shutting-down">SHUTTING DOWN</span>' : '';
        return '<div class="' + chipClass + '"><span class="' + dotClass + '"></span>' +
          leadStar + esc(m.name) + statusBadge +
          '<span class="model">' + esc(m.model) + '</span></div>';
      }).join('');

      var tasksHtml = '';
      if (team.tasks.length === 0) {
        tasksHtml = '<div style="padding:4px 8px;opacity:0.45;font-size:0.9em">No tasks assigned</div>';
      } else {
        for (var i = 0; i < team.tasks.length; i++) {
          tasksHtml += renderTaskRow(team.tasks[i]);
        }
      }

      var msgsHtml = '';
      if (team.messages.length === 0) {
        msgsHtml = '<div style="padding:4px 8px;opacity:0.45;font-size:0.9em">No messages</div>';
      } else {
        for (var i = 0; i < team.messages.length; i++) {
          msgsHtml += renderMsgRow(team.messages[i]);
        }
      }

      return '<div class="team-card" data-team="' + esc(team.name) + '">' +
        '<div class="team-header" tabindex="0" role="button" aria-expanded="true">' +
        '<span class="chevron">&#9662;</span>' +
        '<span class="team-name">' + esc(team.name) + '</span>' +
        '<div class="team-stats">' + teamStatusBadgeHtml(team.teamStatus) +
        '<span>' + agentCount + ' agent' + (agentCount !== 1 ? 's' : '') + '</span>' +
        '<span>&middot;</span><span>' + team.completedTasks + '/' + team.totalTasks + ' tasks done</span></div>' +
        teamActionsHtml(team.name) + '</div>' +
        '<div class="team-body"><div class="agent-strip">' + agentsHtml + '</div>' +
        '<div class="section-bar"><span>Tasks</span>' +
        '<div class="progress-track"><div class="progress-fill" style="width:' + progressPct + '%"></div></div>' +
        '<span class="section-count">' + team.completedTasks + '/' + team.totalTasks + '</span></div>' +
        '<div class="task-list">' + tasksHtml + '</div>' +
        '<div class="section-bar"><span>Messages</span><span class="section-count">' + team.messages.length + '</span></div>' +
        '<div class="message-feed">' + msgsHtml + '</div></div></div>';
    }

    // Signal to extension that webview is ready to receive messages
    vscode.postMessage({ command: 'ready' });
  </script>
</body>
</html>`;
  }

  private renderTeam(
    team: TeamConfig,
    tasks: AgentTask[],
    messages: { entry: InboxEntry; inboxOwner: string }[],
    agentColorMap: Map<string, string>
  ): string {
    const agentCount = team.members.length;
    const completed = tasks.filter(t =>
      this.state.getEffectiveTaskStatus(team.name, t) === 'completed'
    ).length;
    const progressPct = tasks.length > 0 ? Math.round((completed / tasks.length) * 100) : 0;

    // Derive team status
    const lifecycleStates = this.state.getAgentLifecycleStates(team.name);
    const teamStatus = deriveTeamStatus(lifecycleStates, team.members);

    // Agents strip
    const agentsHtml = team.members.map(m => {
      const colorName = getMemberColorName(m);
      const lead = isTeamLead(m);
      const lifecycle = lifecycleStates.get(m.name) || 'active';
      const model = m.model.length > 30 ? m.model.slice(0, 25) + '...' : m.model;
      const leadStar = lead ? `<span class="lead-star" aria-label="Team Lead">&#9733;</span>` : '';
      const dotClass = lifecycle === 'shutdown' ? 'dot agent-color-shutdown' : `dot agent-color-${colorName}`;
      const chipClass = lifecycle === 'shutdown' ? 'agent-chip shutdown'
        : lifecycle === 'idle' ? 'agent-chip idle'
        : lifecycle === 'shutting_down' ? 'agent-chip shutting-down'
        : 'agent-chip';
      let statusBadge = '';
      if (lifecycle === 'shutdown') { statusBadge = `<span class="agent-status-badge status-shutdown">SHUTDOWN</span>`; }
      else if (lifecycle === 'idle') { statusBadge = `<span class="agent-status-badge status-idle">IDLE</span>`; }
      else if (lifecycle === 'shutting_down') { statusBadge = `<span class="agent-status-badge status-shutting-down">SHUTTING DOWN</span>`; }
      return `<div class="${chipClass}">
        <span class="${dotClass}"></span>
        ${leadStar}
        ${escapeHtml(m.name)}
        ${statusBadge}
        <span class="model">${escapeHtml(model)}</span>
      </div>`;
    }).join('');

    // Tasks — use effective status
    let tasksHtml = '';
    for (const task of tasks) {
      const effectiveStatus = this.state.getEffectiveTaskStatus(team.name, task);
      const blockedBy = task.blockedBy ?? [];
      const blocks = task.blocks ?? [];
      const blocked = blockedBy.length > 0 && task.status === 'pending';
      const statusClass = blocked ? 'blocked' : effectiveStatus;
      const badgeLabel = blocked ? 'blocked' : (effectiveStatus === 'in_progress' ? 'active' : (effectiveStatus === 'completed' ? 'done' : 'pending'));
      const agentColorName = agentColorMap.get(task.subject) || 'unknown';

      tasksHtml += `
        <div class="task-row" tabindex="0" role="button" aria-expanded="false"
             data-task-id="${escapeHtml(task.id)}" data-team="${escapeHtml(team.name)}">
          <span class="task-chevron">&#9656;</span>
          <span class="status-dot ${statusClass}" aria-label="${badgeLabel}"></span>
          <div class="task-content">
            <div class="task-header">
              <span class="task-id">#${escapeHtml(task.id)}</span>
              <span class="task-agent agent-text-${agentColorName}">${escapeHtml(task.subject)}</span>
              <span class="status-badge ${statusClass}">${badgeLabel}</span>
            </div>
            <div class="task-desc-preview">${escapeHtml(task.description || '')}</div>
          </div>
        </div>
        <div class="task-detail">
          <div class="task-detail-desc">${formatPromptHtml(team.members.find(m => m.name === task.subject)?.prompt || task.description || '')}</div>
          ${blockedBy.length > 0 ? `<div class="task-deps">Blocked by: #${blockedBy.map(escapeHtml).join(', #')}</div>` : ''}
          ${blocks.length > 0 ? `<div class="task-deps">Blocks: #${blocks.map(escapeHtml).join(', #')}</div>` : ''}
        </div>`;
    }
    if (tasks.length === 0) {
      tasksHtml = '<div style="padding:4px 8px;opacity:0.45;font-size:0.9em">No tasks assigned</div>';
    }

    // Messages
    const sorted = messages
      .sort((a, b) => b.entry.timestamp.localeCompare(a.entry.timestamp))
      .slice(0, 50);

    let messagesHtml = '';
    for (let i = 0; i < sorted.length; i++) {
      const { entry, inboxOwner } = sorted[i];
      const time = formatTime(entry.timestamp);
      const fromColor = getFromColorName(entry);
      const typed = parseTypedMessage(entry.text);

      let badgeHtml = '';
      let preview = '';
      let fullText = '';

      if (typed) {
        const { badgeClass, badgeText } = getTypedBadge(typed);
        badgeHtml = `<span class="msg-badge ${badgeClass}">${badgeText}</span>`;
        preview = entry.summary || getTypedPreview(typed);
        fullText = JSON.stringify(typed, null, 2);
      } else {
        preview = entry.summary || entry.text.slice(0, 100).replace(/\n/g, ' ');
        if (preview.length < entry.text.length && !entry.summary) { preview += '...'; }
        fullText = entry.text;
      }

      const msgId = `${entry.from}-${entry.timestamp}`;
      messagesHtml += `
        <div class="msg-row" tabindex="0" role="button" aria-expanded="false"
             data-msg-id="${escapeHtml(msgId)}" data-team="${escapeHtml(team.name)}">
          <div class="msg-color-bar agent-color-${fromColor}"></div>
          <div class="msg-body-wrap">
            <div class="msg-header">
              <span class="msg-chevron">&#9656;</span>
              <span class="msg-from">${escapeHtml(entry.from)}</span>
              <span class="msg-arrow">&rarr;</span>
              <span class="msg-to">${escapeHtml(inboxOwner)}</span>
              ${badgeHtml}
              <span class="msg-time">${time}</span>
            </div>
            <div class="msg-preview">${escapeHtml(preview)}</div>
          </div>
        </div>
        <div class="msg-detail">
          <div class="msg-detail-text">${typed ? `<pre>${escapeHtml(fullText)}</pre>` : formatPromptHtml(fullText)}</div>
        </div>`;
    }
    if (sorted.length === 0) {
      messagesHtml = '<div style="padding:4px 8px;opacity:0.45;font-size:0.9em">No messages</div>';
    }

    return `
    <div class="team-card" data-team="${escapeHtml(team.name)}">
      <div class="team-header" tabindex="0" role="button" aria-expanded="true">
        <span class="chevron">&#9662;</span>
        <span class="team-name">${escapeHtml(team.name)}</span>
        <div class="team-stats">
          ${teamStatus === 'completed' ? '<span class="team-status-badge ts-completed">completed</span>'
            : teamStatus === 'winding_down' ? '<span class="team-status-badge ts-winding-down">winding down</span>'
            : '<span class="team-status-badge ts-active">active</span>'}
          <span>${agentCount} agent${agentCount !== 1 ? 's' : ''}</span>
          <span>&middot;</span>
          <span>${completed}/${tasks.length} tasks done</span>
        </div>
        <div class="team-actions">
          <button class="team-action-btn" data-action="replay" data-action-team="${escapeHtml(team.name)}" title="Replay this session">${SVG_ICONS.replay}</button>
          <button class="team-action-btn" data-action="clean" data-action-team="${escapeHtml(team.name)}" title="Remove team files from disk">${SVG_ICONS.trash}</button>
        </div>
      </div>
      <div class="team-body">
        <div class="agent-strip">${agentsHtml}</div>

        <div class="section-bar">
          <span>Tasks</span>
          <div class="progress-track">
            <div class="progress-fill" style="width:${progressPct}%"></div>
          </div>
          <span class="section-count">${completed}/${tasks.length}</span>
        </div>
        <div class="task-list">${tasksHtml}</div>

        <div class="section-bar">
          <span>Messages</span>
          <span class="section-count">${sorted.length}</span>
        </div>
        <div class="message-feed">${messagesHtml}</div>
      </div>
    </div>`;
  }

  private collectMessages(
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

// --- Helpers ---

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

function getTypedPreview(typed: { type: string; description?: string; reason?: string; planContent?: string; idleReason?: string }): string {
  if (typed.description) { return typed.description; }
  if (typed.reason) { return typed.reason; }
  if (typed.planContent) { return typed.planContent.slice(0, 100); }
  if (typed.idleReason) { return typed.idleReason; }
  return typed.type.replace(/_/g, ' ');
}

/** Escape HTML then apply lightweight markdown: **bold** and `code` */
function formatPromptHtml(text: string): string {
  return md.render(text);
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

// Inline SVG icons (no external dependencies)
const SVG_ICONS = {
  refresh: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.5 2.5v3.5h-3.5M2.5 13.5v-3.5h3.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9M13.5 8a5.5 5.5 0 0 1-9.4 3.9" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>`,
  collapseAll: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3 3h10v1H3V3zm0 9h10v1H3v-1zm2-5l3-3 3 3H5zm6 2l-3 3-3-3h6z"/></svg>`,
  agents: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3"/><circle cx="5" cy="16" r="2.5"/><circle cx="19" cy="16" r="2.5"/><line x1="12" y1="11" x2="7" y2="14"/><line x1="12" y1="11" x2="17" y2="14"/></svg>`,
  replay: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5z"/></svg>`,
  trash: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 1.5h5M2.5 4h11M6 7v4M10 7v4M3.5 4l.75 8.5a1 1 0 0 0 1 .9h5.5a1 1 0 0 0 1-.9L12.5 4" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};
