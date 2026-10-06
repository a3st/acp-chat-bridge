import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { realpath } from 'node:fs/promises';
import type * as acp from '@agentclientprotocol/sdk';
import { Connections } from './connections';
import { AgentSession, type Host } from './runtime';

const vendor = 'acp-chat-bridge';
const participantId = 'acp-chat-bridge.chat';
interface Metadata { sessionKey: string; turnId: string; connectionId: string }
interface Entry { session: AgentSession; turnId: string; lastUsed: number }

function abortToken(token: vscode.CancellationToken) {
  const controller = new AbortController();
  const registration = token.onCancellationRequested(() => controller.abort(new vscode.CancellationError()));
  if (token.isCancellationRequested) controller.abort(new vscode.CancellationError());
  return { signal: controller.signal, dispose: () => registration.dispose() };
}

async function pick<T extends vscode.QuickPickItem>(items: T[], title: string, signal: AbortSignal): Promise<T | undefined> {
  const source = new vscode.CancellationTokenSource();
  const cancel = () => source.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) source.cancel();
  try { return await vscode.window.showQuickPick(items, { title }, source.token); }
  finally { signal.removeEventListener('abort', cancel); source.dispose(); }
}

// Canonicalize even a new file's existing ancestor so symlinks cannot escape the workspace.
async function canonical(file: string): Promise<string> {
  try { return await realpath(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await canonical(parent), path.basename(file));
  }
}
async function workspaceFile(file: string): Promise<vscode.Uri> {
  if (!vscode.workspace.isTrusted || !path.isAbsolute(file)) throw new Error(vscode.l10n.t("ACP requires a trusted workspace and an absolute path."));
  const resolved = await canonical(file);
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = await canonical(folder.uri.fsPath);
    const relative = path.relative(root, resolved);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) return vscode.Uri.file(file);
  }
  throw new Error(vscode.l10n.t("File is outside the workspace: {0}", file));
}

