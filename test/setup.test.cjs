const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
function harness(t, configs = []) {
  const values = new Map([['acp.connections', configs], ['acp.selected', configs[0]?.id]]);
  const commands = new Map();
  const calls = [], picks = [], inputs = [], order = [];
  let provider, handler, tool, pickCount = 0;
  class EventEmitter {
    listeners = new Set();
    event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire = () => { for (const listener of this.listeners) listener(); };
    dispose() { this.listeners.clear(); }
  }
  class Uri {
    static joinPath(_base, ...parts) { return parts.join('/'); }
  }
  class LanguageModelTextPart { constructor(value) { this.value = value; } }
  class LanguageModelToolCallPart { constructor(callId, name, input) { Object.assign(this, { callId, name, input }); } }
  class LanguageModelToolResultPart { constructor(callId, content) { Object.assign(this, { callId, content }); } }
  class LanguageModelToolResult { constructor(content) { this.content = content; } }
  const noop = { dispose() {} };
  const vscode = {
    EventEmitter, Uri, LanguageModelTextPart, LanguageModelToolCallPart, LanguageModelToolResultPart, LanguageModelToolResult,
    LanguageModelChatMessageRole: { User: 1, Assistant: 2 }, LanguageModelChatToolMode: { Auto: 1, Required: 2 },
    l10n: { t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)])) },
    workspace: { isTrusted: true }, env: {}, version: '1.140.0',
    window: {
      createOutputChannel: () => ({ append() {}, appendLine() {}, show() {}, dispose() {} }),
      showQuickPick: async items => { pickCount++; return items.find(i => i.id === picks.shift()); },
      showInputBox: async options => { const value = inputs.shift(); if (value !== undefined) assert.equal(options.validateInput?.(value), undefined); return value; }
    },
    lm: { registerTool: (_name, value) => { tool = value; return noop; }, selectChatModels: async () => values.get('acp.connections').map(c => ({ id: c.id, vendor: 'acp-chat-bridge', family: `acp/${c.id}`, name: c.name })), registerLanguageModelChatProvider: (_vendor, value) => { order.push('provider'); provider = value; return noop; } },
    chat: { createChatParticipant: (_id, value) => { order.push('participant'); handler = value; return {}; } },
    commands: {
      registerCommand: (id, callback) => { commands.set(id, callback); return noop; },
      executeCommand: async (...args) => calls.push(args)
    }
  };
  const context = {
    extensionUri: {}, subscriptions: [],
    globalState: { get: (key, fallback) => values.has(key) ? values.get(key) : fallback, update: async (key, value) => values.set(key, value) }
  };
  const file = require.resolve('../dist/extension-test.cjs');
  delete require.cache[file];
  const original = Module._load;
  Module._load = function(request, ...args) { return request === 'vscode' ? vscode : original.call(this, request, ...args); };
  try { require(file).activate(context); } finally { Module._load = original; }
  t.after(() => { for (const subscription of context.subscriptions) subscription.dispose?.(); });
  return { provider, handler, tool, commands, calls, picks, inputs, values, order, vscode, get pickCount() { return pickCount; } };
}
const config = { id: 'configured-agent', name: 'Example agent', command: 'node', args: [] };

test('cold start without connections exposes no models and does not prompt or spawn', async t => {
  const h = harness(t);
  const models = await h.provider.provideLanguageModelChatInformation({ silent: true }, token);
  assert.deepEqual(models, []);
  assert.equal(h.pickCount, 0);
  assert.deepEqual(h.order, ['provider', 'participant']);
});

test('Manage Models directly adds an ACP connection without the management menu', async t => {
  const h = harness(t);
  h.inputs.push('Example agent', 'node', '[]');
  const models = await h.provider.provideLanguageModelChatInformation({ silent: false }, token);
  assert.equal(h.pickCount, 0);
  assert.equal(models[0].name, 'ACP · Example agent');
  assert.notEqual(models[0].id, 'acp-setup');
});

test('cancelling configuration leaves the model list empty', async t => {
  const h = harness(t);
  const models = await h.provider.provideLanguageModelChatInformation({ silent: false }, token);
  assert.deepEqual(models, []);
});

test('Open Chat replaces an unavailable model and switches to Agent mode', async t => {
  const h = harness(t, [config]);
  await h.commands.get('acp.openChat')();
  assert.deepEqual(h.calls, [['workbench.action.chat.newLocalChat'], ['workbench.action.chat.open', {
    query: '@acp-agent ', isPartialQuery: true, mode: 'agent',
    modelSelector: { vendor: 'acp-chat-bridge', id: config.id }
  }]]);
});

