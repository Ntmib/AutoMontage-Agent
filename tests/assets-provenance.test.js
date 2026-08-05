const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BINARY_ASSET = /\.(?:png|jpe?g|svg|mp4|ttf|otf|woff2?)$/i;
const { demoSourceCommand } = require('../scripts/generate-demo-source');
const { docPreviewCommand } = require('../scripts/generate-doc-preview');

function trackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\0').filter(Boolean);
}

function assetRows() {
  const source = fs.readFileSync(path.join(ROOT, 'ASSETS.md'), 'utf8');
  return source.split('\n')
    .filter((line) => /^\| `[^`]+` \|/.test(line))
    .map((line) => {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      assert.equal(cells.length, 6, `invalid ASSETS row: ${line}`);
      assert.ok(cells.every(Boolean), `empty ASSETS cell: ${line}`);
      return { path: cells[0].slice(1, -1), cells };
    });
}

test('every tracked binary has one complete machine-readable ASSETS row', () => {
  const inventory = trackedFiles().filter((file) => BINARY_ASSET.test(file)).sort();
  const rows = assetRows();
  const documented = rows.map((row) => row.path).sort();

  assert.deepEqual(documented, inventory);
  assert.equal(new Set(documented).size, documented.length, 'ASSETS paths must be unique');
});

test('font assets reference their tracked OFL license texts', () => {
  const assets = fs.readFileSync(path.join(ROOT, 'ASSETS.md'), 'utf8');
  for (const license of trackedFiles().filter((file) => /^public\/fonts\/OFL-.*\.txt$/.test(file))) {
    assert.match(assets, new RegExp(license.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('repository sources do not reference missing public assets', () => {
  const sourceFiles = trackedFiles().filter((file) => (
    /\.(?:js|jsx|json|md|html)$/.test(file) && !file.startsWith('tests/')
  ));
  for (const sourceFile of sourceFiles) {
    const source = fs.readFileSync(path.join(ROOT, sourceFile), 'utf8');
    for (const match of source.matchAll(/(?:broll|brand-logos)\/[A-Za-z0-9_-]+\.(?:png|jpe?g|svg|mp4)/gi)) {
      const publicPath = path.join(ROOT, 'public', match[0]);
      assert.equal(fs.existsSync(publicPath), true, `${sourceFile} references missing ${match[0]}`);
    }
  }
});

test('neutral demo source has a checked argv-only repository recipe', () => {
  const output = path.join(ROOT, 'examples', '.demo-source.test.tmp.mp4');
  const command = demoSourceCommand(output);
  assert.equal(command.command, 'ffmpeg');
  assert.equal(command.args.at(-1), output);
  assert.ok(command.args.includes('color=c=0x17120f:s=1080x1920:r=25:d=14'));
  assert.ok(command.args.includes('anullsrc=channel_layout=mono:sample_rate=16000'));
  assert.equal(command.args.includes('-y'), true);
});

test('lesson docs preview uses the local Remotion CLI through argv', () => {
  const resolved = { command: process.execPath, argsPrefix: ['/repo/remotion-cli.js'] };
  const output = path.join(ROOT, 'docs', 'previews', '.lesson.test.tmp.png');
  const command = docPreviewCommand(resolved, output);
  assert.equal(command.command, process.execPath);
  assert.deepEqual(command.args, [
    '/repo/remotion-cli.js', 'still', 'src/index.js', 'LessonSeq', output,
    '--frame=30', '--log=error',
  ]);
});
