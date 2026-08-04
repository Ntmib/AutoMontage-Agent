const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  pythonCandidates,
  resolveRemotionCommand,
} = require('../scripts/env');

test('Python candidates prefer the project virtual environment', () => {
  assert.deepEqual(
    pythonCandidates('/work/automontage', 'darwin'),
    ['/work/automontage/.venv/bin/python', 'python3', 'python'],
  );
  assert.deepEqual(
    pythonCandidates('C:\\work\\automontage', 'win32'),
    [
      path.join('C:\\work\\automontage', '.venv/Scripts/python.exe'),
      'python',
      'python3',
      'py',
    ],
  );
});

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
