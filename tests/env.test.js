const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveRemotionCommand } = require('../scripts/env');

test('Remotion command is safe for execFile when the local binary exists', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'node_modules/.bin/remotion');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '');

  assert.deepEqual(resolveRemotionCommand(root, 'darwin'), {
    command: bin,
    argsPrefix: [],
  });
});

test('Remotion command falls back to local-only npx arguments', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(resolveRemotionCommand(root, 'darwin'), {
    command: 'npx',
    argsPrefix: ['--no-install', 'remotion'],
  });
});
