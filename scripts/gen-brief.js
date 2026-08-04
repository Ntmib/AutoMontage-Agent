#!/usr/bin/env node
// Из транскрипта собирает черновик ТЗ, выбирая только из 7 готовых сцен.
// Скрипт не рендерит видео и не создаёт новые React-компоненты.

const fs = require('fs');
const path = require('path');
const dictionary = require('./data/proofread-dictionary.json');
const {
  OFFICIAL_SCENES,
  formatBriefMarkdown,
  validateLessonBrief,
} = require('./lesson/brief');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyDictionary(segments, entries = dictionary) {
  const corrections = [];
  const correctedSegments = (Array.isArray(segments) ? segments : []).map((segment) => {
    let text = String(segment.text || '');
    for (const entry of entries) {
      if (!entry.from || !entry.to) continue;
      const pattern = new RegExp(escapeRegExp(entry.from), 'giu');
      text = text.replace(pattern, (matched) => {
        corrections.push({
          start: Number(segment.start) || 0,
          end: Number(segment.end) || Number(segment.start) || 0,
          from: matched,
          to: entry.to,
          reason: entry.reason || 'словарь автозамен',
        });
        return entry.to;
      });
    }
    return { ...segment, text };
  });
  return { segments: correctedSegments, corrections };
}

