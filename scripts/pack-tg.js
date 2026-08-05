#!/usr/bin/env node
// Финальная упаковка под Telegram: сжатие + ЖЁСТКИЙ A/V-синхрон.
// Чинит «звук убегает»: -vsync cfr фиксирует число кадров (видео не растёт),
// apad+shortest выравнивают аудио точно по длине видео.
//   node pack-tg.js <in.mp4> <out.mp4> [--fps 25] [--maxrate 2200k] [--h 720]
const { finiteNumber, optionValue } = require('./build-options');
const { captureTool, hostPath, runTool } = require('./process');

function parseBitrate(value) {
  const match = /^(\d+)(?:k)?$/i.exec(String(value));
  if (!match) throw new Error('--maxrate должен быть bitrate в kbit/s, например 2200k');
  const kbps = finiteNumber(match[1], '--maxrate', { min: 64, max: 100000, integer: true });
  return { kbps, value: `${kbps}k` };
}

function parsePackOptions(args) {
  const bitrate = parseBitrate(optionValue(args, 'maxrate', '2200k'));
  const heightValue = optionValue(args, 'h', null);
  return {
    fps: finiteNumber(optionValue(args, 'fps', '25'), '--fps', {
      min: 1,
      max: 120,
    }),
    maxrate: bitrate.value,
    bufsize: `${bitrate.kbps * 2}k`,
    height: heightValue == null ? null : finiteNumber(heightValue, '--h', {
      min: 144,
      max: 4320,
      integer: true,
    }),
  };
}

function packCommand(input, output, options) {
  const args = ['-y', '-i', hostPath(input), '-r', String(options.fps), '-fps_mode', 'cfr'];
  if (options.height) args.push('-vf', `scale=-2:${options.height}:flags=lanczos`);
  args.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '25',
    '-maxrate', options.maxrate,
    '-bufsize', options.bufsize,
    '-pix_fmt', 'yuv420p',
    '-af', 'apad',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-shortest',
    '-movflags', '+faststart',
    hostPath(output),
  );
  return { command: 'ffmpeg', args };
}

function packProbeCommand(output) {
  return {
    command: 'ffprobe',
    args: [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,start_time,duration',
      '-of', 'json',
      hostPath(output),
    ],
  };
}

function parsePackProbe(raw) {
  let data;
  try {
    data = JSON.parse(String(raw));
  } catch {
    throw new Error('pack probe: ffprobe вернул недопустимое JSON');
  }
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((stream) => stream?.codec_type === 'video');
  const audio = streams.find((stream) => stream?.codec_type === 'audio');
  if (!video) throw new Error('pack probe: video stream отсутствует');
  if (!audio) throw new Error('pack probe: audio stream отсутствует');
  const values = {
    videoStart: Number(video.start_time),
    videoDuration: Number(video.duration),
    audioStart: Number(audio.start_time),
    audioDuration: Number(audio.duration),
  };
  for (const [field, value] of Object.entries(values)) {
    if (!Number.isFinite(value) || (field.endsWith('Duration') && value <= 0)) {
      throw new Error(`pack probe: недопустимое ${field.includes('Duration') ? 'duration' : 'start time'}`);
    }
  }
  return values;
}

function assertPackSync(probe) {
  const startDrift = Math.abs(probe.videoStart - probe.audioStart);
  const durationDrift = Math.abs(probe.videoDuration - probe.audioDuration);
  const drift = Math.max(startDrift, durationDrift);
  if (drift >= 0.08) {
    throw new Error(`A/V drift ${(drift * 1000).toFixed(0)} мс: требуется меньше 80 мс`);
  }
  return { ...probe, startDrift, durationDrift, drift };
}

function main(args = process.argv.slice(2)) {
  const [input, output] = args;
  if (!input || !output) throw new Error('укажи входной и выходной MP4');
  const options = parsePackOptions(args);
  const command = packCommand(input, output, options);
  runTool(command.command, command.args, { stage: 'Telegram pack' });
  const probe = packProbeCommand(output);
  const sync = assertPackSync(parsePackProbe(captureTool(probe.command, probe.args, {
    stage: 'Telegram pack probe',
    maxBuffer: 4 * 1024 * 1024,
  })));
  console.log(`✅ ${output}  video=${sync.videoDuration.toFixed(2)}с audio=${sync.audioDuration.toFixed(2)}с  Δ=${(sync.drift * 1000).toFixed(0)}мс СИНХРОН OK`);
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
  assertPackSync,
  main,
  packCommand,
  packProbeCommand,
  parsePackOptions,
  parsePackProbe,
};
