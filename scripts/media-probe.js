const { captureTool, hostPath } = require('./process');

function fail(stage, field) {
  throw new Error(`${stage}: ffprobe вернул недопустимое ${field}`);
}

function parseRate(value, stage) {
  const text = String(value ?? '');
  const parts = text.split('/');
  if (parts.length > 2 || parts.length === 0) fail(stage, 'FPS');
  const numerator = Number(parts[0]);
  const denominator = parts.length === 2 ? Number(parts[1]) : 1;
  const fps = numerator / denominator;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)
    || denominator === 0 || !Number.isFinite(fps) || fps <= 0) {
    fail(stage, 'FPS');
  }
  return fps;
}

function parseVideoProbe(raw, stage = 'video probe') {
  let data;
  try {
    if (typeof raw !== 'string' || raw.trim() === '') fail(stage, 'JSON');
    data = JSON.parse(raw);
  } catch (error) {
    if (error.message.startsWith(`${stage}:`)) throw error;
    throw new Error(`${stage}: ffprobe вернул недопустимое JSON`);
  }

  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((stream) => stream && stream.codec_type === 'video') || streams[0];
  if (!video || video.codec_type && video.codec_type !== 'video') fail(stage, 'video stream');

  const width = Number(video.width);
  const height = Number(video.height);
  if (!Number.isSafeInteger(width) || width <= 0
    || !Number.isSafeInteger(height) || height <= 0) {
    fail(stage, 'geometry');
  }
  const fps = parseRate(video.r_frame_rate, stage);
  const duration = Number(data.format?.duration ?? video.duration);
  if (!Number.isFinite(duration) || duration <= 0) fail(stage, 'duration');

  return { width, height, fps, duration };
}

function probeVideo(file, options = {}) {
  const stage = options.stage || 'video probe';
  const stdout = captureTool('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_type,width,height,r_frame_rate,duration:format=duration',
    '-of', 'json',
    hostPath(file, options.cwd),
  ], {
    cwd: options.cwd,
    env: options.env,
    maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
    stage,
    spawnSyncImpl: options.spawnSyncImpl,
  });
  return parseVideoProbe(stdout, stage);
}

module.exports = {
  parseRate,
  parseVideoProbe,
  probeVideo,
};
