import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  console.log('Agent Teams Monitor is now active');

  // TODO: Wire up file watcher, state manager, tree views, status bar, history archiver
}

export function deactivate() {
  console.log('Agent Teams Monitor deactivated');
}
