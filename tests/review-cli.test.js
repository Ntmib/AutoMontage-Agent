const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { parseReviewOptions } = require('../scripts/review/cli');
const { makeReviewProject } = require('./helpers/review-project');

test('review requires an existing project directory', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-review-cli-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));

  assert.throws(() => parseReviewOptions(['--project-dir', '']), /project-dir/);
  assert.throws(
    () => parseReviewOptions(['--project-dir', path.join(parent, 'missing')]),
    /project-dir/,
  );
});

test('review is read-only unless edit is explicit', (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-review-cli-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));

  assert.deepEqual(parseReviewOptions(['--project-dir', projectDir]), {
    projectDir: path.resolve(projectDir),
    editable: false,
    open: true,
    port: 0,
  });
  assert.deepEqual(parseReviewOptions([
    '--project-dir', projectDir,
    '--edit',
    '--no-open',
    '--port', '43123',
  ]), {
    projectDir: path.resolve(projectDir),
    editable: true,
    open: false,
    port: 43123,
  });
});

test('review rejects malformed and unknown options', (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-review-cli-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));

  assert.throws(() => parseReviewOptions(['--project-dir', projectDir, '--port']), /port/);
  assert.throws(() => parseReviewOptions(['--project-dir', projectDir, '--port', '-1']), /port/);
  assert.throws(() => parseReviewOptions(['--project-dir', projectDir, '--port', '65536']), /port/);
  assert.throws(() => parseReviewOptions(['--project-dir', projectDir, '--unknown']), /unknown/);
});

test('top-level CLI dispatches review without forwarding its arguments to build', (t) => {
  const { root } = makeReviewProject(t);
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'cli.js'),
    'review',
    '--project-dir', path.join(root, 'missing-project'),
    '--no-open',
  ], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(
    result.stderr,
    'Review server failed to start. Check --project-dir and options.\n',
  );
  assert.doesNotMatch(result.stderr, /#token=|Bearer |missing-project/);
});
