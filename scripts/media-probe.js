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

function parseMediaProbeJson(raw) {
  const stage = 'media probe';
  let data;
  try {
    if (typeof raw !== 'string' || raw.trim() === '') fail(stage, 'JSON');
    data = JSON.parse(raw);
  } catch (error) {
    if (error.message.startsWith(`${stage}:`)) throw error;
    throw new Error(`${stage}: ffprobe вернул недопустимое JSON`);
  }

  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((stream) => stream && stream.codec_type === 'video'
    && Number(stream.disposition?.attached_pic || 0) !== 1);
  if (!video) fail(stage, 'primary video stream');

  const width = Number(video.width);
  const height = Number(video.height);
  if (!Number.isSafeInteger(width) || width <= 0
    || !Number.isSafeInteger(height) || height <= 0) {
    fail(stage, 'geometry');
  }

  const formatNames = String(data.format?.format_name || '').split(',');
  const imageFormats = new Set([
    'avif', 'gif', 'image2', 'image2pipe', 'jpeg_pipe', 'mjpeg',
    'png_pipe', 'webp_pipe',
  ]);
  const mediaKind = formatNames.some((name) => imageFormats.has(name)) ? 'image' : 'video';
  let fps = 0;
  let durationSec = 0;
  let hasAudio = false;
  const audio = streams.find((stream) => stream && stream.codec_type === 'audio') || null;
  if (mediaKind === 'video') {
    fps = parseRate(video.avg_frame_rate || video.r_frame_rate, stage);
    durationSec = Number(data.format?.duration ?? video.duration);
    if (!Number.isFinite(durationSec) || durationSec <= 0) fail(stage, 'duration');
    hasAudio = Boolean(audio);
  }

  const sideDataRotation = Array.isArray(video.side_data_list)
    ? video.side_data_list.find((entry) => Number.isFinite(Number(entry?.rotation)))?.rotation
    : undefined;
  const rawRotation = Number(sideDataRotation ?? video.tags?.rotate ?? 0);
  if (!Number.isFinite(rawRotation)) fail(stage, 'rotation');
  const normalizedRotation = ((Math.round(rawRotation) % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(normalizedRotation)) fail(stage, 'rotation');

  const container = String(data.format?.format_name || '');
  const videoCodec = typeof video.codec_name === 'string' ? video.codec_name : '';
  const pixelFormat = typeof video.pix_fmt === 'string' ? video.pix_fmt : '';
  const hasAlpha = /(?:^yuva|rgba|argb|bgra|abgr|gbrap|ya8|ya16)/.test(pixelFormat);
  const sampleRate = Number(audio?.sample_rate);
  const channels = Number(audio?.channels);

  return {
    mediaKind,
    width,
    height,
    fps,
    durationSec,
    hasAudio,
    rotation: normalizedRotation,
    container,
    videoCodec,
    pixelFormat,
    hasAlpha,
    audioCodec: typeof audio?.codec_name === 'string' ? audio.codec_name : null,
    audioSampleRate: Number.isSafeInteger(sampleRate) && sampleRate > 0 ? sampleRate : null,
    audioChannels: Number.isSafeInteger(channels) && channels > 0 ? channels : null,
  };
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
  parseMediaProbeJson,
  parseRate,
  parseVideoProbe,
  probeVideo,
};
