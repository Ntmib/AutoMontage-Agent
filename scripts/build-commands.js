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
  scale = null,
  crf = null,
  frameRange = null,
  concurrency = null,
  overwrite = false,
}) {
  if (scale !== null && (!Number.isFinite(scale) || scale <= 0 || scale > 4)) {
    throw new Error('Remotion scale must be a finite number from 0 to 4');
  }
  if (crf !== null && (!Number.isSafeInteger(crf) || crf < 0 || crf > 51)) {
    throw new Error('Remotion crf must be an integer from 0 to 51');
  }
  if (frameRange !== null && (!frameRange || !Number.isSafeInteger(frameRange.fromFrame)
    || !Number.isSafeInteger(frameRange.toFrameExclusive) || frameRange.fromFrame < 0
    || frameRange.toFrameExclusive <= frameRange.fromFrame)) {
    throw new Error('Remotion frame range is invalid');
  }
  if (concurrency !== null && !(
    (Number.isSafeInteger(concurrency) && concurrency > 0 && concurrency <= 256)
    || (typeof concurrency === 'string'
      && /^(?:[1-9]|[1-9]\d|100)%$/.test(concurrency))
  )) {
    throw new Error('Remotion concurrency is invalid');
  }
  if (typeof overwrite !== 'boolean') throw new Error('Remotion overwrite must be boolean');
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
      ...(scale === null ? [] : [`--scale=${scale}`]),
      ...(crf === null ? [] : [`--crf=${crf}`]),
      ...(frameRange === null ? [] : [
        `--frames=${frameRange.fromFrame}-${frameRange.toFrameExclusive - 1}`,
      ]),
      ...(concurrency === null ? [] : [`--concurrency=${concurrency}`]),
      ...(overwrite ? ['--overwrite'] : []),
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
