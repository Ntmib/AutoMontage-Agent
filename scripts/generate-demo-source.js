#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { runTool } = require('./process');

const ROOT = path.resolve(__dirname, '..');

function demoSourceCommand(outputPath) {
  return {
    command: 'ffmpeg',
    args: [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=0x17120f:s=1080x1920:r=25:d=14',
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=16000',
      '-t', '14', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '32k', '-shortest',
      '-movflags', '+faststart', '-y', outputPath,
    ],
  };
}

function generateDemoSource(outputPath = path.join(ROOT, 'examples', 'demo-source.mp4')) {
  const destination = path.resolve(outputPath);
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.tmp.mp4`,
  );
  if (destination !== path.join(ROOT, 'examples', 'demo-source.mp4')) {
    throw new Error('demo source можно генерировать только в examples/demo-source.mp4');
  }
  try {
    const command = demoSourceCommand(temporary);
    runTool(command.command, command.args, { stage: 'generate demo source', cwd: ROOT });
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  console.log(`demo source: ${destination}`);
}

if (require.main === module) generateDemoSource();

module.exports = { demoSourceCommand, generateDemoSource };