function cleanString(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function cleanArray(value, limit) {
  return (Array.isArray(value) ? value : [])
    .map((item) => cleanString(item))
    .filter(Boolean)
    .slice(0, limit);
}

function baseScene(scene) {
  const start = Math.max(0, Number(scene.start) || 0);
  const rawEnd = Number(scene.end);
  const end = Number.isFinite(rawEnd) && rawEnd > start ? rawEnd : start + 4;
  const result = { scene: scene.scene, start, end };
  if (scene.reason) result.reason = cleanString(scene.reason);
  return result;
}

function fallbackSplit(scene) {
  const base = baseScene({ ...scene, scene: 'split' });
  const supportingText = cleanString(
    scene.sub || scene.caption || scene.quoteCream || scene.big || scene.statCream,
  );
  return {
    ...base,
    scene: 'split',
    num: cleanString(scene.num),
    headCream: cleanString(scene.headCream || scene.quoteCream, 'ГЛАВНАЯ'),
    headOrange: cleanString(scene.headOrange || scene.quoteOrange || scene.big, 'МЫСЛЬ'),
    bullets: cleanArray(scene.bullets || scene.steps, 4).length
      ? cleanArray(scene.bullets || scene.steps, 4)
      : (supportingText ? [supportingText] : []),
  };
}

function normalizeScene(scene, availableBroll) {
  const requested = cleanString(scene.scene);
  const base = baseScene({ ...scene, scene: requested });

  if (!OFFICIAL_SCENES.includes(requested)) return fallbackSplit(scene);

  if (requested === 'fullscreen') {
    const caption = cleanString(scene.caption);
    return caption ? { ...base, caption } : fallbackSplit(scene);
  }
  if (requested === 'split') return fallbackSplit(scene);
  if (requested === 'bottom-diagram') {
    const steps = cleanArray(scene.steps, 4);
    if (!steps.length) return fallbackSplit(scene);
    return {
      ...base,
      headCream: cleanString(scene.headCream, 'КАК ЭТО'),
      headOrange: cleanString(scene.headOrange, 'РАБОТАЕТ'),
      steps,
    };
  }
  if (requested === 'blur-overlay') {
    if (!cleanString(scene.big) || !cleanString(scene.headCream) || !cleanString(scene.headOrange)) {
      return fallbackSplit(scene);
    }
    const result = {
      ...base,
      label: cleanString(scene.label, 'ФАКТ'),
      big: cleanString(scene.big),
      headCream: cleanString(scene.headCream),
      headOrange: cleanString(scene.headOrange),
    };
    if (scene.sub) result.sub = cleanString(scene.sub);
    return result;
  }
  if (requested === 'text-only') {
    if (!cleanString(scene.quoteCream) && !cleanString(scene.quoteOrange)) return fallbackSplit(scene);
    const result = {
      ...base,
      label: cleanString(scene.label, 'ГЛАВНОЕ'),
      quoteCream: cleanString(scene.quoteCream),
      quoteOrange: cleanString(scene.quoteOrange),
    };
    if (scene.author) result.author = cleanString(scene.author);
    return result;
  }
  if (requested === 'stat') {
    const required = [scene.statCream, scene.statOrange, scene.headCream, scene.headOrange]
      .every((value) => cleanString(value));
    if (!required) return fallbackSplit(scene);
    const result = {
      ...base,
      label: cleanString(scene.label, 'РЕЗУЛЬТАТ'),
      statCream: cleanString(scene.statCream),
      statOrange: cleanString(scene.statOrange),
      headCream: cleanString(scene.headCream),
      headOrange: cleanString(scene.headOrange),
    };
    if (scene.sub) result.sub = cleanString(scene.sub);
    return result;
  }

  const brollSrc = cleanString(scene.brollSrc);
  if (!brollSrc || !availableBroll.includes(brollSrc)) return fallbackSplit(scene);
  const result = {
    ...base,
    brollSrc,
    headCream: cleanString(scene.headCream, 'ЖИВОЙ'),
    headOrange: cleanString(scene.headOrange, 'ПРИМЕР'),
  };
  if (scene.sub) result.sub = cleanString(scene.sub);
  return result;
}

function normalizeCorrections(corrections) {
  const seen = new Set();
  return (Array.isArray(corrections) ? corrections : []).flatMap((correction) => {
    const from = cleanString(correction.from);
    const to = cleanString(correction.to);
    if (!from || !to || from === to) return [];
    const normalized = {
      start: Math.max(0, Number(correction.start) || 0),
      from,
      to,
      reason: cleanString(correction.reason, 'контекстная правка'),
    };
    if (Number.isFinite(Number(correction.end))) normalized.end = Math.max(normalized.start, Number(correction.end));
    const key = `${normalized.start}|${from}|${to}`.toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    return [normalized];
  });
}

function removeOverlaps(scenes) {
  const result = [];
  for (const scene of scenes.sort((a, b) => a.start - b.start)) {
    const previous = result[result.length - 1];
    if (previous && scene.start < previous.end) {
      previous.end = scene.start;
      if (previous.end <= previous.start) result.pop();
    }
    result.push(scene);
  }
  return result;
}

function normalizeGeneratedBrief(generated, context) {
  const availableBroll = Array.isArray(context.availableBroll) ? context.availableBroll : [];
  const maxScenes = Math.max(1, Number.parseInt(context.maxScenes, 10) || 12);
  const scenes = removeOverlaps(
    (Array.isArray(generated.scenes) ? generated.scenes : [])
      .map((scene) => normalizeScene(scene || {}, availableBroll)),
  ).slice(0, maxScenes);
  const corrections = normalizeCorrections([
    ...(context.dictionaryCorrections || []),
    ...(generated.corrections || []),
  ]);
  const brief = {
    version: 1,
    status: 'draft',
    source: context.source,
    theme: context.theme,
    title: context.title,
    output: { ...context.output },
    corrections,
    scenes,
  };
  if (context.facePos) brief.facePos = context.facePos;

  const validation = validateLessonBrief(brief);
  if (!validation.ok) throw new Error(`gen-brief создал невалидный черновик:\n${validation.errors.join('\n')}`);
  return brief;
}

function buildSystemPrompt({ maxScenes, availableBroll }) {
  const brollRule = availableBroll.length
    ? `broll разрешён только с одним из brollSrc: ${availableBroll.join(', ')}`
    : 'broll не используй: доступных файлов нет.';
  return `Ты режиссёр обучающего видео. Ты НЕ создаёшь дизайн и НЕ придумываешь новые сцены.
Выбирай не более ${maxScenes} сцен только из фиксированной библиотеки:
- fullscreen: короткий заход или связка, поля caption;
- split: основное объяснение, поля num, headCream, headOrange, bullets;
- bottom-diagram: последовательность, поля headCream, headOrange, steps;
- blur-overlay: сильный акцент, поля label, big, headCream, headOrange, sub;
- text-only: дословная цитата, поля label, quoteCream, quoteOrange, author;
- stat: реально произнесённая метрика, поля label, statCream, statOrange, headCream, headOrange, sub;
- broll: реальный визуальный пример, поля brollSrc, headCream, headOrange, sub.

Правила:
- chart запрещён;
- не заставляй ролик использовать все типы;
- не ставь одинаковые сцены подряд без смысловой причины;
- start и end бери из таймкодов речи, интервалы не должны пересекаться;
- тексты, цитаты и цифры только из транскрипта, без новых фактов;
- заголовки короткие, буллетов и шагов не больше 4;
- stat используй только для точного числа из речи;
- ${brollRule}
- найди оставшиеся ошибки распознавания и верни их в corrections с from, to, reason, start, end.

Верни только JSON: {"scenes":[...],"corrections":[...]}.`;
}

async function callAnthropic(system, user) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 6000,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`Anthropic: ${JSON.stringify(json).slice(0, 400)}`);
  return json.content[0].text;
}

