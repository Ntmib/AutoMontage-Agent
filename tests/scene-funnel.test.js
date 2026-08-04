const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');
const { buildSync } = require('esbuild');

const ROOT = path.join(__dirname, '..');

function loadScenes() {
  const filename = path.join(ROOT, 'src/scenes/scenes.jsx');
  const output = buildSync({
    entryPoints: [filename],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'remotion', '@remotion/layout-utils'],
    logLevel: 'silent',
  }).outputFiles[0].text;
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled._compile(output, filename);
  return compiled.exports;
}

test('sales funnel narrows twelve incoming people to three visible leads', () => {
  const { getFunnelPeople } = loadScenes();

  assert.equal(typeof getFunnelPeople, 'function');
  const incoming = getFunnelPeople(0, 25);
  const outgoing = getFunnelPeople(75, 25);

  assert.equal(incoming.length, 12);
  assert.equal(incoming.filter((person) => person.opacity > 0.5).length, 12);
  assert.deepEqual(
    outgoing.filter((person) => person.opacity > 0.5).map((person) => person.index),
    [1, 5, 9],
  );
  assert.ok(outgoing.filter((person) => person.opacity > 0.5)
    .every((person) => Math.abs(person.x) <= 70 && person.y > 600));
});
