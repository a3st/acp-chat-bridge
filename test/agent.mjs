import { createInterface } from 'node:readline';
import path from 'node:path';
const mode = process.argv[2];
const pending = new Map();
let turns = 0;
let workspace;
let selectedModel = 'provider/fast';
let selectedMode = 'build';
const modelOptions = () => [{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: selectedMode, options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }] }, {
  id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: selectedModel,
  options: [{ group: 'provider', name: 'Provider', options: [{ value: 'provider/fast', name: 'Fast' }, { value: 'provider/smart', name: 'Smart', description: 'Reasoning model' }] }]
}];
let authenticated = false;
let nextId = 1000;
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const reply = (id, result) => send({ id, result });
const request = (method, params) => new Promise(resolve => { const id = nextId++; pending.set(id, resolve); send({ id, method, params }); });
const sessionId = 'mock-session';
const update = text => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line);
  if (!message.method) { pending.get(message.id)?.(message.result); pending.delete(message.id); return; }
  if (message.method === 'initialize') {
    if (mode === 'startup-hang') return;
    reply(message.id, { protocolVersion: message.params.protocolVersion, agentCapabilities: {}, authMethods: [{ id: 'login', name: 'Login' }] });
  } else if (message.method === 'authenticate') { authenticated = true; reply(message.id, {}); }
  else if (message.method === 'session/new') {
    workspace = message.params.cwd;
    if (mode === 'auth' && !authenticated) send({ id: message.id, error: { code: -32000, message: 'Authentication required' } });
    else reply(message.id, { sessionId,
      ...(mode === 'models' || mode === 'workspace-write' ? { configOptions: modelOptions() } : {}),
      ...(mode === 'legacy-modes' ? { modes: { currentModeId: selectedMode, availableModes: [{ id: 'build', name: 'Build' }, { id: 'plan', name: 'Plan' }] } } : {}),
      ...(mode === 'legacy-models' ? { models: { currentModelId: selectedModel, availableModels: [{ modelId: 'provider/fast', name: 'Fast' }, { modelId: 'provider/smart', name: 'Smart' }] } } : {})
    });
    if (mode === 'commands') send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact context' }, { name: 'echo', description: 'Echo arguments' }] } } });
  } else if (message.method === 'session/set_config_option') {
    if (message.params.configId === 'model') selectedModel = message.params.value;
    else if (message.params.configId === 'mode') selectedMode = message.params.value;
    else throw new Error('Unexpected config ID');
    reply(message.id, { configOptions: modelOptions() });
  } else if (message.method === 'session/set_mode') {
    selectedMode = message.params.modeId;
    reply(message.id, {});
  } else if (message.method === 'session/set_model') {
    selectedModel = message.params.modelId;
    reply(message.id, {});
  } else if (message.method === 'session/prompt') {
    if (mode === 'commands') {
      const text = message.params.prompt.map(p => p.text ?? '').join('');
      if (text === '/compact') { reply(message.id, { stopReason: 'end_turn' }); return; }
      if (text.startsWith('/echo ')) { update('CLI:' + text.slice(6)); reply(message.id, { stopReason: 'end_turn' }); return; }
    }
    if (mode === 'empty') { reply(message.id, { stopReason: 'end_turn' }); return; }
    if (mode === 'hang') { update('started'); return; }
    if (mode === 'exit') { process.exit(7); }
    if (mode === 'permission') {
      const result = await request('session/request_permission', { sessionId, toolCall: { toolCallId: 'tool-1', title: 'Write file' }, options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }] });
      update(result.outcome.outcome);
    }
    if (mode === 'workspace-write') {
      await request('fs/write_text_file', { sessionId, path: path.join(workspace, '.native-test', 'agent-write.txt'), content: 'ACP Agent wrote this workspace file' });
      update('Workspace file saved;');
    }
    if (mode === 'files') {
      const read = await request('fs/read_text_file', { sessionId, path: '/workspace/test.txt', line: 2, limit: 1 });
      await request('fs/write_text_file', { sessionId, path: '/workspace/test.txt', content: read.content });
      update(read.content);
    }
    if (mode === 'models' || mode === 'legacy-models' || mode === 'workspace-write') update(`model:${selectedModel};`);
    if (mode === 'models' || mode === 'legacy-modes' || mode === 'workspace-write') update(`mode:${selectedMode};`);
    turns++;
    update(`turn:${turns};`);
    update(message.params.prompt.map(p => p.text ?? '').join(''));
    reply(message.id, { stopReason: 'end_turn' });
  }
});
