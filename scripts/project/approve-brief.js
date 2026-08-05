#!/usr/bin/env node
const path = require('node:path');

const {
  approveBrief,
  createOrOpenProject,
} = require('./workspace');

const [projectDirInput, draftInput] = process.argv.slice(2);
if (!projectDirInput || !draftInput) {
  console.error('Использование: node scripts/project/approve-brief.js <project-dir> <draft-json>');
  process.exit(1);
}

try {
  const project = createOrOpenProject({ projectDir: projectDirInput });
  const draftPath = path.isAbsolute(draftInput)
    ? draftInput
    : path.join(project.dir, draftInput);
  const approved = approveBrief(project, draftPath);
  console.log(`approved: ${approved.jsonPath}`);
  if (approved.markdownPath) console.log(`markdown: ${approved.markdownPath}`);
} catch (error) {
  console.error(`Не удалось утвердить brief: ${error.message}`);
  process.exit(1);
}
