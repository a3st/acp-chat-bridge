const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const json = file => JSON.parse(readFileSync(path.join(root, file), 'utf8'));

test('all UI strings have English and Russian translations with matching placeholders', () => {
  const english = json('l10n/bundle.l10n.json');
  const placeholders = text => (text.match(/\{\d+\}/g) ?? []).sort();
  for (const locale of ['en-us', 'ru', 'ru-ru']) {
    const bundle = json(`l10n/bundle.l10n.${locale}.json`);
    assert.deepEqual(Object.keys(bundle).sort(), Object.keys(english).sort());
    for (const [message, translation] of Object.entries(bundle)) {
      assert.ok(translation.trim(), `${locale}: ${message}`);
      assert.deepEqual(placeholders(translation), placeholders(message), `${locale}: ${message}`);
    }
  }
  for (const file of ['src/extension.ts', 'src/connections.ts', 'src/runtime.ts']) {
    const source = readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/(?:vscode\.l10n\.t|this\.t)\(("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)) {
      const message = match[1].startsWith('"') ? JSON.parse(match[1]) : match[1].slice(1, -1);
      assert.ok(Object.hasOwn(english, message), `${file}: ${message}`);
    }
    assert.doesNotMatch(source, /[А-Яа-яЁё]/u, `Hardcoded Russian in ${file}`);
    assert.doesNotMatch(source, /@acp(?!-agent)\b/);
  }
});

test('manifest contributions resolve in both locales and expose @acp-agent', () => {
  const manifest = json('package.json');
  assert.equal(manifest.l10n, './l10n');
  assert.equal(manifest.contributes.chatParticipants[0].name, 'acp-agent');
  const keys = [...JSON.stringify(manifest).matchAll(/%([^%]+)%/g)].map(m => m[1]);
  for (const locale of ['', '.en-us', '.ru', '.ru-ru']) {
    const bundle = json(`package.nls${locale}.json`);
    for (const key of keys) assert.ok(bundle[key]?.trim(), `${locale}: ${key}`);
  }
});
