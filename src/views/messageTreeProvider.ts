import * as vscode from 'vscode';
import { TeamStateManager } from '../state/teamState';
import { InboxEntry, parseTypedMessage, TypedMessage } from '../types';
import { formatTime } from '../utils';

type MessageTreeElement = TeamMessageGroup | InboxGroup | MessageNode;

class TeamMessageGroup {
  constructor(public readonly teamName: string) {}
}

class InboxGroup {
  constructor(
    public readonly agentName: string,
    public readonly teamName: string
  ) {}
}

class MessageNode {
  constructor(
    public readonly entry: InboxEntry,
    public readonly teamName: string,
    public readonly inboxOwner: string
  ) {}
}

// Badge labels for typed messages
function getTypeBadge(typed: TypedMessage): string {
  switch (typed.type) {
    case 'permission_request': return 'permission';
    case 'permission_response': return typed.approve ? 'approved' : 'denied';
    case 'idle_notification': return 'idle';
    case 'shutdown_request': return 'shutdown req';
    case 'shutdown_approved': return 'shutdown ok';
    case 'plan_approval_request': return 'plan review';
    case 'plan_approval_response': return typed.approved ? 'plan ok' : 'plan rejected';
    default: return 'system';
  }
}

function getTypeIcon(typed: TypedMessage): vscode.ThemeIcon {
  switch (typed.type) {
    case 'permission_request': return new vscode.ThemeIcon('shield');
    case 'permission_response': return new vscode.ThemeIcon('shield');
    case 'idle_notification': return new vscode.ThemeIcon('clock');
    case 'shutdown_request': return new vscode.ThemeIcon('sign-out');
    case 'shutdown_approved': return new vscode.ThemeIcon('sign-out');
    case 'plan_approval_request': return new vscode.ThemeIcon('request-changes');
    case 'plan_approval_response': return typed.approved ? new vscode.ThemeIcon('check') : new vscode.ThemeIcon('circle-slash');
    default: return new vscode.ThemeIcon('comment');
  }
}


export class MessageTreeProvider implements vscode.TreeDataProvider<MessageTreeElement> {
  private _onDidChangeTreeData = new vscode.EventEmitter<MessageTreeElement | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private groupByInbox = false;

  constructor(private state: TeamStateManager) {
    vscode.commands.executeCommand('setContext', 'agentTeams.messages.groupedByInbox', false);
    state.onDidChange(e => {
      if (e.type === 'messageReceived' || e.type === 'teamAdded' || e.type === 'teamRemoved') {
        this._onDidChangeTreeData.fire(undefined);
      }
    });
  }

  setGroupByInbox(enabled: boolean): void {
    this.groupByInbox = enabled;
    vscode.commands.executeCommand('setContext', 'agentTeams.messages.groupedByInbox', enabled);
    this._onDidChangeTreeData.fire(undefined);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: MessageTreeElement): vscode.TreeItem {
    if (element instanceof TeamMessageGroup) {
      return this.getTeamGroupItem(element);
    }
    if (element instanceof InboxGroup) {
      return this.getInboxGroupItem(element);
    }
    return this.getMessageItem(element);
  }

  getChildren(element?: MessageTreeElement): MessageTreeElement[] {
    if (!element) {
      const teamNames = this.state.getFilteredTeamNames();
      if (teamNames.length === 0) { return []; }

      // Single team: show messages/inbox groups directly
      if (teamNames.length === 1) {
        if (this.groupByInbox) {
          return this.getInboxGroupsForTeam(teamNames[0]);
        }
        return this.getTimelineMessagesForTeam(teamNames[0]);
      }

      // Multiple teams: group by team first
      return teamNames
        .filter(name => this.teamHasMessages(name))
        .map(name => new TeamMessageGroup(name));
    }

    if (element instanceof TeamMessageGroup) {
      if (this.groupByInbox) {
        return this.getInboxGroupsForTeam(element.teamName);
      }
      return this.getTimelineMessagesForTeam(element.teamName);
    }

    if (element instanceof InboxGroup) {
      const entries = this.state.getMessages(element.teamName, element.agentName);
      return entries
        .map(e => new MessageNode(e, element.teamName, element.agentName))
        .sort((a, b) => b.entry.timestamp.localeCompare(a.entry.timestamp));
    }

    return [];
  }

