import { formatTime, renderTimeline } from './timeline.js';

function takeSessionToken() {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const token = fragment.get('token');
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  return token;
}

function authenticatedMediaUrl(pathname, token) {
  const url = new URL(pathname, window.location.origin);
  url.searchParams.set('token', token);
  return `${url.pathname}${url.search}`;
}

async function loadState(token) {
  const response = await fetch('/api/state', {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('review state request failed');
  return response.json();
}

function statusLabel(status) {
  return status === 'approved' ? 'Утверждён' : 'Черновик';
}

function renderDiagnostics(state) {
  const list = document.querySelector('[data-diagnostics]');
  const summary = document.querySelector('[data-diagnostic-summary]');
  const light = document.querySelector('[data-health-light]');
  const groups = [
    ['Ошибка', state.timing.errors, 'error'],
    ['Предупреждение', state.timing.warnings, 'warning'],
    ['Подсказка', state.timing.suggestions, 'suggestion'],
  ];
  const count = groups.reduce((total, [, items]) => total + items.length, 0);

  summary.textContent = count === 0
    ? 'Границы сцен совпадают с кадровой сеткой.'
    : `Найдено замечаний: ${count}`;
  light.dataset.health = state.timing.errors.length > 0 ? 'error' : 'ok';

  if (count === 0) {
    const item = document.createElement('li');
    item.className = 'diagnostic-ok';
    item.textContent = 'Критических расхождений нет';
    list.append(item);
    return;
  }

  groups.forEach(([label, items, tone]) => {
    items.forEach((entry) => {
      const item = document.createElement('li');
      item.dataset.tone = tone;
      const prefix = document.createElement('span');
      prefix.textContent = label;
      const message = document.createElement('p');
      message.textContent = entry.message || (
        `Сцена ${(entry.sceneIndex ?? 0) + 1}: границу лучше поставить на ${formatTime(entry.suggestedSeconds, true)}`
      );
      item.append(prefix, message);
      list.append(item);
    });
  });
}

function renderShell(state, token) {
  const duration = state.output.durationInFrames / state.output.fps;
  document.querySelector('[data-project-title]').textContent = `${state.project.name} · ${state.brief.title}`;
  document.querySelector('[data-brief-status]').textContent = statusLabel(state.brief.status);
  document.querySelector('[data-duration]').textContent = formatTime(duration, true);
  document.querySelector('[data-output]').textContent = (
    `${state.output.width}×${state.output.height} · ${state.output.fps} FPS`
  );

  const video = document.querySelector('video');
  video.src = authenticatedMediaUrl(state.source.url, token);
  const browserState = {
    ...state,
    assets: state.assets.map((asset) => ({
      ...asset,
      mediaUrl: authenticatedMediaUrl(asset.url, token),
    })),
  };
  renderDiagnostics(state);
  renderTimeline({
    root: document.querySelector('[data-timeline-root]'),
    video,
    state: browserState,
    timecode: document.querySelector('[data-timecode]'),
  });
  document.querySelector('main').dataset.reviewReady = '';
}

function showError() {
  document.querySelector('.review-layout').hidden = true;
  document.querySelector('.timeline-panel').hidden = true;
  document.querySelector('[data-error-panel]').hidden = false;
}

const sessionToken = takeSessionToken();
if (!sessionToken) {
  showError();
} else {
  loadState(sessionToken)
    .then((state) => renderShell(state, sessionToken))
    .catch(showError);
}
