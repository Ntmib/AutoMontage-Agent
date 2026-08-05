const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('music ducking applies the approved start, speed and edge fades', () => {
  const script = path.join(__dirname, '../scripts/mix-music.js');
  const result = spawnSync(process.execPath, [
    script,
    'voice.mp4',
    'music.mp3',
    'out.mp4',
    '--gain', '-22',
    '--start', '24',
    '--rate', '1.06',
    '--fade-in', '0.15',
    '--fade-out', '0.8',
    '--duration', '53.6',
    '--dry-run',
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /atrim=start=24/);
  assert.match(result.stdout, /atempo=1\.06/);
  assert.match(result.stdout, /afade=t=in:st=0:d=0\.15/);
  assert.match(result.stdout, /afade=t=out:st=52\.8:d=0\.8/);
  assert.match(result.stdout, /sidechaincompress=/);
});
