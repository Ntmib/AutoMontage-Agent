#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { resolveRemotionCommand } = require('./env');
const { runTool } = require('./process');

const ROOT = path.resolve(__dirname, '..');
const DESTINATION = path.join(ROOT, 'docs', 'previews', 'lesson-presentation.png');

function docPreviewCommand(resolved, outputPath) {
  return {
    command: resolved.command,
    args: [
      ...resolved.argsPrefix,
      'still', 'src/index.js', 'LessonSeq', outputPath,
      '--frame=30', '--log=error',
    ],
  };
}

function generateDocPreview() {
  const temporary = path.join(
    path.dirname(DESTINATION),
    `.${path.basename(DESTINATION)}.${process.pid}.tmp.png`,
  );
  try {
    const command = docPreviewCommand(resolveRemotionCommand(ROOT), temporary);
    runTool(command.command, command.args, { stage: 'generate docs preview', cwd: ROOT });
    fs.renameSync(temporary, DESTINATION);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  console.log(`docs preview: ${DESTINATION}`);
}

if (require.main === module) generateDocPreview();

module.exports = { docPreviewCommand, generateDocPreview };