async function callOpenAI(system, user) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
    }),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`OpenAI: ${JSON.stringify(json).slice(0, 400)}`);
  return json.choices[0].message.content;
}

function option(args, name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}

function parseJsonResponse(raw) {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('LLM не вернул JSON-объект');
  return JSON.parse(raw.slice(start, end + 1));
}

async function main() {
  const args = process.argv.slice(2);
  const inputPath = args[0];
  const outputPath = args[1];
  if (!inputPath || !outputPath) {
    console.error('usage: gen-brief.js <transcript.json> <brief.json> [--markdown brief.md] [--aspect source|vertical|horizontal]');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    throw new Error('нужен ANTHROPIC_API_KEY или OPENAI_API_KEY');
  }

  const segments = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const proofread = applyDictionary(segments, dictionary);
  const availableBroll = cleanString(option(args, 'available-broll', ''))
    .split(',').map((item) => item.trim()).filter(Boolean);
  const maxScenes = Math.max(1, Number.parseInt(option(args, 'max', '12'), 10) || 12);
  const fps = Number(option(args, 'fps', '30')) || 30;
  const duration = Number(option(args, 'duration', '0')) || 0;
  const lines = proofread.segments
    .map((segment) => `[${segment.start}-${segment.end}] ${segment.text}`)
    .join('\n');
  const system = buildSystemPrompt({ maxScenes, availableBroll });
  const user = `Транскрипт с таймкодами:\n\n${lines}\n\nСобери черновик монтажного ТЗ.`;
  const raw = process.env.ANTHROPIC_API_KEY
    ? await callAnthropic(system, user)
    : await callOpenAI(system, user);
  const generated = parseJsonResponse(raw);
  const brief = normalizeGeneratedBrief(generated, {
    source: option(args, 'source', 'source.mp4'),
    theme: option(args, 'theme', 'dima-grunge'),
    title: option(args, 'title', 'ВИДЕО'),
    output: {
      aspect: option(args, 'aspect', 'source'),
      width: Number(option(args, 'width', '1080')),
      height: Number(option(args, 'height', '1920')),
      fps,
      durationInFrames: Math.max(1, Math.ceil(duration * fps)),
    },
    dictionaryCorrections: proofread.corrections,
    availableBroll,
    maxScenes,
  });

  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(brief, null, 2)}\n`);
  const markdownPath = option(args, 'markdown', outputPath.replace(/\.json$/i, '.md'));
  fs.mkdirSync(path.dirname(path.resolve(markdownPath)), { recursive: true });
  fs.writeFileSync(markdownPath, formatBriefMarkdown(brief));
  console.log(`черновик ТЗ: ${outputPath}`);
  console.log(`читаемое ТЗ: ${markdownPath}`);
}

module.exports = {
  applyDictionary,
  buildSystemPrompt,
  normalizeGeneratedBrief,
  parseJsonResponse,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`gen-brief FAIL: ${error.message}`);
    process.exit(1);
  });
}
