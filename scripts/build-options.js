function optionValue(args, name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value == null || value.startsWith('--')) {
    throw new Error(`--${name} требует значение`);
  }
  return value;
}

function finiteNumber(value, name, { min, max, integer = false } = {}) {
  const number = Number(value);
  const valid = Number.isFinite(number)
    && (!integer || Number.isSafeInteger(number))
    && (min == null || number >= min)
    && (max == null || number <= max);
  if (!valid) {
    const range = min != null && max != null ? ` от ${min} до ${max}` : '';
    throw new Error(`${name} должен быть конечным ${integer ? 'целым числом' : 'числом'}${range}`);
  }
  return number;
}

function parseBuildOptions(args) {
  const reframeIndex = args.indexOf('--reframe');
  let reframeMode = null;
  if (reframeIndex >= 0) {
    const candidate = args[reframeIndex + 1];
    reframeMode = !candidate || candidate.startsWith('--') ? 'track' : candidate;
    if (!['static', 'track'].includes(reframeMode)) {
      throw new Error('--reframe принимает только static или track');
    }
  }

  const framesValue = optionValue(args, 'frames', null);
  return {
    framesOverride: framesValue == null
      ? null
      : finiteNumber(framesValue, '--frames', { min: 1, max: 10_000_000, integer: true }),
    maxScenes: finiteNumber(optionValue(args, 'max', '12'), '--max', {
      min: 1,
      max: 100,
      integer: true,
    }),
    beatSec: finiteNumber(optionValue(args, 'beatSec', '3'), '--beatSec', {
      min: 0.1,
      max: 60,
    }),
    brandLock: finiteNumber(optionValue(args, 'brandLock', '1'), '--brandLock', {
      min: 0,
      max: 1,
    }),
    reframeMode,
  };
}

module.exports = {
  finiteNumber,
  optionValue,
  parseBuildOptions,
};
