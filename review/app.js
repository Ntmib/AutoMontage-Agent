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

function renderDiagnostics(timing) {
  const list = document.querySelector('[data-diagnostics]');
  const summary = document.querySelector('[data-diagnostic-summary]');
  const light = document.querySelector('[data-health-light]');
  list.replaceChildren();
  const groups = [
    ['Ошибка', timing.errors, 'error'],
    ['Предупреждение', timing.warnings, 'warning'],
    ['Подсказка', timing.suggestions, 'suggestion'],
  ];
  const count = groups.reduce((total, [, items]) => total + items.length, 0);

  summary.textContent = count === 0
    ? 'Границы сцен совпадают с кадровой сеткой.'
    : `Найдено замечаний: ${count}`;
  light.dataset.health = timing.errors.length > 0 ? 'error' : 'ok';

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

function revisionLabel(revision) {
  return `v${String(revision).padStart(2, '0')}`;
}

function prepareBrowserState(state, token) {
  return {
    ...state,
    assets: state.assets.map((asset) => ({
      ...asset,
      mediaUrl: authenticatedMediaUrl(asset.url, token),
    })),
  };
}

function renderMetadata(state, token) {
  const duration = state.output.durationInFrames / state.output.fps;
  document.querySelector('[data-project-title]').textContent = `${state.project.name} · ${state.brief.title}`;
  document.querySelector('[data-brief-status]').textContent = statusLabel(state.brief.status);
  document.querySelector('[data-duration]').textContent = formatTime(duration, true);
  document.querySelector('[data-output]').textContent = (
    `${state.output.width}×${state.output.height} · ${state.output.fps} FPS`
  );

  const video = document.querySelector('video');
  const mediaUrl = authenticatedMediaUrl(state.source.url, token);
  if (video.getAttribute('src') !== mediaUrl) video.src = mediaUrl;
  let revision = document.querySelector('[data-revision]');
  if (!revision) {
    revision = document.createElement('span');
    revision.className = 'revision-label';
    revision.dataset.revision = '';
    document.querySelector('[data-brief-status]').parentElement.append(revision);
  }
  revision.textContent = revisionLabel(state.session.baseRevision);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createEditControls() {
  const panel = element('section', 'panel edit-workbench');
  panel.dataset.editControls = '';
  panel.setAttribute('aria-labelledby', 'edit-title');
  const heading = element('div', 'edit-heading');
  const titleGroup = element('div');
  titleGroup.append(
    element('p', 'panel-kicker', 'Безопасные правки'),
    element('h2', '', 'Редактирование'),
  );
  titleGroup.lastElementChild.id = 'edit-title';
  const actions = element('div', 'edit-actions');
  const undo = element('button', 'edit-button', 'Отменить');
  undo.type = 'button';
  const redo = element('button', 'edit-button', 'Повторить');
  redo.type = 'button';
  const save = element('button', 'edit-button edit-button--primary', 'Сохранить');
  save.type = 'button';
  actions.append(undo, redo, save);
  heading.append(titleGroup, actions);

  const status = element('p', 'edit-status', 'Изменений нет');
  status.dataset.editStatus = '';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const conflict = element('p', 'edit-conflict');
  conflict.dataset.conflict = '';
  conflict.hidden = true;
  const error = element('p', 'edit-error');
  error.dataset.editError = '';
  error.setAttribute('role', 'alert');
  error.hidden = true;

  const body = element('div', 'edit-body');
  const diffSection = element('section', 'edit-diff');
  const diffTitle = element('h3', '', 'Проверенные изменения');
  const diff = element('ul', 'edit-diff-list');
  diff.dataset.serverDiff = '';
  diffSection.append(diffTitle, diff);
  const brollSection = element('section', 'edit-broll');
  const brollTitle = element('h3', '', 'B-roll');
  const broll = element('div', 'broll-controls');
  broll.dataset.brollControls = '';
  brollSection.append(brollTitle, broll);
  body.append(diffSection, brollSection);
  panel.append(heading, status, conflict, error, body);
  document.querySelector('.timeline-panel').before(panel);
  return {
    panel,
    undo,
    redo,
    save,
    status,
    conflict,
    error,
    diff,
    broll,
  };
}

function diffLine(change, state) {
  if (change.kind === 'boundary') {
    return `Граница сцен ${change.leftScene + 1}–${change.rightScene + 1}: ${formatTime(change.from, true)} → ${formatTime(change.to, true)}`;
  }
  const labels = new Map(state.assets.map((asset) => [asset.id, asset.label]));
  return `Медиа сцены ${change.scene + 1}: ${labels.get(change.from) || 'не выбрано'} → ${labels.get(change.to) || 'не выбрано'}`;
}

function validValidation(value) {
  return value && Array.isArray(value.diff)
    && Number.isSafeInteger(value.destinationRevision)
    && value.destinationRevision > 0
    && value.timing
    && Array.isArray(value.timing.errors)
    && Array.isArray(value.timing.warnings)
    && Array.isArray(value.timing.suggestions);
}

function editPayload(state, commands) {
  return {
    baseRevision: state.session.baseRevision,
    baseHash: state.session.baseHash,
    manifestHash: state.session.manifestHash,
    commands,
  };
}

async function postEdit(pathname, token, payload) {
  const response = await fetch(pathname, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  let data = null;
  if (response.ok) {
    try {
      data = await response.json();
    } catch (_) {
      data = null;
    }
  }
  return { response, data };
}

function createEditor(initialState, token) {
  let state = prepareBrowserState(initialState, token);
  const commands = [];
  const redoStack = [];
  let validation = { destinationRevision: null, diff: [], timing: state.timing };
  let pending = false;
  let saving = false;
  let invalid = false;
  let conflict = false;
  let lastSnap = null;
  let focusBoundary = null;
  let timelineCleanup = null;
  let validationGeneration = 0;
  const controls = createEditControls();
  document.querySelector('.mode-badge').textContent = 'Редактирование';

  function showEditError(message) {
    controls.error.textContent = message;
    controls.error.hidden = false;
  }

  function clearEditError() {
    controls.error.textContent = '';
    controls.error.hidden = true;
  }

  function renderBrollControls() {
    controls.broll.replaceChildren();
    const assets = state.assets.filter((asset) => /^asset-[1-9]\d*$/.test(asset.id));
    const eligible = state.brief.scenes
      .map((scene, index) => ({ scene, index }))
      .filter(({ scene }) => scene.scene === 'broll');
    if (eligible.length === 0) {
      controls.broll.append(element('p', 'broll-empty', 'Подходящих сцен нет'));
      return;
    }
    eligible.forEach(({ index }) => {
      const wrapper = element('label', 'broll-field');
      wrapper.append(element('span', '', `Сцена ${index + 1}`));
      const select = element('select', 'broll-select');
      select.dataset.brollSelect = '';
      select.dataset.sceneIndex = String(index);
      const placeholder = element('option', '', 'Выберите медиа');
      placeholder.value = '';
      placeholder.disabled = true;
      select.append(placeholder);
      assets.forEach((asset) => {
        const option = element('option', '', asset.label);
        option.value = asset.id;
        select.append(option);
      });
      const selected = validation.diff.find((change) => (
        change.kind === 'asset' && change.scene === index
      ));
      select.value = selected ? selected.to : '';
      select.disabled = pending || saving;
      select.addEventListener('change', () => {
        if (saving) return;
        if (!/^asset-[1-9]\d*$/.test(select.value)) return;
        dispatch({ type: 'replace-broll', sceneIndex: index, assetId: select.value });
      });
      wrapper.append(select);
      controls.broll.append(wrapper);
    });
  }

  function renderEditChrome() {
    const count = commands.length;
    controls.status.textContent = conflict
      ? `Несохранённых изменений: ${count}`
      : count === 0 ? 'Изменений нет' : `Изменений: ${count}`;
    controls.undo.disabled = count === 0 || pending || saving;
    controls.redo.disabled = redoStack.length === 0 || pending || saving;
    controls.save.disabled = pending || saving || invalid || conflict
      || !validation || validation.diff.length === 0;
    controls.conflict.hidden = !conflict;
    controls.conflict.textContent = conflict
      ? 'Конфликт ревизий: загружена последняя версия. Правки сохранены только в памяти для сравнения.'
      : '';
    controls.diff.replaceChildren();
    if (validation.diff.length === 0) {
      controls.diff.append(element('li', 'edit-diff-empty', 'Проверенных изменений нет'));
    } else {
      validation.diff.forEach((change) => {
        controls.diff.append(element('li', '', diffLine(change, state)));
      });
    }
    renderBrollControls();
  }

  function renderAll() {
    renderMetadata(state, token);
    renderDiagnostics(validation.timing);
    if (timelineCleanup) timelineCleanup();
    timelineCleanup = renderTimeline({
      root: document.querySelector('[data-timeline-root]'),
      video: document.querySelector('video'),
      state,
      timecode: document.querySelector('[data-timecode]'),
      diff: validation.diff,
      edit: {
        lastSnap,
        invalid,
        locked: saving,
        focusBoundary,
        onBoundaryFocus: (index) => { focusBoundary = index; },
        onBoundaryChange: dispatch,
      },
    });
    renderEditChrome();
    document.querySelector('main').dataset.reviewReady = '';
  }

  async function reloadAfterConflict(generation) {
    let latest;
    try {
      latest = await loadState(token);
    } catch (_) {
      if (generation !== validationGeneration) return;
      pending = false;
      saving = false;
      invalid = true;
      showEditError('Не удалось загрузить последнюю ревизию. Перезапустите проверку.');
      renderAll();
      return;
    }
    if (generation !== validationGeneration) return;
    state = prepareBrowserState(latest, token);
    validation = { destinationRevision: null, diff: [], timing: state.timing };
    pending = false;
    saving = false;
    invalid = false;
    conflict = true;
    lastSnap = null;
    clearEditError();
    renderAll();
  }

  async function validateCommands(snap = null) {
    const generation = ++validationGeneration;
    pending = true;
    saving = false;
    invalid = false;
    conflict = false;
    lastSnap = snap;
    clearEditError();
    renderEditChrome();
    let result;
    try {
      result = await postEdit('/api/validate', token, editPayload(state, commands));
    } catch (_) {
      result = null;
    }
    if (generation !== validationGeneration) return;
    if (result && result.response.status === 409) {
      await reloadAfterConflict(generation);
      return;
    }
    if (!result || !result.response.ok || !validValidation(result.data)) {
      pending = false;
      invalid = true;
      lastSnap = null;
      showEditError('Не удалось проверить изменения. Отмените последнее действие.');
      renderAll();
      return;
    }
    validation = result.data;
    pending = false;
    invalid = validation.timing.errors.length > 0;
    if (invalid) showEditError('В тайминге есть ошибка. Исправьте границу перед сохранением.');
    renderAll();
  }

  function dispatch(command, snap = null) {
    if (saving) return;
    focusBoundary = snap && snap.restoreFocus ? snap.index : null;
    commands.push(command);
    redoStack.length = 0;
    void validateCommands(snap);
  }

  function undo() {
    if (saving) return;
    const command = commands.pop();
    if (!command) return;
    redoStack.push(command);
    lastSnap = null;
    focusBoundary = null;
    void validateCommands();
  }

  function redo() {
    if (saving) return;
    const command = redoStack.pop();
    if (!command) return;
    commands.push(command);
    lastSnap = null;
    focusBoundary = null;
    void validateCommands();
  }

  async function save() {
    if (controls.save.disabled) return;
    const lines = validation.diff.map((change) => diffLine(change, state));
    const destination = revisionLabel(validation.destinationRevision);
    const accepted = window.confirm(
      `Будет создана ревизия ${destination}:\n\n${lines.map((line) => `• ${line}`).join('\n')}`,
    );
    if (!accepted) return;
    const generation = ++validationGeneration;
    const payload = editPayload(state, commands);
    saving = true;
    focusBoundary = null;
    clearEditError();
    renderAll();
    let result;
    try {
      result = await postEdit('/api/save', token, payload);
    } catch (_) {
      result = null;
    }
    if (generation !== validationGeneration) return;
    if (result && result.response.status === 409) {
      await reloadAfterConflict(generation);
      return;
    }
    if (!result || result.response.status !== 201) {
      saving = false;
      invalid = true;
      showEditError('Не удалось сохранить новую ревизию. Изменения остались в памяти.');
      renderAll();
      return;
    }
    let latest;
    try {
      latest = await loadState(token);
    } catch (_) {
      saving = false;
      invalid = true;
      showEditError('Ревизия сохранена, но не удалось обновить экран. Перезапустите проверку.');
      renderAll();
      return;
    }
    state = prepareBrowserState(latest, token);
    commands.length = 0;
    redoStack.length = 0;
    validation = { destinationRevision: null, diff: [], timing: state.timing };
    pending = false;
    saving = false;
    invalid = false;
    conflict = false;
    lastSnap = null;
    clearEditError();
    renderAll();
  }

  controls.undo.addEventListener('click', undo);
  controls.redo.addEventListener('click', redo);
  controls.save.addEventListener('click', () => { void save(); });
  renderAll();
}

function renderReadOnly(state, token) {
  const browserState = prepareBrowserState(state, token);
  renderMetadata(browserState, token);
  renderDiagnostics(browserState.timing);
  renderTimeline({
    root: document.querySelector('[data-timeline-root]'),
    video: document.querySelector('video'),
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
    .then((state) => {
      if (state.session.editable) createEditor(state, sessionToken);
      else renderReadOnly(state, sessionToken);
    })
    .catch(showError);
}
