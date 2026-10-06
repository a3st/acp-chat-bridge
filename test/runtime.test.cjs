const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { AgentSession } = require('../dist/runtime-test.cjs');
function create(mode, overrides = {}) {
  const config = { id: 'test', name: 'Mock ACP', command: process.execPath, args: [path.join(__dirname, 'agent.mjs'), mode] };
  const host = {
    permission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow' } }),
    authenticate: async () => 'login',
    read: async () => ({ content: 'file contents' }), write: async () => ({}), log: () => {}, ...overrides
  };
  return new AgentSession(config, process.cwd(), host);
}
const blocks = text => [{ type: 'text', text }];
test('streams chunks and reuses the ACP session for follow-up turns', async () => {
  const session = create('normal');
  const chunks = [];
  try {
    await session.prompt(blocks('hello'), { text: t => chunks.push(t), progress: () => {} }, AbortSignal.timeout(5000));
    await session.prompt(blocks('again'), { text: t => chunks.push(t), progress: () => {} }, AbortSignal.timeout(5000));
    assert.deepEqual(chunks, ['turn:1;', 'hello', 'turn:2;', 'again']);
  } finally { session.dispose(); }
});
test('independent chats do not share agent context', async () => {
  const a = create('normal'), b = create('normal');
  const answers = [];
  try {
    for (const s of [a, b]) await s.prompt(blocks('hello'), { text: t => answers.push(t), progress: () => {} }, AbortSignal.timeout(5000));
    assert.deepEqual(answers, ['turn:1;', 'hello', 'turn:1;', 'hello']);
  } finally { a.dispose(); b.dispose(); }
});
test('routes agent permission requests to the host', async () => {
  let permission;
  const session = create('permission', { permission: async request => { permission = request; return { outcome: { outcome: 'cancelled' } }; } });
  const chunks = [];
  try {
    await session.prompt(blocks('test'), { text: t => chunks.push(t), progress: () => {} }, AbortSignal.timeout(5000));
    assert.equal(permission.toolCall.title, 'Write file');
    assert.equal(chunks[0], 'cancelled');
  } finally { session.dispose(); }
});
test('routes ACP file requests with line and limit intact', async () => {
  let read, write;
  const session = create('files', { read: async r => { read = r; return { content: 'second line' }; }, write: async r => { write = r; return {}; } });
  try {
    await session.prompt(blocks('test'), { text: () => {}, progress: () => {} }, AbortSignal.timeout(5000));
    assert.equal(read.line, 2); assert.equal(read.limit, 1); assert.equal(write.content, 'second line');
  } finally { session.dispose(); }
});
test('authenticates and retries session creation when agent requires login', async () => {
  let methods;
  const session = create('auth', { authenticate: async m => { methods = m; return m[0].id; } });
  try {
    await session.prompt(blocks('test'), { text: () => {}, progress: () => {} }, AbortSignal.timeout(5000));
    assert.equal(methods[0].id, 'login');
  } finally { session.dispose(); }
});
for (const mode of ['hang', 'startup-hang']) test(`cancellation closes a nonresponsive agent (${mode})`, async () => {
  const session = create(mode);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('cancelled')), 300);
  try {
    await assert.rejects(session.prompt(blocks('test'), { text: () => {}, progress: () => {} }, controller.signal));
    assert.equal(session.closed, true);
  } finally { clearTimeout(timer); session.dispose(); }
});
test('reports agent exit rather than hanging a chat request', async () => {
  const session = create('exit');
  try { await assert.rejects(session.prompt(blocks('test'), { text: () => {}, progress: () => {} }, AbortSignal.timeout(5000))); }
  finally { session.dispose(); }
});
test('reports an unavailable executable', async () => {
  const session = create('normal');
  session.config.command = path.join(process.cwd(), 'missing-acp-agent.exe');
  try { await assert.rejects(session.prompt(blocks('test'), { text: () => {}, progress: () => {} }, AbortSignal.timeout(5000)), /Could not start Mock ACP:/); }
  finally { session.dispose(); }
});

test('runtime errors use the host locale and preserve substituted values', async () => {
  const russian = require('../l10n/bundle.l10n.ru-ru.json');
  const session = create('normal', { translate: (message, ...args) => (russian[message] ?? message).replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)])) });
  session.config.command = path.join(process.cwd(), 'missing-acp-agent.exe');
  try { await assert.rejects(session.prompt(blocks('test'), { text: () => {}, progress: () => {} }, AbortSignal.timeout(5000)), /Не удалось запустить Mock ACP:/); }
  finally { session.dispose(); }
});
