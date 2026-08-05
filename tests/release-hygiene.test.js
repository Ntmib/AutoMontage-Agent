const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  checkRelease,
  formatIssue,
} = require('../scripts/check-release');
const {
  assertProtectedFilesUnchanged,
  snapshotFiles,
} = require('../scripts/smoke-release');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(root, file, source) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
}

function makeRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-release-check-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'release-test@example.invalid']);
  git(root, ['config', 'user.name', 'Release Test']);
  write(root, 'package.json', `${JSON.stringify({
    name: 'fixture',
    version: '1.2.0',
    license: 'MIT',
    repository: 'https://example.invalid/repo.git',
    homepage: 'https://example.invalid/repo',
    bugs: 'https://example.invalid/repo/issues',
    engines: { node: '>=20' },
  }, null, 2)}\n`);
  write(root, 'package-lock.json', `${JSON.stringify({
    name: 'fixture',
    version: '1.2.0',
    lockfileVersion: 3,
    packages: { '': { name: 'fixture', version: '1.2.0', engines: { node: '>=20' } } },
  }, null, 2)}\n`);
  write(root, 'README.md', '# Fixture\n\nCurrent version: **v1.2.0**.\n\n[Testing](TESTING.md)\n');
  write(root, 'TESTING.md', '# Testing\n');
  write(root, '.env.example', 'OPENAI_API_KEY=\nTHEMES_EXT=\n');
  write(root, 'src/example.js', "const key = process.env.OPENAI_API_KEY;\nconst theme = process.env.THEMES_EXT;\n");
  write(root, 'ASSETS.md', '# Public asset provenance\n\n| Path | Kind | Origin | Author / license | Source or generator | Redistribution basis |\n|---|---|---|---|---|---|\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'valid fixture']);
  return root;
}

test('release checker reads the committed tree instead of dirty worktree files', () => {
  const root = makeRepository();
  const privateHandle = ['@MCD', 'ENIL'].join('');
  const personalPath = ['/Users', '/private/source.mp4'].join('');
  write(root, 'src/example.js', `const owner = '${privateHandle}';\nconst path = '${personalPath}';\n`);

  const result = checkRelease({ cwd: root, tree: 'HEAD' });

  assert.equal(result.tree, git(root, ['rev-parse', 'HEAD^{tree}']));
  assert.deepEqual(result.issues, []);
  assert.ok(fs.readFileSync(path.join(root, 'src/example.js'), 'utf8').includes(privateHandle));
});

test('release checker reports private ids, media provenance, engines, and changed em dash', () => {
  const root = makeRepository();
  const base = git(root, ['rev-parse', 'HEAD']);
  write(root, 'package-lock.json', `${JSON.stringify({
    name: 'fixture',
    version: '1.2.0',
    lockfileVersion: 3,
    packages: { '': { name: 'fixture', version: '1.2.0', engines: { node: '>=18' } } },
  }, null, 2)}\n`);
  const privateHandle = ['@MCD', 'ENIL'].join('');
  const personalPath = ['/Users', '/private/video.mp4'].join('');
  write(root, 'src/private.js', `const owner = '${privateHandle}';\nconst path = '${personalPath}';\n`);
  write(root, 'public/example.png', 'not-a-real-image');
  const emDash = String.fromCodePoint(0x2014);
  write(root, 'README.md', `# Fixture\n\nCurrent version: **v1.2.0**.\n\nNew ${emDash} text.\n`);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'invalid fixture']);

  const result = checkRelease({ cwd: root, tree: 'HEAD', base });
  const rules = new Set(result.issues.map((issue) => issue.rule));

  assert.ok(rules.has('engine-match'));
  assert.ok(rules.has('private-id'));
  assert.ok(rules.has('personal-path'));
  assert.ok(rules.has('asset-provenance'));
  assert.ok(rules.has('changed-em-dash'));
  assert.match(formatIssue(result.issues[0]), /^\[[a-z-]+\] [^:]+:\d+: .+ Fix: .+/);
});

test('missing base ref explains how to fetch history', () => {
  const root = makeRepository();

  assert.throws(
    () => checkRelease({ cwd: root, tree: 'HEAD', base: 'origin/main' }),
    /git fetch --all --prune/,
  );
});

test('smoke guard detects any protected-file mutation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-smoke-guard-'));
  write(root, 'src/data/captions.js', 'module.exports = [];\n');
  write(root, 'src/data/transcript.json', '[]\n');
  const files = ['src/data/captions.js', 'src/data/transcript.json'];
  const before = snapshotFiles(root, files);

  assert.doesNotThrow(() => assertProtectedFilesUnchanged(root, before));
  write(root, files[0], 'module.exports = ["changed"];\n');
  assert.throws(
    () => assertProtectedFilesUnchanged(root, before),
    /protected file changed: src\/data\/captions\.js/,
  );
});
