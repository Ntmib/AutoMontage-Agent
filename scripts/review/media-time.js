const TICKS_PER_SECOND = 120_000;

const STANDARD_RATES = [
  { fps: 24000 / 1001, numerator: 24000, denominator: 1001 },
  { fps: 30000 / 1001, numerator: 30000, denominator: 1001 },
  { fps: 60000 / 1001, numerator: 60000, denominator: 1001 },
];

function positiveFinite(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
}

function validateRate(rate) {
  if (!rate || !Number.isSafeInteger(rate.numerator) || !Number.isSafeInteger(rate.denominator)
    || rate.numerator <= 0 || rate.denominator <= 0) {
    throw new Error('Frame rate must be a positive integer ratio');
  }
}

function greatestCommonDivisor(a, b) {
  let left = a;
  let right = b;
  while (right !== 0) {
    [left, right] = [right, left % right];
  }
  return left;
}

function frameRateFromFps(fps) {
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new Error('FPS must be a positive finite number');
  }

  const standardRate = STANDARD_RATES.find((rate) => (
    Math.abs(fps - rate.fps) <= Number.EPSILON * rate.fps * 8
  ));
  if (standardRate) {
    return { numerator: standardRate.numerator, denominator: standardRate.denominator };
  }

  const numerator = Math.round(fps * TICKS_PER_SECOND);
  if (!Number.isSafeInteger(numerator) || numerator <= 0) {
    throw new Error('FPS cannot be represented as a frame rate ratio');
  }
  const divisor = greatestCommonDivisor(numerator, TICKS_PER_SECOND);
  return { numerator: numerator / divisor, denominator: TICKS_PER_SECOND / divisor };
}

function secondsToFrame(seconds, rate, mode = 'round') {
  positiveFinite(seconds, 'Seconds');
  validateRate(rate);
  const round = { floor: Math.floor, ceil: Math.ceil, round: Math.round }[mode];
  if (!round) {
    throw new Error(`Unknown rounding mode: ${mode}`);
  }

  const raw = seconds * rate.numerator / rate.denominator;
  const frame = round(raw);
  if (!Number.isSafeInteger(frame)) {
    throw new Error('Seconds cannot be represented as a safe frame number');
  }
  return frame;
}

function frameToSeconds(frame, rate) {
  if (!Number.isSafeInteger(frame) || frame < 0) {
    throw new Error('Frame must be a non-negative finite integer');
  }
  validateRate(rate);
  return frame * rate.denominator / rate.numerator;
}

module.exports = {
  frameRateFromFps,
  secondsToFrame,
  frameToSeconds,
};