export function activate(context: vscode.ExtensionContext) {
  const connections = new Connections(context);
  const output = vscode.window.createOutputChannel('ACP');
  const sessions = new Map<string, Entry>();
  const directSessions = new Set<AgentSession>();
  const host: Host = {
    translate: (message, ...args) => vscode.l10n.t(message, ...args),
    log: text => output.append(text),
    permission: async (request, signal) => {
      const kinds = {
        allow_once: vscode.l10n.t('Allow once'), allow_always: vscode.l10n.t('Allow always'),
        reject_once: vscode.l10n.t('Reject once'), reject_always: vscode.l10n.t('Reject always')
      };
      const choice = await pick(request.options.map(o => ({ label: o.name, description: kinds[o.kind], optionId: o.optionId })), `ACP: ${request.toolCall.title ?? ''}`, signal);
      return { outcome: choice && !signal.aborted ? { outcome: 'selected', optionId: choice.optionId } : { outcome: 'cancelled' } };
    },
    authenticate: async (methods, signal) => {
      const choice = await pick(methods.map(m => ({ label: m.name, description: m.description ?? '', id: m.id })), vscode.l10n.t("ACP: authentication method"), signal);
      if (!choice || signal.aborted) throw new vscode.CancellationError();
      return choice.id;
    },
    read: async request => {
      const uri = await workspaceFile(request.path);
      const document = await vscode.workspace.openTextDocument(uri);
      const lines = document.getText().split(/\r?\n/);
      const start = (request.line ?? 1) - 1;
      return { content: lines.slice(start, request.limit == null ? undefined : start + request.limit).join('\n') };
    },
    write: async request => {
      const uri = await workspaceFile(request.path);
      const edit = new vscode.WorkspaceEdit();
      let document: vscode.TextDocument | undefined;
      try { await vscode.workspace.fs.stat(uri); document = await vscode.workspace.openTextDocument(uri); }
      catch (error) { if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') throw error; }
      if (document) edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), request.content);
      else { edit.createFile(uri, { overwrite: false }); edit.insert(uri, new vscode.Position(0, 0), request.content); }
      if (!await vscode.workspace.applyEdit(edit)) throw new Error(vscode.l10n.t("Could not modify {0}", request.path));
      const changed = await vscode.workspace.openTextDocument(uri);
      if (!await changed.save()) throw new Error(vscode.l10n.t("Could not save {0}", request.path));
      return {};
    }
  };
  async function cwd(signal: AbortSignal) {
    if (!vscode.workspace.isTrusted) throw new Error(vscode.l10n.t("Trust the workspace folder first."));
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) throw new Error(vscode.l10n.t("Open a workspace folder before starting ACP."));
    if (folders.length === 1) return folders[0].uri.fsPath;
    const choice = await pick(folders.map(f => ({ label: f.name, folder: f })), vscode.l10n.t("ACP: agent workspace folder"), signal);
    if (!choice) throw new vscode.CancellationError();
    return choice.folder.uri.fsPath;
  }
  const changed = connections.onDidChange(() => {
    for (const [key, entry] of sessions) if (!connections.get(entry.session.config.id)) { entry.session.dispose(); sessions.delete(key); }
    for (const session of directSessions) if (!connections.get(session.config.id)) session.dispose();
  });
  const provider: vscode.LanguageModelChatProvider = {
    onDidChangeLanguageModelChatInformation: connections.onDidChange,
    provideLanguageModelChatInformation: () => connections.all.map(c => ({
      id: c.id, name: `ACP · ${c.name}`, family: `acp/${c.id}`, version: '1',
      // ACP doesn't expose a tokenizer or context limits. Conservative UI estimates only.
      maxInputTokens: 32768, maxOutputTokens: 8192, capabilities: { toolCalling: false, imageInput: false },
      tooltip: vscode.l10n.t("ACP agent: {0}", c.command), detail: 'ACP'
    })),
    provideTokenCount: async (_model, text) => Math.ceil((typeof text === 'string' ? text : JSON.stringify(text.content)).length / 3),
    provideLanguageModelChatResponse: async (model, messages, _options, progress, token) => {
      const config = connections.get(model.id);
      if (!config) throw new Error(vscode.l10n.t("The ACP connection was removed."));
      const cancellation = abortToken(token);
      let session: AgentSession | undefined;
      try {
        session = new AgentSession(config, await cwd(cancellation.signal), host);
        directSessions.add(session);
        // Direct model usage has no stable chat session ID. Replay context in a fresh ACP session.
        const text = messages.map(m => `${m.role === vscode.LanguageModelChatMessageRole.User ? 'User' : 'Assistant'}: ${m.content.map(p => p instanceof vscode.LanguageModelTextPart ? p.value : '').join('')}`).join('\n\n');
        await session.prompt([{ type: 'text', text }], { text: t => progress.report(new vscode.LanguageModelTextPart(t)), progress: () => {} }, cancellation.signal);
      } finally { if (session) { session.dispose(); directSessions.delete(session); } cancellation.dispose(); }
    }
  };
  const participant = vscode.chat.createChatParticipant(participantId, async (request, chatContext, stream, token): Promise<vscode.ChatResult> => {
    if (request.command === 'connections') { await connections.manage(); stream.markdown(vscode.l10n.t("Select an ACP connection in the model picker below the input field.")); return {}; }
    const cancellation = abortToken(token);
    let key: string | undefined;
    try {
      const previous = [...chatContext.history].reverse().find(t => t instanceof vscode.ChatResponseTurn && t.participant === participantId) as vscode.ChatResponseTurn | undefined;
      const metadata = previous?.result.metadata as Metadata | undefined;
      const modelId = request.model.vendor === vendor ? request.model.family.replace(/^acp\//, '') : undefined;
      const config = connections.get(modelId ?? connections.selected ?? '');
      if (!config) {
        stream.markdown(vscode.l10n.t("Add an ACP connection, then select it in the model picker below the input field."));
        stream.button({ command: 'acp.manageConnections', title: vscode.l10n.t("ACP connections") });
        return {};
      }
      stream.progress(`ACP: ${config.name}`);
      let entry = metadata ? sessions.get(metadata.sessionKey) : undefined;
      if (request.command === 'new') {
        entry?.session.dispose();
        if (metadata) sessions.delete(metadata.sessionKey);
        entry = undefined;
      }
      if (!entry || entry.session.closed || entry.session.isBusy || entry.session.config.id !== config.id || entry.turnId !== metadata?.turnId) {
        entry = undefined;
      }
      key = entry && metadata ? metadata.sessionKey : randomUUID();
      if (!entry) {
        for (const [oldKey, oldEntry] of sessions) if (oldEntry.session.closed) sessions.delete(oldKey);
        if (sessions.size >= 32) {
          const oldest = [...sessions.entries()].filter(([, e]) => !e.session.isBusy).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
          if (!oldest) throw new Error(vscode.l10n.t("Too many concurrent ACP requests. Wait for the current requests to finish."));
          oldest[1].session.dispose(); sessions.delete(oldest[0]);
        }
        entry = { session: new AgentSession(config, await cwd(cancellation.signal), host), turnId: '', lastUsed: Date.now() };
        sessions.set(key, entry);
      }
      const prompt: acp.ContentBlock[] = [];
      if (!entry.turnId && request.command !== 'new' && chatContext.history.length) {
        const history = chatContext.history.map(t => t instanceof vscode.ChatRequestTurn ? `User: ${t.prompt}` : `Assistant: ${t.response.map(p => p instanceof vscode.ChatResponseMarkdownPart ? p.value.value : '').join('')}`).join('\n\n');
        prompt.push({ type: 'text', text: `Previous conversation (context):\n${history}` });
      }
      prompt.push({ type: 'text', text: request.prompt || vscode.l10n.t("Start a new session and confirm that you are ready.") });
      for (const reference of request.references) {
        const value = reference.value;
        if (value instanceof vscode.Uri || value instanceof vscode.Location) {
          const uri = value instanceof vscode.Location ? value.uri : value;
          if (uri.scheme !== 'file') continue;
          await workspaceFile(uri.fsPath);
          const document = await vscode.workspace.openTextDocument(uri);
          const text = value instanceof vscode.Location ? document.getText(value.range) : document.getText();
          if (Buffer.byteLength(text, 'utf8') > 512 * 1024) throw new Error(vscode.l10n.t("Attachment is too large: {0}", uri.fsPath));
          prompt.push({ type: 'text', text: `Attached file: ${uri.fsPath}\n${text}` });
          stream.reference(value);
        } else if (typeof value === 'string') prompt.push({ type: 'text', text: value });
      }
      await entry.session.prompt(prompt, { text: t => stream.markdown(t), progress: t => stream.progress(t) }, cancellation.signal);
      entry.turnId = randomUUID();
      entry.lastUsed = Date.now();
      return { metadata: { sessionKey: key, turnId: entry.turnId, connectionId: config.id } satisfies Metadata };
    } catch (error) {
      if (key) { sessions.get(key)?.session.dispose(); sessions.delete(key); }
      if (token.isCancellationRequested) return {};
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(message);
      return { errorDetails: { message } };
    } finally { cancellation.dispose(); }
  });
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'icon.png');
  context.subscriptions.push(connections, output, changed, participant,
    vscode.lm.registerLanguageModelChatProvider(vendor, provider),
    vscode.commands.registerCommand('acp.manageConnections', () => connections.manage()),
    vscode.commands.registerCommand('acp.addConnection', () => connections.add()),
    vscode.commands.registerCommand('acp.removeConnection', () => connections.remove()),
    vscode.commands.registerCommand('acp.openChat', () => vscode.commands.executeCommand('workbench.action.chat.open', { query: '@acp-agent ' })),
    { dispose: () => { for (const entry of sessions.values()) entry.session.dispose(); sessions.clear(); for (const session of directSessions) session.dispose(); directSessions.clear(); } }
  );
}
