const ASPECT_ALIASES = {
  source: 'source',
  vertical: 'vertical',
  '9:16': 'vertical',
  horizontal: 'horizontal',
  '16:9': 'horizontal',
};

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} должен быть положительным числом`);
  }
  return number;
}

function resolveOutputGeometry({ sourceWidth, sourceHeight, sourceFps, aspect = 'source' }) {
  const normalizedAspect = ASPECT_ALIASES[String(aspect).toLowerCase()];
  if (!normalizedAspect) {
    throw new Error(`неизвестный aspect "${aspect}": используй source, vertical, horizontal`);
  }

  const width = positiveNumber(sourceWidth, 'ширина исходника');
  const height = positiveNumber(sourceHeight, 'высота исходника');
  const fps = positiveNumber(sourceFps, 'FPS исходника');

  if (normalizedAspect === 'vertical') {
    return { aspect: normalizedAspect, width: 1080, height: 1920, fps };
  }
  if (normalizedAspect === 'horizontal') {
    return { aspect: normalizedAspect, width: 1920, height: 1080, fps };
  }
  return { aspect: normalizedAspect, width, height, fps };
}

module.exports = { resolveOutputGeometry };