test('Open Chat configures the first agent before opening native chat', async t => {
  const h = harness(t);
  h.inputs.push('Example agent', 'node', '[]');
  await h.commands.get('acp.openChat')();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1][1].modelSelector.id, h.values.get('acp.connections')[0].id);
});

test('cancelling first setup does not open chat with an unavailable model', async t => {
  const h = harness(t);
  await h.commands.get('acp.openChat')();
  assert.equal(h.calls.length, 0);
});

test('removing the last connection refreshes the model list to empty', async t => {
  const h = harness(t, [config]);
  let changes = 0;
  h.provider.onDidChangeLanguageModelChatInformation(() => changes++);
  h.picks.push(config.id);
  await h.commands.get('acp.removeConnection')();
  const models = await h.provider.provideLanguageModelChatInformation({ silent: true }, token);
  assert.equal(changes, 1);
  assert.deepEqual(models, []);
});

test('a stale setup selection is rejected instead of advertising a synthetic model', async t => {
  const h = harness(t);
  await assert.rejects(h.provider.provideLanguageModelChatResponse({ id: 'acp-setup' }, [], {}, { report() {} }, token), /connection was removed/);
  assert.equal(h.pickCount, 0);
});

test('unavailable ACP model reports the cause before opening native chat', async t => {
  const h = harness(t, [config]);
  h.vscode.lm.selectChatModels = async () => [];
  await assert.rejects(h.commands.get('acp.openChat')(), /The ACP model is not available/);
  assert.equal(h.calls.length, 0);
});

test('diagnostics reports ACP model availability without agent launch arguments', async t => {
  const h = harness(t, [config]);
  const report = await h.commands.get('acp.diagnostics')();
  assert.equal(report.trusted, true);
  assert.equal(report.connections, 1);
  assert.equal(report.models[0].id, config.id);
  assert.equal(report.remote, 'local');
  assert.equal(JSON.stringify(report).includes('command'), false);
  assert.equal(JSON.stringify(report).includes('args'), false);
});


test('Agent mode emits an offered ACP task tool and completes its result without running it twice', async t => {
  const h = harness(t, [config]);
  const { LanguageModelTextPart: Text, LanguageModelToolResultPart: Result } = h.vscode;
  const models = await h.provider.provideLanguageModelChatInformation({ silent: true }, token);
  assert.equal(models[0].capabilities.toolCalling, true);
  const messages = [{ role: 1, content: [new Text('Create a file')] }];
  const parts = [];
  await h.provider.provideLanguageModelChatResponse({ id: config.id }, messages, { tools: [{ name: 'acp_chat_bridge_delegate' }], toolMode: 1 }, { report: p => parts.push(p) }, token);
  assert.equal(parts.length, 1);
  const call = parts[0];
  assert.equal(call.name, 'acp_chat_bridge_delegate');
  assert.equal(call.input.connectionId, config.id);
  assert.match(call.input.prompt, /Create a file/);
  messages.push({ role: 2, content: [call] }, { role: 1, content: [new Result(call.callId, [new Text('File created')])] });
  parts.length = 0;
  await h.provider.provideLanguageModelChatResponse({ id: config.id }, messages, { tools: [{ name: call.name }], toolMode: 1 }, { report: p => parts.push(p) }, token);
  assert.deepEqual(parts.map(p => p.value), ['File created']);
  messages.push({ role: 1, content: [new Text('Now update it')] });
  parts.length = 0;
  await h.provider.provideLanguageModelChatResponse({ id: config.id }, messages, { tools: [{ name: call.name }], toolMode: 1 }, { report: p => parts.push(p) }, token);
  assert.notEqual(parts[0].callId, call.callId);
  assert.match(parts[0].input.prompt, /File created.*Now update it/s);
});

test('required tool requests cannot silently bypass a disabled ACP task tool', async t => {
  const h = harness(t, [config]);
  await assert.rejects(h.provider.provideLanguageModelChatResponse({ id: config.id }, [], { tools: [], toolMode: 2 }, { report() {} }, token), /Enable the ACP workspace task tool/);
});

test('ACP task tool exposes confirmation and rejects deleted connections', async t => {
  const h = harness(t, [config]);
  const prepared = h.tool.prepareInvocation({ input: { connectionId: config.id, prompt: 'Edit file' } }, token);
  assert.match(prepared.confirmationMessages.message, /modify workspace files/);
  await assert.rejects(h.tool.invoke({ input: { connectionId: 'removed', prompt: 'Edit file' } }, token), /connection was removed/);
});
