const vscode = require('vscode');
const Module = require('node:module');
const path = require('node:path');
exports.activate = async context => {
  await context.globalState.update('acp.connections', [{ id: 'native-test-agent', name: 'Native test', command: 'C:/Program Files/nodejs/node.exe', args: [path.resolve(__dirname, '../agent.mjs'), 'workspace-write'] }]);
  await context.globalState.update('acp.selected', 'native-test-agent');
  const records = [];
  const original = Module._load;
  const api = { ...vscode, chat: { ...vscode.chat, createChatParticipant(id, handler) {
    return vscode.chat.createChatParticipant(id, async (...args) => {
      records.push({ stage: 'start', prompt: args[0].prompt, model: args[0].model?.id });
      try { const result = await handler(...args); records.push({ stage: 'done', result }); return result; }
      catch (error) { records.push({ stage: 'error', error: String(error) }); throw error; }
    });
  } } };
  Module._load = function(request, ...args) { return request === 'vscode' ? api : original.call(this, request, ...args); };
  try { require('../../dist/extension.js').activate(context); }
  finally { Module._load = original; }
  return { records };
};
