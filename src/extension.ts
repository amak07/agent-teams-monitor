import * as vscode from 'vscode';
import * as path from 'path';
import { TeamStateManager } from './state/teamState';
import { FileWatcher } from './watchers/fileWatcher';
import { AgentTreeProvider } from './views/agentTreeProvider';
import { TaskTreeProvider } from './views/taskTreeProvider';
import { MessageTreeProvider } from './views/messageTreeProvider';
import { StatusBarManager } from './statusBar/statusBarItem';
import { SessionArchiver } from './history/sessionArchiver';
import { ReplayManager } from './replay/replayManager';
import { AutoRecorder } from './replay/autoRecorder';
import { DashboardPanel } from './views/dashboardPanel';
import { AgentTask, InboxEntry } from './types';

export function activate(context: vscode.ExtensionContext) {
  console.log('Agent Teams Monitor is now active');

  // Core state
  const state = new TeamStateManager();
  const watcher = new FileWatcher(state);
  const archiver = new SessionArchiver(state);
  const replayManager = new ReplayManager(state, context);

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

  // Create tree views (need TreeView refs for badge API)
  const agentsView = vscode.window.createTreeView('agentTeams.agents', { treeDataProvider: agentTree });
  const tasksView = vscode.window.createTreeView('agentTeams.tasks', { treeDataProvider: taskTree });
  const messagesView = vscode.window.createTreeView('agentTeams.messages', { treeDataProvider: messageTree });
  context.subscriptions.push(agentsView, tasksView, messagesView);

  // Activity bar badge: show count of active teams
  const updateBadge = () => {
    const count = state.getFilteredTeams().length;
    agentsView.badge = count > 0
      ? { value: count, tooltip: `${count} active team${count !== 1 ? 's' : ''}` }
      : undefined;
  };

  // Team lifecycle notifications (suppressed during initial scan and replay)
  let notificationsReady = false;
  state.onDidChange(e => {
    if (e.type === 'teamAdded' || e.type === 'teamUpdated' || e.type === 'teamRemoved') {
      updateBadge();
    }
    if (!notificationsReady || state.isAnyReplayActive()) { return; }
    if (e.type === 'teamAdded') {
      vscode.window.showInformationMessage(
        `Agent Team '${e.teamName}' started`,
        'Open Dashboard'
      ).then(choice => {
        if (choice === 'Open Dashboard') {
          vscode.commands.executeCommand('agentTeams.openDashboard');
        }
      });
    } else if (e.type === 'teamRemoved') {
      vscode.window.showInformationMessage(`Agent Team '${e.teamName}' ended`);
    }
  });

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
    vscode.commands.registerCommand('agentTeams.replayTeam', (teamName: string, recordingDir: string) => {
      replayManager.replayTeam(teamName, recordingDir);
    }),
    vscode.commands.registerCommand('agentTeams.stopTeamReplay', (teamName: string) => {
      replayManager.stopTeamReplay(teamName);
    }),
  );

  // Auto-recording setup
  const agentTeamsConfig = vscode.workspace.getConfiguration('agentTeams');
  const autoRecordEnabled = agentTeamsConfig.get<boolean>('autoRecord', true);
  const customRecordingsPath = agentTeamsConfig.get<string>('recordingsPath', '');
  const autoRecordDir = customRecordingsPath || path.join(context.globalStorageUri.fsPath, 'recordings');

  let autoRecorder: AutoRecorder | undefined;
  if (autoRecordEnabled) {
    autoRecorder = new AutoRecorder(state, autoRecordDir);
  }

  // Hook auto-recorder into file watcher events
  watcher.onTeamAppeared(teamName => {
    if (autoRecorder && !state.isTeamReplaying(teamName)) {
      autoRecorder.startRecording(teamName);
    }
  });

  // Capture frames on state changes (event-driven, no polling)
  state.onDidChange(e => {
    if (!autoRecorder) { return; }
    if (e.type === 'teamUpdated' || e.type === 'taskUpdated' || e.type === 'messageReceived') {
      const teamName = e.teamName;
      if (teamName && !state.isTeamReplaying(teamName) && autoRecorder.isRecording(teamName)) {
        autoRecorder.captureFrame(teamName);
      }
    }
  });

  watcher.onTeamDisappeared(teamName => {
    if (autoRecorder) {
      const manifest = autoRecorder.stopRecording(teamName);
      if (manifest && manifest.frameCount > 0) {
        replayManager.invalidateRecordingsCache();
        const recordingDir = autoRecorder.getRecordingDir(teamName);
        vscode.window.showInformationMessage(
          `Agent Team '${teamName}' completed. Replay available.`,
          'Replay', 'Open Dashboard'
        ).then(choice => {
          if (choice === 'Replay' && recordingDir) {
            replayManager.startReplay(recordingDir);
          } else if (choice === 'Open Dashboard') {
            vscode.commands.executeCommand('agentTeams.openDashboard');
          }
        });
      }
    }
  });

  // Start watching
  watcher.start();

  // Enable notifications after initial scan completes (avoid spam on activation)
  setTimeout(() => { notificationsReady = true; }, 2000);

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
    { dispose: () => autoRecorder?.dispose() },
  );
}

export function deactivate() {
  console.log('Agent Teams Monitor deactivated');
}
