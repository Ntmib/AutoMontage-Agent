const { finiteNumber } = require('./build-options');

function resolveSourceTiming({ fps, duration, framesOverride }) {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error('Source FPS must be a positive finite number');
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Source duration must be a positive finite number');
  }

  const availableFrames = Math.ceil(duration * fps);
  const durationInFrames = framesOverride == null
    ? availableFrames
    : Math.min(finiteNumber(framesOverride, '--frames', {
      min: 1,
      max: 10_000_000,
      integer: true,
    }), availableFrames);

  return { fps, durationInFrames };
}

module.exports = { resolveSourceTiming };
