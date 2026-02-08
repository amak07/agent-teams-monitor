import * as vscode from 'vscode';
import { TeamStateManager } from './state/teamState';
import { FileWatcher } from './watchers/fileWatcher';
import { AgentTreeProvider } from './views/agentTreeProvider';
import { TaskTreeProvider } from './views/taskTreeProvider';
import { MessageTreeProvider } from './views/messageTreeProvider';
import { StatusBarManager } from './statusBar/statusBarItem';
import { SessionArchiver } from './history/sessionArchiver';
import { ReplayManager } from './replay/replayManager';
import { DashboardPanel } from './views/dashboardPanel';
import { AgentTask, InboxEntry } from './types';

export function activate(context: vscode.ExtensionContext) {
  console.log('Agent Teams Monitor is now active');

  // Core state
  const state = new TeamStateManager();
  const watcher = new FileWatcher(state);
  const archiver = new SessionArchiver(state);
  const replayManager = new ReplayManager(state);

  // Set workspace paths for filtering
  const folders = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
  state.setWorkspacePaths(folders);

  // Update if workspace folders change
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const updated = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
      state.setWorkspacePaths(updated);
    })
  );

  // Tree views
  const agentTree = new AgentTreeProvider(state);
  const taskTree = new TaskTreeProvider(state);
  const messageTree = new MessageTreeProvider(state);

  // Status bar
  const statusBar = new StatusBarManager(state);

  // Register tree view providers
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('agentTeams.agents', agentTree),
    vscode.window.registerTreeDataProvider('agentTeams.tasks', taskTree),
    vscode.window.registerTreeDataProvider('agentTeams.messages', messageTree),
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('agentTeams.refresh', () => {
      agentTree.refresh();
      taskTree.refresh();
      messageTree.refresh();
      vscode.window.setStatusBarMessage('Agent team files re-scanned', 2000);
    }),
    vscode.commands.registerCommand('agentTeams.focus', () => {
      vscode.commands.executeCommand('agentTeams.agents.focus');
    }),
    vscode.commands.registerCommand('agentTeams.showMessage', (entry: InboxEntry, teamName: string) => {
      const dashboard = DashboardPanel.createOrShow(state);
      if (teamName) {
        dashboard.scrollTo('message', `${entry.from}-${entry.timestamp}`, teamName);
      }
    }),
    vscode.commands.registerCommand('agentTeams.showTask', (task: AgentTask, teamName: string) => {
      const dashboard = DashboardPanel.createOrShow(state);
      if (teamName) {
        dashboard.scrollTo('task', task.id, teamName);
      }
    }),
    vscode.commands.registerCommand('agentTeams.tasks.groupByAgent', () => {
      taskTree.setGroupByAgent(true);
    }),
    vscode.commands.registerCommand('agentTeams.tasks.groupByTimeline', () => {
      taskTree.setGroupByAgent(false);
    }),
    vscode.commands.registerCommand('agentTeams.messages.groupByInbox', () => {
      messageTree.setGroupByInbox(true);
    }),
    vscode.commands.registerCommand('agentTeams.messages.groupByTimeline', () => {
      messageTree.setGroupByInbox(false);
    }),
    vscode.commands.registerCommand('agentTeams.openDashboard', () => {
      DashboardPanel.createOrShow(state);
    }),
    vscode.commands.registerCommand('agentTeams.toggleShowAll', () => {
      state.setShowAll(true);
    }),
    vscode.commands.registerCommand('agentTeams.toggleShowWorkspace', () => {
      state.setShowAll(false);
    }),
    vscode.commands.registerCommand('agentTeams.cleanTeam', async (node: { config?: { name?: string } }) => {
      const teamName = node?.config?.name;
      if (!teamName) { return; }
      const choice = await vscode.window.showWarningMessage(
        `Remove all files for team "${teamName}" from disk?`,
        'Remove', 'Cancel'
      );
      if (choice === 'Remove') {
        watcher.cleanTeam(teamName);
      }
    }),
    vscode.commands.registerCommand('agentTeams.replaySession', () => {
      replayManager.startReplay();
    }),
    vscode.commands.registerCommand('agentTeams.stopReplay', () => {
      replayManager.stopReplay();
    }),
  );

  // Start watching
  watcher.start();

  // Register disposables
  context.subscriptions.push(
    { dispose: () => watcher.dispose() },
    { dispose: () => state.dispose() },
    { dispose: () => agentTree.dispose() },
    { dispose: () => taskTree.dispose() },
    { dispose: () => messageTree.dispose() },
    { dispose: () => statusBar.dispose() },
    { dispose: () => archiver.dispose() },
    { dispose: () => replayManager.dispose() },
  );
}

export function deactivate() {
  console.log('Agent Teams Monitor deactivated');
}
