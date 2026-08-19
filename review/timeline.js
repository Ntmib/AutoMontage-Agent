import { seekPlayer, synchronizePlayer } from './player-sync.js';

const MIN_CANVAS_WIDTH = 720;
const CANVAS_CHROME_WIDTH = 160;
const BASE_PIXELS_PER_SECOND = 20;
const MIN_SCENE_WIDTH = 40;
const MIN_WORD_SPACING = 44;

function formatTime(seconds, milliseconds = false) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const rest = safe - (minutes * 60);
  const precision = milliseconds ? 3 : 0;
  return `${String(minutes).padStart(2, '0')}:${rest.toFixed(precision).padStart(milliseconds ? 6 : 2, '0')}`;
}

function button(label, className) {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = className;
  element.setAttribute('aria-label', label);
  return element;
}

function place(element, start, end, duration) {
  const safeDuration = Math.max(duration, 0.001);
  const left = Math.min(100, Math.max(0, (start / safeDuration) * 100));
  const right = Math.min(100, Math.max(left, (end / safeDuration) * 100));
  element.style.setProperty('--segment-start', `${left}%`);
  element.style.setProperty('--segment-width', `${Math.max(0.001, right - left)}%`);
}

function minimumPositive(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  let minimum = Infinity;
  for (let index = 1; index < sorted.length; index += 1) {
    const difference = sorted[index] - sorted[index - 1];
    if (difference > 0) minimum = Math.min(minimum, difference);
  }
  return minimum;
}

function timelineCanvasWidth(duration, scenes, words) {
  const shortestScene = Math.min(...scenes.map((scene) => scene.end - scene.start));
  const wordGap = minimumPositive(words.map((word) => word.start));
  const pixelsPerSecond = Math.max(
    BASE_PIXELS_PER_SECOND,
    Number.isFinite(shortestScene) ? MIN_SCENE_WIDTH / shortestScene : 0,
    Number.isFinite(wordGap) ? MIN_WORD_SPACING / wordGap : 0,
  );
  return Math.max(
    MIN_CANVAS_WIDTH,
    Math.ceil((Math.max(0, duration) * pixelsPerSecond) + CANVAS_CHROME_WIDTH),
  );
}

function setCurrent(elements, activeIndex) {
  elements.forEach((element, index) => {
    if (index === activeIndex) element.setAttribute('aria-current', 'true');
    else element.removeAttribute('aria-current');
  });
}

function renderSource(track, video, duration) {
  const target = button('Перейти к началу исходного видео', 'source-segment');
  target.dataset.sourceTarget = '';
  target.innerHTML = '<span>Исходник</span><span>00:00</span>';
  target.addEventListener('click', () => seekPlayer(video, 0));
  track.append(target);
  place(target, 0, duration, duration);
}

function renderScenes(track, video, scenes, duration) {
  return scenes.map((scene, index) => {
    const label = `Сцена ${index + 1}: ${scene.scene}, ${formatTime(scene.start)}–${formatTime(scene.end)}`;
    const target = button(label, 'scene-segment');
    target.dataset.scene = String(index);
    target.dataset.start = String(scene.start);
    target.dataset.end = String(scene.end);

    const number = document.createElement('span');
    number.className = 'segment-number';
    number.textContent = String(index + 1).padStart(2, '0');
    const name = document.createElement('span');
    name.className = 'segment-name';
    name.textContent = scene.caption || scene.headOrange || scene.headCream || scene.scene;
    target.append(number, name);
    target.addEventListener('click', () => seekPlayer(video, scene.start));
    place(target, scene.start, scene.end, duration);
    track.append(target);
    return target;
  });
}

function renderTranscript(list, video, words, duration) {
  return words.map((word, index) => {
    const item = document.createElement('li');
    place(item, word.start, word.end, duration);
    const target = button(`${word.text}, ${formatTime(word.start, true)}`, 'word-segment');
    target.dataset.transcriptWord = String(index);
    target.textContent = word.text;
    target.addEventListener('click', () => seekPlayer(video, word.start));
    item.append(target);
    list.append(item);
    return target;
  });
}

function renderAssets(list, assets) {
  if (assets.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'asset-empty';
    empty.textContent = 'Дополнительных медиа нет';
    list.append(empty);
    return;
  }
  assets.forEach((asset) => {
    const item = document.createElement('li');
    item.className = 'asset-chip';
    if (/\.(?:avif|gif|jpe?g|png|webp)$/i.test(asset.label)) {
      const thumbnail = document.createElement('img');
      thumbnail.className = 'asset-thumbnail';
      thumbnail.src = asset.mediaUrl;
      thumbnail.alt = '';
      item.append(thumbnail);
    }
    const meta = document.createElement('span');
    meta.className = 'asset-meta';
    const kind = document.createElement('span');
    kind.textContent = asset.kind === 'project' ? 'проект' : 'библиотека';
    const label = document.createElement('strong');
    label.textContent = asset.label;
    meta.append(kind, label);
    item.append(meta);
    list.append(item);
  });
}

export function renderTimeline({ root, video, state, timecode }) {
  const duration = state.output.durationInFrames / state.output.fps;
  const scenes = state.brief.scenes;
  const words = state.transcript.words;
  root.querySelector('.timeline-canvas').style.setProperty(
    '--timeline-width',
    `${timelineCanvasWidth(duration, scenes, words)}px`,
  );
  const sceneButtons = renderScenes(
    root.querySelector('[data-scenes-track]'),
    video,
    scenes,
    duration,
  );
  const wordButtons = renderTranscript(
    root.querySelector('[data-transcript]'),
    video,
    words,
    duration,
  );
  renderSource(root.querySelector('[data-source-track]'), video, duration);
  renderAssets(root.querySelector('[data-assets]'), state.assets);

  synchronizePlayer({
    video,
    playhead: root.querySelector('[data-playhead]'),
    duration,
    scenes,
    words,
    onPosition: ({ seconds, sceneIndex, wordIndex }) => {
      timecode.textContent = formatTime(seconds, true);
      setCurrent(sceneButtons, sceneIndex);
      setCurrent(wordButtons, wordIndex);
    },
  });
}

export { formatTime };
