import * as vscode from 'vscode';
import { TeamStateManager } from './state/teamState';
import { FileWatcher } from './watchers/fileWatcher';
import { AgentTreeProvider } from './views/agentTreeProvider';
import { TaskTreeProvider } from './views/taskTreeProvider';
import { MessageTreeProvider } from './views/messageTreeProvider';
import { StatusBarManager } from './statusBar/statusBarItem';
import { SessionArchiver } from './history/sessionArchiver';
import { DashboardPanel } from './views/dashboardPanel';
import { AgentTask, InboxEntry, parseTypedMessage } from './types';

const SCHEME = 'agent-teams';

// Readonly content provider for message and task detail documents
class AgentTeamsContentProvider implements vscode.TextDocumentContentProvider {
  private contents = new Map<string, string>();

  setContent(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) || '';
  }
}

let docCounter = 0;
const contentProvider = new AgentTeamsContentProvider();

export function activate(context: vscode.ExtensionContext) {
  console.log('Agent Teams Monitor is now active');

  // Register readonly content provider
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, contentProvider)
  );

  // Core state
  const state = new TeamStateManager();
  const watcher = new FileWatcher(state);
  const archiver = new SessionArchiver(state);

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
    }),
    vscode.commands.registerCommand('agentTeams.focus', () => {
      vscode.commands.executeCommand('agentTeams.agents.focus');
    }),
    vscode.commands.registerCommand('agentTeams.showMessage', (entry: InboxEntry) => {
      showMessageDocument(entry);
    }),
    vscode.commands.registerCommand('agentTeams.showTask', (task: AgentTask) => {
      showTaskDocument(task);
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
  );
}

async function openReadonlyDocument(name: string, content: string): Promise<void> {
  const uri = vscode.Uri.parse(`${SCHEME}:${name}-${++docCounter}`);
  contentProvider.setContent(uri, content);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function showMessageDocument(entry: InboxEntry): Promise<void> {
  const typed = parseTypedMessage(entry.text);
  let content: string;

  if (typed) {
    content = [
      `From: ${entry.from}`,
      `Time: ${entry.timestamp}`,
      `Type: ${typed.type}`,
      entry.summary ? `Summary: ${entry.summary}` : '',
      '',
      '--- Typed Message ---',
      JSON.stringify(typed, null, 2),
    ].filter(Boolean).join('\n');
  } else {
    content = [
      `From: ${entry.from}`,
      `Time: ${entry.timestamp}`,
      entry.summary ? `Summary: ${entry.summary}` : '',
      '',
      '--- Message ---',
      entry.text,
    ].filter(Boolean).join('\n');
  }

  await openReadonlyDocument(`message-from-${entry.from}`, content);
}

async function showTaskDocument(task: AgentTask): Promise<void> {
  const lines = [
    `Task #${task.id}`,
    `Agent: ${task.subject}`,
    `Status: ${task.status}`,
    '',
    '--- Description ---',
    task.description,
  ];

  if (task.blockedBy.length > 0) {
    lines.push('', `Blocked by: #${task.blockedBy.join(', #')}`);
  }
  if (task.blocks.length > 0) {
    lines.push('', `Blocks: #${task.blocks.join(', #')}`);
  }

  await openReadonlyDocument(`task-${task.id}`, lines.join('\n'));
}

export function deactivate() {
  console.log('Agent Teams Monitor deactivated');
}
