import * as vscode from 'vscode';
import { TeamStateManager } from '../state/teamState';

export class StatusBarManager {
  private item: vscode.StatusBarItem;

  constructor(private state: TeamStateManager) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = 'agentTeams.focus';

    state.onDidChange(() => this.update());
    this.update();
  }

  private update(): void {
    const teams = this.state.getFilteredTeams();
    if (teams.length === 0) {
      this.item.hide();
      return;
    }

    const totalAgents = teams.reduce((sum, t) => sum + t.members.length, 0);

    let totalTasks = 0;
    let remainingTasks = 0;
    for (const team of teams) {
      const tasks = this.state.getTasks(team.name);
      totalTasks += tasks.length;
      remainingTasks += tasks.filter(t => this.state.getEffectiveTaskStatus(team.name, t) !== 'completed').length;
    }

    const parts = [`$(hubot) ${totalAgents} agent${totalAgents !== 1 ? 's' : ''}`];
    if (totalTasks > 0) {
      parts.push(`${remainingTasks} task${remainingTasks !== 1 ? 's' : ''} left`);
    }

    this.item.text = parts.join(' · ');
    this.item.tooltip = teams.map(t => t.name).join(', ');
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
