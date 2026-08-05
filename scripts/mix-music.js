#!/usr/bin/env node
// Фаза 2.2 – подмешивает фоновую музыку с ducking (приглушение под голос).
//   node mix-music.js <video_с_голосом> <music> <out.mp4>
//        [--gain -14] [--threshold 0.04] [--ratio 8] [--attack 5] [--release 300]
//        [--start 0] [--rate 1] [--fade-in 0] [--fade-out 0] [--duration 60]
const { finiteNumber, optionValue } = require('./build-options');
const { hostPath, runTool } = require('./process');

function numberOption(args, name, fallback, range) {
  return finiteNumber(optionValue(args, name, fallback), `--${name}`, range);
}

function parseMixOptions(args) {
  const options = {
    gain: numberOption(args, 'gain', '-14', { min: -80, max: 12 }),
    threshold: numberOption(args, 'threshold', '0.04', { min: 0.0001, max: 1 }),
    ratio: numberOption(args, 'ratio', '8', { min: 1, max: 20 }),
    attack: numberOption(args, 'attack', '5', { min: 0.01, max: 2000 }),
    release: numberOption(args, 'release', '300', { min: 0.01, max: 9000 }),
    start: numberOption(args, 'start', '0', { min: 0, max: 86400 }),
    rate: numberOption(args, 'rate', '1', { min: 0.5, max: 2 }),
    fadeIn: numberOption(args, 'fade-in', '0', { min: 0, max: 3600 }),
    fadeOut: numberOption(args, 'fade-out', '0', { min: 0, max: 3600 }),
    duration: numberOption(args, 'duration', '0', { min: 0, max: 86400 }),
    dryRun: args.includes('--dry-run'),
  };
  if (options.fadeOut > 0 && options.duration <= options.fadeOut) {
    throw new Error('--fade-out должен быть меньше --duration');
  }
  return options;
}

function buildMusicFilter(options) {
  const musicFilters = [];
  if (options.start > 0) musicFilters.push(`atrim=start=${options.start}`, 'asetpts=PTS-STARTPTS');
  if (options.rate !== 1) musicFilters.push(`atempo=${options.rate}`);
  musicFilters.push(`volume=${options.gain}dB`);
  if (options.fadeIn > 0) musicFilters.push(`afade=t=in:st=0:d=${options.fadeIn}`);
  if (options.fadeOut > 0) {
    const fadeStart = Number((options.duration - options.fadeOut).toFixed(4));
    musicFilters.push(`afade=t=out:st=${fadeStart}:d=${options.fadeOut}`);
  }

  const audioFormat = 'aformat=sample_rates=44100:channel_layouts=stereo';
  musicFilters.push(audioFormat);
  return [
    `[1:a]${musicFilters.join(',')}[m]`,
    `[0:a]${audioFormat},asplit=2[v][sc]`,
    `[m][sc]sidechaincompress=threshold=${options.threshold}:ratio=${options.ratio}:attack=${options.attack}:release=${options.release}:level_sc=1[duck]`,
    '[v][duck]amix=inputs=2:duration=first:normalize=0,apad[aout]',
  ].join(';');
}

function mixMusicCommand(video, music, output, filter) {
  return {
    command: 'ffmpeg',
    args: [
      '-y',
      '-i', hostPath(video),
      '-stream_loop', '-1',
      '-i', hostPath(music),
      '-filter_complex', filter,
      '-map', '0:v',
      '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '160k',
      '-shortest',
      '-movflags', '+faststart',
      hostPath(output),
    ],
  };
}

function main(args = process.argv.slice(2)) {
  const [video, music, output] = args;
  if (!video || !music || !output) throw new Error('укажи video, music и output');
  const options = parseMixOptions(args);
  const filter = buildMusicFilter(options);
  console.log(`музыка ${options.gain}dB + ducking (thr=${options.threshold} ratio=${options.ratio}); длина по видео`);
  if (options.dryRun) {
    console.log(filter);
    return;
  }
  const command = mixMusicCommand(video, music, output, filter);
  runTool(command.command, command.args, { stage: 'music mix' });
  console.log(`✅ ${output}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildMusicFilter,
  main,
  mixMusicCommand,
  parseMixOptions,
};
