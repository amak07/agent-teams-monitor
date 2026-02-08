import * as vscode from 'vscode';
import { TeamStateManager } from '../state/teamState';
import { AgentTask } from '../types';

type TaskTreeElement = TeamTaskGroup | AgentTaskGroup | TaskNode;

class TeamTaskGroup {
  constructor(public readonly teamName: string) {}
}

class AgentTaskGroup {
  constructor(
    public readonly agentName: string,
    public readonly teamName: string
  ) {}
}

class TaskNode {
  constructor(
    public readonly task: AgentTask,
    public readonly teamName: string
  ) {}
}

const STATUS_ICONS: Record<string, { icon: string; color?: string }> = {
  completed: { icon: 'check', color: 'charts.green' },
  in_progress: { icon: 'sync~spin', color: 'charts.blue' },
  pending: { icon: 'circle-outline' },
};

export class TaskTreeProvider implements vscode.TreeDataProvider<TaskTreeElement> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TaskTreeElement | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private groupByAgent = true;

  constructor(private state: TeamStateManager) {
    vscode.commands.executeCommand('setContext', 'agentTeams.tasks.groupedByAgent', true);
    state.onDidChange(e => {
      if (e.type === 'taskUpdated' || e.type === 'teamUpdated' || e.type === 'teamRemoved' || e.type === 'messageReceived') {
        this._onDidChangeTreeData.fire(undefined);
      }
    });
  }

  setGroupByAgent(enabled: boolean): void {
    this.groupByAgent = enabled;
    vscode.commands.executeCommand('setContext', 'agentTeams.tasks.groupedByAgent', enabled);
    this._onDidChangeTreeData.fire(undefined);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TaskTreeElement): vscode.TreeItem {
    if (element instanceof TeamTaskGroup) {
      return this.getTeamGroupItem(element);
    }
    if (element instanceof AgentTaskGroup) {
      return this.getAgentGroupItem(element);
    }
    return this.getTaskItem(element);
  }

  getChildren(element?: TaskTreeElement): TaskTreeElement[] {
    if (!element) {
      const teamNames = this.state.getFilteredTeamNames();
      if (teamNames.length === 0) { return []; }

      if (this.groupByAgent) {
        // Single team: show agent groups directly
        if (teamNames.length === 1) {
          return this.getAgentGroupsForTeam(teamNames[0]);
        }
        // Multiple teams: group by team first
        return teamNames
          .filter(name => this.state.getTasks(name).length > 0)
          .map(name => new TeamTaskGroup(name));
      }

      // Timeline mode (default)
      if (teamNames.length === 1) {
        return this.state.getTasks(teamNames[0])
          .map(t => new TaskNode(t, teamNames[0]));
      }
      return teamNames
        .filter(name => this.state.getTasks(name).length > 0)
        .map(name => new TeamTaskGroup(name));
    }

    if (element instanceof TeamTaskGroup) {
      if (this.groupByAgent) {
        return this.getAgentGroupsForTeam(element.teamName);
      }
      return this.state.getTasks(element.teamName)
        .map(t => new TaskNode(t, element.teamName));
    }

    if (element instanceof AgentTaskGroup) {
      return this.state.getTasks(element.teamName)
        .filter(t => t.subject === element.agentName)
        .map(t => new TaskNode(t, element.teamName));
    }

    return [];
  }

  private getAgentGroupsForTeam(teamName: string): AgentTaskGroup[] {
    const tasks = this.state.getTasks(teamName);
    const agents = [...new Set(tasks.map(t => t.subject))];
    return agents.map(agent => new AgentTaskGroup(agent, teamName));
  }

  private getTeamGroupItem(group: TeamTaskGroup): vscode.TreeItem {
    const tasks = this.state.getTasks(group.teamName);
    const completed = tasks.filter(t => this.state.getEffectiveTaskStatus(group.teamName, t) === 'completed').length;
    const item = new vscode.TreeItem(
      group.teamName,
      vscode.TreeItemCollapsibleState.Expanded
    );
    item.description = `${completed}/${tasks.length} done`;
    item.iconPath = new vscode.ThemeIcon('checklist');
    return item;
  }

  private getAgentGroupItem(group: AgentTaskGroup): vscode.TreeItem {
    const tasks = this.state.getTasks(group.teamName)
      .filter(t => t.subject === group.agentName);
    const completed = tasks.filter(t => this.state.getEffectiveTaskStatus(group.teamName, t) === 'completed').length;
    const inProgress = tasks.filter(t => this.state.getEffectiveTaskStatus(group.teamName, t) === 'in_progress').length;
    const pending = tasks.length - completed - inProgress;

    const item = new vscode.TreeItem(
      group.agentName,
      vscode.TreeItemCollapsibleState.Expanded
    );

    const parts: string[] = [];
    if (completed > 0) { parts.push(`${completed} done`); }
    if (inProgress > 0) { parts.push(`${inProgress} active`); }
    if (pending > 0) { parts.push(`${pending} pending`); }
    item.description = parts.join(', ');

    item.iconPath = new vscode.ThemeIcon('person');
    item.contextValue = 'agentTaskGroup';
    return item;
  }

  private getTaskItem(node: TaskNode): vscode.TreeItem {
    const { task } = node;
    const blocked = task.blockedBy.length > 0 && task.status === 'pending';

    // In agent-grouped mode, don't repeat the agent name in the label
    const label = this.groupByAgent
      ? `#${task.id} ${task.description}`
      : `#${task.id} ${task.subject}`;

    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

    // Description
    const descParts: string[] = [];
    if (!this.groupByAgent && task.description) {
      descParts.push(task.description);
    }
    if (blocked) {
      descParts.push(`blocked by #${task.blockedBy.join(', #')}`);
    }
    item.description = descParts.join(' — ');

    // Icon based on effective status
    const effectiveStatus = this.state.getEffectiveTaskStatus(node.teamName, task);
    if (blocked) {
      item.iconPath = new vscode.ThemeIcon('lock', new vscode.ThemeColor('charts.yellow'));
    } else {
      const statusInfo = STATUS_ICONS[effectiveStatus] ?? STATUS_ICONS.pending;
      item.iconPath = new vscode.ThemeIcon(
        statusInfo.icon,
        statusInfo.color ? new vscode.ThemeColor(statusInfo.color) : undefined
      );
    }

    // Tooltip
    const tipLines = [
      `Task #${task.id}: ${task.subject}`,
      `Status: ${effectiveStatus}${effectiveStatus !== task.status ? ` (was ${task.status})` : ''}`,
    ];
    if (task.description) { tipLines.push(`Description: ${task.description}`); }
    if (task.blockedBy.length) { tipLines.push(`Blocked by: #${task.blockedBy.join(', #')}`); }
    if (task.blocks.length) { tipLines.push(`Blocks: #${task.blocks.join(', #')}`); }
    item.tooltip = tipLines.join('\n');

    // Click to open in dashboard
    item.command = {
      command: 'agentTeams.showTask',
      title: 'Show Task Details',
      arguments: [task, node.teamName],
    };

    item.contextValue = 'task';
    return item;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
