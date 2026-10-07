import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

export interface ConnectionConfig { id: string; name: string; command: string; args: string[] }
export interface Host {
  translate?(message: string, ...args: Array<string | number | boolean>): string;
  permission(request: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse>;
  authenticate(methods: acp.AuthMethod[], signal: AbortSignal): Promise<string>;
  read(request: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse>;
  write(request: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse>;
  log(text: string): void;
}
export interface AgentModel { id: string; name: string; description?: string; current?: boolean }
export type AgentMode = AgentModel;
export interface Sink { text(text: string): void; progress(text: string): void }

/** One process and ACP session per native chat conversation and connection. */
export class AgentSession {
  private process?: ChildProcessWithoutNullStreams;
  private connection?: acp.ClientConnection;
  private sessionId?: string;
  private legacyModes?: acp.SessionModeState | null;
  private configOptions: acp.SessionConfigOption[] = [];
  private legacyModels?: { currentModelId?: string; availableModels: Array<{ modelId: string; name: string; description?: string }> };
  private sink?: Sink;
  private turnSignal?: AbortSignal;
  private busy = false;
  private receivedText = false;
  private commands: acp.AvailableCommand[] = [];
  private disposed = false;
  private lifetime = new AbortController();
  constructor(readonly config: ConnectionConfig, private cwd: string, private host: Host) {}

  private t(message: string, ...args: Array<string | number | boolean>): string {
    return this.host.translate?.(message, ...args) ?? message.replace(/\{(\d+)\}/g, (placeholder, index: string) => String(args[Number(index)] ?? placeholder));
  }

  private async start(signal: AbortSignal) {
    if (this.connection && !this.connection.signal.aborted && this.sessionId) return;
    if (this.disposed) throw new Error(this.t("The ACP session is closed. Start a new chat with ACP: Open Chat."));
    if (/\.(cmd|bat)$/i.test(this.config.command)) {
      throw new Error(this.t("On Windows, use an executable .exe or node.exe with the CLI path in the arguments instead of .cmd/.bat."));
    }
    const child = spawn(this.config.command, this.config.args, { cwd: this.cwd, stdio: 'pipe', windowsHide: true, shell: false });
    this.process = child;
    child.stderr.on('data', (chunk: Buffer) => this.host.log(chunk.toString()));
    child.on('error', error => this.connection?.close(new Error(this.t("Could not start {0}: {1}", this.config.name, error.message))));
    child.on('exit', (code, sig) => this.connection?.close(new Error(this.t("ACP {0} exited ({1}).", this.config.name, String(code ?? sig)))));
    child.stdin.on('error', error => this.connection?.close(error));
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    // Older ACP agents used the now-removed models field. Capture it before SDK validation.
    stream.readable = stream.readable.pipeThrough(new TransformStream({
      transform: (message, controller) => {
        const result = (message as { result?: { sessionId?: string; models?: unknown } }).result;
        if (result?.sessionId && result.models && typeof result.models === 'object') {
          const models = result.models as NonNullable<AgentSession['legacyModels']>;
          if (Array.isArray(models.availableModels)) this.legacyModels = {
            currentModelId: models.currentModelId,
            availableModels: models.availableModels.filter(m => typeof m?.modelId === 'string' && typeof m?.name === 'string')
          };
        }
        controller.enqueue(message);
      }
    }));
    this.connection = acp.client({ name: 'acp-chat-bridge' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        if (params.sessionId !== this.sessionId) return;
        const update = params.update;
        if (update.sessionUpdate === 'available_commands_update') { this.commands = update.availableCommands; return; }
        if (update.sessionUpdate === 'current_mode_update') { if (this.legacyModes) this.legacyModes.currentModeId = update.currentModeId; return; }
        if (update.sessionUpdate === 'config_option_update') { this.configOptions = update.configOptions; return; }
        if (!this.sink || this.turnSignal?.aborted) return;
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
          if (update.content.text.trim()) this.receivedText = true;
          this.sink.text(update.content.text);
        }
        else if (update.sessionUpdate === 'tool_call') this.sink.progress(update.title);
        else if (update.sessionUpdate === 'tool_call_update' && update.title) this.sink.progress(update.title);
        else if (update.sessionUpdate === 'plan') {
          const statuses = { pending: this.t('Pending'), in_progress: this.t('In progress'), completed: this.t('Completed') };
          this.sink.progress(update.entries.map(e => `${statuses[e.status]}: ${e.content}`).join('\n'));
        }
      })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        if (params.sessionId !== this.sessionId || !this.turnSignal || this.turnSignal.aborted) return { outcome: { outcome: 'cancelled' } };
        return this.host.permission(params, AbortSignal.any([this.turnSignal, this.lifetime.signal]));
      })
      .onRequest(acp.methods.client.fs.readTextFile, ({ params }) => { this.assertActive(params.sessionId); return this.host.read(params); })
      .onRequest(acp.methods.client.fs.writeTextFile, ({ params }) => { this.assertActive(params.sessionId); return this.host.write(params); })
      .connect(stream);
    const startupSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000), this.lifetime.signal]);
    const startupCancelled = () => this.dispose();
    startupSignal.addEventListener('abort', startupCancelled, { once: true });
    try {
    const init = await this.connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: 'acp-chat-bridge', version: '0.1.16' },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }
    }, { cancellationSignal: startupSignal });
    if (init.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error(this.t("Unsupported ACP version: {0}", init.protocolVersion));
    try { await this.createSession(startupSignal); }
    catch (error) {
      if (!(error instanceof acp.RequestError) || error.code !== -32000 || !init.authMethods?.length) throw error;
      const methodId = await this.host.authenticate(init.authMethods, startupSignal);
      await this.connection.agent.request(acp.methods.agent.authenticate, { methodId }, { cancellationSignal: startupSignal });
      await this.createSession(startupSignal);
    }
    } finally { startupSignal.removeEventListener('abort', startupCancelled); }
  }
  private async createSession(signal: AbortSignal) {
    const result = await this.connection!.agent.request(acp.methods.agent.session.new, { cwd: this.cwd, mcpServers: [] }, { cancellationSignal: signal });
    this.sessionId = result.sessionId;
    this.configOptions = result.configOptions ?? [];
    this.legacyModes = result.modes;
  }
  async discoverModels(signal: AbortSignal): Promise<AgentModel[]> {
    if (signal.aborted) throw signal.reason;
    await this.start(signal);
    return this.availableModels;
  }
  get availableModels(): AgentModel[] {
    const option = this.configOptions.find(o => o.type === 'select' && (o.category === 'model' || o.id === 'model'));
    if (option?.type === 'select') {
      return option.options.flatMap(item => 'options' in item ? item.options : [item]).map(item => ({
        id: item.value, name: item.name, description: item.description ?? undefined, current: item.value === option.currentValue
      }));
    }
    return this.legacyModels?.availableModels.map(m => ({ id: m.modelId, name: m.name, description: m.description, current: m.modelId === this.legacyModels?.currentModelId })) ?? [];
  }
  get availableModes(): AgentMode[] {
    const option = this.configOptions.find(o => o.type === 'select' && (o.category === 'mode' || o.id === 'mode'));
    if (option?.type === 'select') return option.options.flatMap(item => 'options' in item ? item.options : [item]).map(item => ({
      id: item.value, name: item.name, description: item.description ?? undefined, current: item.value === option.currentValue
    }));
    return this.legacyModes?.availableModes.map(m => ({ id: m.id, name: m.name, description: m.description ?? undefined, current: m.id === this.legacyModes?.currentModeId })) ?? [];
  }
  private async selectMode(modeId: string, signal: AbortSignal) {
    const mode = this.availableModes.find(m => m.id === modeId);
    if (!mode) throw new Error(this.t("The ACP agent no longer offers mode: {0}", modeId));
    if (mode.current) return;
    const option = this.configOptions.find(o => o.type === 'select' && (o.category === 'mode' || o.id === 'mode'));
    if (option) {
      const result = await this.connection!.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: this.sessionId!, configId: option.id, value: modeId
      }, { cancellationSignal: signal });
      this.configOptions = result.configOptions;
      if (!this.availableModes.find(m => m.id === modeId)?.current) throw new Error(this.t("The ACP agent did not select mode: {0}", modeId));
    } else {
      await this.connection!.agent.request(acp.methods.agent.session.setMode, { sessionId: this.sessionId!, modeId }, { cancellationSignal: signal });
      this.legacyModes!.currentModeId = modeId;
    }
  }
  private async selectModel(modelId: string, signal: AbortSignal) {
    const model = this.availableModels.find(m => m.id === modelId);
    if (!model) throw new Error(this.t("The ACP agent no longer offers model: {0}", modelId));
    if (model.current) return;
    const option = this.configOptions.find(o => o.type === 'select' && (o.category === 'model' || o.id === 'model'));
    if (option) {
      const result = await this.connection!.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: this.sessionId!, configId: option.id, value: modelId
      }, { cancellationSignal: signal });
      this.configOptions = result.configOptions;
      if (!this.availableModels.find(m => m.id === modelId)?.current) throw new Error(this.t("The ACP agent did not select model: {0}", modelId));
    } else {
      await this.connection!.agent.request('session/set_model', { sessionId: this.sessionId!, modelId }, { cancellationSignal: signal });
      this.legacyModels!.currentModelId = modelId;
    }
  }
  private assertActive(sessionId: string) {
    if (sessionId !== this.sessionId || !this.turnSignal || this.turnSignal.aborted || this.disposed) throw new Error(this.t("No active ACP request."));
  }
  async prompt(prompt: acp.ContentBlock[], sink: Sink, signal: AbortSignal, modelId?: string, modeId?: string) {
    if (this.busy) throw new Error(this.t("An ACP request is already running in this session."));
    if (signal.aborted) throw signal.reason;
    this.busy = true;
    this.receivedText = false;
    this.sink = sink;
    this.turnSignal = signal;
    // Close after cancellation: a cancelled session must never emit into a later turn.
    const cancel = () => {
      if (this.connection && this.sessionId) void this.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.sessionId }).catch(() => {});
      this.dispose();
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await this.start(signal);
      if (modeId) await this.selectMode(modeId, signal);
      if (modelId) await this.selectModel(modelId, signal);
      const result = await this.connection!.agent.request(acp.methods.agent.session.prompt, { sessionId: this.sessionId!, prompt }, { cancellationSignal: signal });
      if (result.stopReason === 'end_turn' && !this.receivedText) {
        const first = prompt[0];
        const command = first?.type === 'text' ? /^\/([^\s]+)(?:\s|$)/.exec(first.text)?.[1] : undefined;
        if (command && this.commands.some(c => c.name === command)) {
          sink.text(this.t("ACP command completed: /{0}", command));
        } else {
          throw new Error(this.t("The ACP agent finished without a text response. Check Output > ACP and the CLI provider authentication."));
        }
      }
      if (result.stopReason !== 'end_turn') {
        const reasons = {
          cancelled: this.t('Cancelled'), max_tokens: this.t('Maximum tokens reached'),
          max_turn_requests: this.t('Maximum turns reached'), refusal: this.t('Refused')
        };
        sink.progress(`ACP: ${reasons[result.stopReason] ?? result.stopReason}`);
      }
    } catch (error) { this.dispose(); throw error; }
    finally {
      signal.removeEventListener('abort', cancel);
      this.busy = false; this.sink = undefined; this.turnSignal = undefined;
    }
  }
  get closed() { return this.disposed || this.connection?.signal.aborted === true; }
  get isBusy() { return this.busy; }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.connection?.close();
    if (this.process?.pid && this.process.exitCode === null) {
      if (process.platform === 'win32') {
        const cleanup = spawn('taskkill.exe', ['/pid', String(this.process.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        cleanup.on('error', () => this.process?.kill());
      } else this.process.kill();
    }
  }
}
