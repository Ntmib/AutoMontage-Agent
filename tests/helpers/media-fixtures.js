const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function toolAvailable(command) {
  const result = spawnSync(command, ['-version'], { encoding: 'utf8' });
  return !result.error && result.status === 0;
}

function ffmpegEncoderAvailable(name) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  return !result.error && result.status === 0
    && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`).test(result.stdout);
}

function runTool(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} fixture failed: ${result.error?.message || result.stderr}`);
  }
}

function makeMediaFixtures(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const files = {
    jpeg: path.join(directory, 'tiny.jpg'),
    transparentPng: path.join(directory, 'transparent.png'),
    animatedGif: path.join(directory, 'animated.gif'),
    silentLandscape: path.join(directory, 'silent-landscape.mp4'),
    audioPortrait: path.join(directory, 'audio-portrait.mp4'),
    rotatedVfr: path.join(directory, 'rotated-vfr.mov'),
  };
  runTool('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x24', '-frames:v', '1', files.jpeg], directory);
  runTool('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red@0.0:s=32x24,format=rgba', '-frames:v', '1', '-threads', '1', files.transparentPng], directory);
  runTool('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x24:d=0.1', '-f', 'lavfi', '-i', 'color=c=blue:s=32x24:d=0.1', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,fps=10', '-frames:v', '2', files.animatedGif], directory);
  runTool('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=15:d=0.6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', files.silentLandscape], directory);
  runTool('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=90x160:r=20:d=0.7', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:d=0.7', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', files.audioPortrait], directory);
  const vfrBase = path.join(directory, 'vfr-base.mp4');
  runTool('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=0.8', '-vf', "select='eq(n,0)+eq(n,1)+eq(n,5)+eq(n,12)+eq(n,20)'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', vfrBase], directory);
  runTool('ffmpeg', ['-y', '-v', 'error', '-display_rotation', '90', '-i', vfrBase, '-c', 'copy', files.rotatedVfr], directory);
  return files;
}

module.exports = { ffmpegEncoderAvailable, makeMediaFixtures, runTool, toolAvailable };
