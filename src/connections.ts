import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { ConnectionConfig } from './runtime';

export class Connections implements vscode.Disposable {
  private event = new vscode.EventEmitter<void>();
  readonly onDidChange = this.event.event;
  constructor(private context: vscode.ExtensionContext) {}
  get all(): ConnectionConfig[] { return this.context.globalState.get<ConnectionConfig[]>('acp.connections', []); }
  get selected(): string | undefined { return this.context.globalState.get<string>('acp.selected'); }
  get(id: string) { return this.all.find(c => c.id === id); }
  async manage(): Promise<void> {
    const choice = await vscode.window.showQuickPick([
      ...this.all.map(c => ({ label: c.name, description: c.id === this.selected ? vscode.l10n.t("Selected") : c.command, id: c.id })),
      { label: `$(add) ${vscode.l10n.t("Add ACP")}`, id: 'add' },
      { label: `$(trash) ${vscode.l10n.t("Remove ACP")}`, id: 'remove' },
      { label: `$(refresh) ${vscode.l10n.t("Refresh ACP models")}`, id: 'refresh' }
    ], { title: vscode.l10n.t("ACP: connections"), placeHolder: vscode.l10n.t("Select a connection or an action") });
    if (!choice) return;
    if (choice.id === 'add') await this.add();
    else if (choice.id === 'remove') await this.remove();
    else if (choice.id === 'refresh') this.event.fire();
    else { await this.context.globalState.update('acp.selected', choice.id); this.event.fire(); }
  }
  async add() {
    const name = await vscode.window.showInputBox({ title: vscode.l10n.t("ACP name"), placeHolder: vscode.l10n.t("For example, Gemini ACP"), validateInput: s => s.trim() ? undefined : vscode.l10n.t("Enter a name") });
    if (name === undefined) return;
    const command = await vscode.window.showInputBox({ title: vscode.l10n.t("ACP launch command"), prompt: vscode.l10n.t("Executable without arguments; on Windows, use .exe or node.exe."), placeHolder: 'node', validateInput: s => !s.trim() ? vscode.l10n.t("Enter a command") : /\.(cmd|bat)$/i.test(s.trim()) ? vscode.l10n.t("Use .exe or node.exe with the CLI path in the arguments") : undefined });
    if (command === undefined) return;
    const args = await vscode.window.showInputBox({ title: vscode.l10n.t("ACP launch arguments"), prompt: vscode.l10n.t("JSON array of strings. The agent must support ACP over stdio."), value: '[]', validateInput: s => { try { const v: unknown = JSON.parse(s); if (Array.isArray(v) && v.every(x => typeof x === 'string')) return undefined; } catch {} return vscode.l10n.t("Enter a JSON array of strings, for example [\"C:/agents/cli.js\", \"--acp\"]"); } });
    if (args === undefined) return;
    const entry: ConnectionConfig = { id: randomUUID(), name: name.trim(), command: command.trim(), args: JSON.parse(args) as string[] };
    await this.context.globalState.update('acp.connections', [...this.all, entry]);
    await this.context.globalState.update('acp.selected', entry.id);
    this.event.fire();
  }
  async remove() {
    const choice = await vscode.window.showQuickPick(this.all.map(c => ({ label: c.name, id: c.id })), { title: vscode.l10n.t("Remove ACP connection") });
    if (!choice) return;
    const rest = this.all.filter(c => c.id !== choice.id);
    await this.context.globalState.update('acp.connections', rest);
    if (choice.id === this.selected) await this.context.globalState.update('acp.selected', rest[0]?.id);
    this.event.fire();
  }
  dispose() { this.event.dispose(); }
}
