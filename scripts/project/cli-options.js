const path = require('node:path');

function buildDemoArgs(root, cwd) {
  return [
    path.join(root, 'examples', 'demo-source.mp4'),
    '--scenario', path.join(root, 'examples', 'scenario-demo.json'),
    '--no-transcribe', '--id', 'demo',
    '--outdir', path.join(cwd, 'out'),
  ];
}

function ensureOutputDestination(args, cwd) {
  const result = [...args];
  const projectOwnsOutput = result.includes('--project') || result.includes('--project-dir');
  if (!projectOwnsOutput && !result.includes('--outdir')) {
    result.push('--outdir', cwd);
  }
  return result;
}

module.exports = {
  buildDemoArgs,
  ensureOutputDestination,
};
