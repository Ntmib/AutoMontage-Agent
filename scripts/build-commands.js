const path = require('node:path');
const { hostPath } = require('./process');

function videoProbeCommand(file) {
  return {
    command: 'ffprobe',
    args: [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_type,width,height,r_frame_rate,duration:format=duration',
      '-of', 'json',
      hostPath(file),
    ],
  };
}

function reframeCommand(python, root, input, output, mode) {
  return {
    command: python,
    args: [
      path.join(root, 'scripts', 'reframe.py'),
      hostPath(input),
      hostPath(output),
      '--mode', mode,
    ],
  };
}

function audioExtractionCommand(input, output) {
  return {
    command: 'ffmpeg',
    args: ['-y', '-i', hostPath(input), '-vn', '-ar', '16000', '-ac', '1', hostPath(output)],
  };
}

function frameAnalysisCommand(python, root, input, slots, output) {
  return {
    command: python,
    args: [
      path.join(root, 'scripts', 'analyze-frames.py'),
      hostPath(input),
      '--slots', slots,
      '--out', hostPath(output),
    ],
  };
}

function paletteCommand(root, input, brandLock) {
  return {
    command: process.execPath,
    args: [path.join(root, 'scripts', 'palette.js'), hostPath(input), '--brandLock', String(brandLock)],
  };
}

function remotionRenderCommand(resolved, {
  entry,
  composition,
  output,
  props,
  publicDir = null,
}) {
  return {
    command: resolved.command,
    args: [
      ...resolved.argsPrefix,
      'render',
      entry,
      composition,
      hostPath(output),
      '--props',
      hostPath(props),
      ...(publicDir ? ['--public-dir', hostPath(publicDir)] : []),
      '--codec=h264',
      '--log=error',
    ],
  };
}

module.exports = {
  audioExtractionCommand,
  frameAnalysisCommand,
  paletteCommand,
  reframeCommand,
  remotionRenderCommand,
  videoProbeCommand,
};
