function ensureOutputDestination(args, cwd) {
  const result = [...args];
  const projectOwnsOutput = result.includes('--project') || result.includes('--project-dir');
  if (!projectOwnsOutput && !result.includes('--outdir')) {
    result.push('--outdir', cwd);
  }
  return result;
}

module.exports = {
  ensureOutputDestination,
};