  private teamHasMessages(teamName: string): boolean {
    const teamMsgs = this.state.getFilteredMessages().get(teamName);
    if (!teamMsgs) { return false; }
    for (const [, entries] of teamMsgs) {
      if (entries.length > 0) { return true; }
    }
    return false;
  }

  private getTimelineMessagesForTeam(teamName: string): MessageNode[] {
    const msgs: MessageNode[] = [];
    const teamMsgs = this.state.getFilteredMessages().get(teamName);
    if (!teamMsgs) { return msgs; }
    for (const [agentName, entries] of teamMsgs) {
      for (const entry of entries) {
        msgs.push(new MessageNode(entry, teamName, agentName));
      }
    }
    msgs.sort((a, b) => b.entry.timestamp.localeCompare(a.entry.timestamp));
    return msgs;
  }

  private getInboxGroupsForTeam(teamName: string): InboxGroup[] {
    const groups: InboxGroup[] = [];
    const teamMsgs = this.state.getFilteredMessages().get(teamName);
    if (!teamMsgs) { return groups; }
    for (const [agentName, entries] of teamMsgs) {
      if (entries.length > 0) {
        groups.push(new InboxGroup(agentName, teamName));
      }
    }
    return groups;
  }

  private getTeamGroupItem(group: TeamMessageGroup): vscode.TreeItem {
    let count = 0;
    const teamMsgs = this.state.getFilteredMessages().get(group.teamName);
    if (teamMsgs) {
      for (const [, entries] of teamMsgs) { count += entries.length; }
    }
    const item = new vscode.TreeItem(
      group.teamName,
      vscode.TreeItemCollapsibleState.Expanded
    );
    item.description = `${count} message${count !== 1 ? 's' : ''}`;
    item.iconPath = new vscode.ThemeIcon('comment-discussion');
    return item;
  }

  private getInboxGroupItem(group: InboxGroup): vscode.TreeItem {
    const entries = this.state.getMessages(group.teamName, group.agentName);
    const senders = [...new Set(entries.map(e => e.from))];

    const item = new vscode.TreeItem(
      `Messages to ${group.agentName}`,
      vscode.TreeItemCollapsibleState.Expanded
    );
    item.description = `${entries.length} from ${senders.join(', ')}`;
    item.iconPath = new vscode.ThemeIcon('inbox');
    item.contextValue = 'inboxGroup';
    return item;
  }

  private getMessageItem(node: MessageNode): vscode.TreeItem {
    const { entry, inboxOwner } = node;
    const typed = parseTypedMessage(entry.text);
    const time = formatTime(entry.timestamp);

    let label: string;
    let description: string;
    let icon: vscode.ThemeIcon;

    if (typed) {
      const badge = getTypeBadge(typed);
      if (this.groupByInbox) {
        label = `${time} [${badge}] ${entry.from}`;
      } else {
        label = `${time} [${badge}] ${entry.from} → ${inboxOwner}`;
      }
      description = entry.summary || `→ ${inboxOwner}`;
      icon = getTypeIcon(typed);
    } else {
      if (this.groupByInbox) {
        label = `${time} ${entry.from}`;
      } else {
        label = `${time} ${entry.from} → ${inboxOwner}`;
      }
      const preview = entry.summary || entry.text.slice(0, 80).replace(/\n/g, ' ');
      description = preview.length < entry.text.length ? preview + '...' : preview;
      icon = new vscode.ThemeIcon('comment');
    }

    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = description;
    item.iconPath = icon;

    // Tooltip: full message text
    const tipLines = [
      `From: ${entry.from} → ${inboxOwner}`,
      `Time: ${entry.timestamp}`,
      '',
    ];
    if (typed) {
      tipLines.push(`Type: ${typed.type}`);
      tipLines.push(JSON.stringify(typed, null, 2));
    } else {
      tipLines.push(entry.text.slice(0, 500));
      if (entry.text.length > 500) { tipLines.push('... (truncated)'); }
    }
    item.tooltip = new vscode.MarkdownString('```\n' + tipLines.join('\n') + '\n```');

    // Click to open in dashboard
    item.command = {
      command: 'agentTeams.showMessage',
      title: 'Show Full Message',
      arguments: [entry, node.teamName],
    };

    item.contextValue = typed ? `message.${typed.type}` : 'message.text';
    return item;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
