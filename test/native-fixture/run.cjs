const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
exports.run = async () => {
  const result = { version: vscode.version };
  const out = path.resolve(__dirname, '../../.native-test/result.json');
  try {
    const extension = vscode.extensions.getExtension('a3st.acp-chat-bridge');
    if (!extension) throw new Error('ACP test extension not found');
    const exports = await extension.activate();
    result.models = (await vscode.lm.selectChatModels({ vendor: 'acp-chat-bridge' })).map(m => ({ id: m.id, vendor: m.vendor }));
    try { result.githubAccounts = (await vscode.authentication.getAccounts('github')).length; } catch { result.githubAccounts = 0; }
    if (result.models.length !== 2 || result.models.some(m => m.id === 'native-test-agent')) throw new Error('CLI models did not replace the connection entry');
    await vscode.commands.executeCommand('acp.openChat');
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      query: '@acp-agent ping', isPartialQuery: false, mode: 'agent', modelSelector: { vendor: 'acp-chat-bridge', id: 'native-test-agent::provider%2Fsmart' }
    });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !exports.records.some(r => r.stage === 'done' || r.stage === 'error')) await new Promise(resolve => setTimeout(resolve, 200));
    result.records = exports.records;
    const written = path.resolve(__dirname, '../../.native-test/agent-write.txt');
    result.workspaceWrite = fs.readFileSync(written, 'utf8') === 'ACP Agent wrote this workspace file';
    const [model] = await vscode.lm.selectChatModels({ vendor: 'acp-chat-bridge', id: 'native-test-agent::provider%2Fsmart' });
    result.toolCalling = model.capabilities.supportsToolCalling;
    const info = vscode.lm.tools.find(t => t.name === 'acp_chat_bridge_delegate');
    if (!info) throw new Error('ACP delegation tool was not registered');
    const messages = [vscode.LanguageModelChatMessage.User('Write the workspace fixture file')];
    const response = await model.sendRequest(messages, { tools: [{ name: info.name, description: info.description, inputSchema: info.inputSchema }] });
    let call;
    for await (const part of response.stream) if (part instanceof vscode.LanguageModelToolCallPart) call = part;
    if (!call) throw new Error('ACP model did not request its delegation tool');
    const toolResult = await vscode.lm.invokeTool(call.name, { input: call.input, toolInvocationToken: undefined });
    messages.push(vscode.LanguageModelChatMessage.Assistant([call]), vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart(call.callId, toolResult.content)]));
    const completed = await model.sendRequest(messages, { tools: [{ name: info.name, description: info.description, inputSchema: info.inputSchema }] });
    let answer = '';
    for await (const part of completed.stream) {
      if (part instanceof vscode.LanguageModelToolCallPart) throw new Error('ACP tool task was repeated after completion');
      if (part instanceof vscode.LanguageModelTextPart) answer += part.value;
    }
    result.toolLoop = answer.includes('Workspace file saved;') && answer.includes('model:provider/smart;');
    result.passed = result.githubAccounts === 0 && result.workspaceWrite && result.toolLoop && result.records.some(r => r.stage === 'done' && !r.result?.errorDetails);
  } catch (error) { result.error = String(error); result.stack = error.stack; result.passed = false; }
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(result, null, 2));
  if (!result.passed) throw new Error('Native unsigned-in chat test failed. See .native-test/result.json');
};
