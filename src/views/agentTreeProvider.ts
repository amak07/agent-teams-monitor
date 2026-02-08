import * as vscode from 'vscode';
import { TeamStateManager } from '../state/teamState';
import { TeamConfig, TeamMember, isTeamLead } from '../types';

type AgentTreeElement = TeamNode | MemberNode;

class TeamNode {
  constructor(public readonly config: TeamConfig) {}
}

class MemberNode {
  constructor(
    public readonly member: TeamMember,
    public readonly teamName: string
  ) {}
}

// Map color names to ThemeColor IDs for the colored dots
const COLOR_MAP: Record<string, string> = {
  blue: 'charts.blue',
  green: 'charts.green',
  red: 'charts.red',
  yellow: 'charts.yellow',
  orange: 'charts.orange',
  purple: 'charts.purple',
};

export class AgentTreeProvider implements vscode.TreeDataProvider<AgentTreeElement> {
  private _onDidChangeTreeData = new vscode.EventEmitter<AgentTreeElement | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private state: TeamStateManager) {
    state.onDidChange(e => {
      if (e.type === 'teamAdded' || e.type === 'teamUpdated' || e.type === 'teamRemoved' || e.type === 'messageReceived') {
        this._onDidChangeTreeData.fire(undefined);
      }
    });
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: AgentTreeElement): vscode.TreeItem {
    if (element instanceof TeamNode) {
      return this.getTeamItem(element);
    }
    return this.getMemberItem(element);
  }

  getChildren(element?: AgentTreeElement): AgentTreeElement[] {
    if (!element) {
      // Root: list all teams
      return this.state.getFilteredTeams().map(t => new TeamNode(t));
    }
    if (element instanceof TeamNode) {
      // Children: team members
      return element.config.members.map(m => new MemberNode(m, element.config.name));
    }
    return [];
  }

  private getTeamItem(node: TeamNode): vscode.TreeItem {
    const { config } = node;
    const agentCount = config.members.length;
    const item = new vscode.TreeItem(
      config.name,
      vscode.TreeItemCollapsibleState.Expanded
    );
    item.description = `${agentCount} agent${agentCount !== 1 ? 's' : ''}`;
    item.tooltip = config.description || config.name;
    item.contextValue = 'team';
    item.iconPath = new vscode.ThemeIcon('organization');
    return item;
  }

  private getMemberItem(node: MemberNode): vscode.TreeItem {
    const { member } = node;
    const lead = isTeamLead(member);
    const lifecycle = lead ? 'active' : this.state.getAgentLifecycleState(node.teamName, member.name);
    const item = new vscode.TreeItem(member.name, vscode.TreeItemCollapsibleState.None);

    // Description: lifecycle + agent type + model
    const parts: string[] = [];
    if (lifecycle !== 'active') {
      parts.push(lifecycle.replace('_', ' '));
    }
    if (member.agentType && member.agentType !== 'team-lead') {
      parts.push(member.agentType);
    }
    if (member.model) {
      parts.push(member.model);
    }
    item.description = parts.join(' · ');

    // Icon based on lifecycle state
    if (lead) {
      item.iconPath = new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'));
    } else if (lifecycle === 'shutdown') {
      item.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
    } else if (lifecycle === 'shutting_down') {
      item.iconPath = new vscode.ThemeIcon('sign-out', new vscode.ThemeColor('charts.orange'));
    } else if (lifecycle === 'idle') {
      item.iconPath = new vscode.ThemeIcon('clock', new vscode.ThemeColor('charts.yellow'));
    } else {
      const colorId = member.color ? COLOR_MAP[member.color] : undefined;
      item.iconPath = new vscode.ThemeIcon(
        'circle-filled',
        colorId ? new vscode.ThemeColor(colorId) : undefined
      );
    }

    // Tooltip with details
    const tipLines = [`Agent: ${member.name}`];
    tipLines.push(`Status: ${lifecycle.replace('_', ' ')}`);
    if (member.agentType) { tipLines.push(`Type: ${member.agentType}`); }
    if (member.model) { tipLines.push(`Model: ${member.model}`); }
    if (member.cwd) { tipLines.push(`CWD: ${member.cwd}`); }
    if (member.backendType) { tipLines.push(`Backend: ${member.backendType}`); }
    item.tooltip = tipLines.join('\n');

    item.contextValue = lead ? 'teamLead' : 'teammate';
    return item;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
