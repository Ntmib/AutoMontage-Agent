#!/usr/bin/env node
// gen-slides.js: из транскрипта эфира собирает монтажный лист слайдов
// (lessonSlide) для шаблона lesson-presentation.
//
// Ключевое: sub каждого слайда = ДОСЛОВНАЯ главная фраза спикера из этого
// куска (чистим только слова-паразиты), заголовок и буллеты из его же слов.
// Ничего не выдумываем: только то, что реально сказано.
//
// Вход:  транскрипт JSON от scripts/transcribe.py: [{start,end,text,words}]
// Выход: scenario JSON { theme, slides:[{start,end,num,headCream,headOrange,sub,bullets,chips,chipsLabel}] }
//
// Провайдер: ANTHROPIC_API_KEY (Claude) если есть, иначе OPENAI_API_KEY (gpt-5).
// Использование:
//   node scripts/gen-slides.js <transcript.json> <out-scenario.json> [--theme lesson-neutral] [--max 8]

const fs = require('fs');

const args = process.argv.slice(2);
const [inPath, outPath] = args.filter((a) => !a.startsWith('--'));
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
if (!inPath || !outPath) { console.error('usage: gen-slides.js <transcript.json> <out.json> [--theme X] [--max N]'); process.exit(1); }

const theme = opt('theme', 'lesson-neutral');
const maxSlides = parseInt(opt('max', '8'), 10);
const segs = JSON.parse(fs.readFileSync(inPath, 'utf8'));

const lines = segs.map((s) => `[${s.start}-${s.end}] ${s.text}`).join('\n');
const totalDur = segs.length ? segs[segs.length - 1].end : 0;

const SYSTEM = `Ты монтажёр обучающих видео. По транскрипту эфира (говорящая голова) собираешь монтажный лист СЛАЙДОВ-презентации, которые показываются справа от спикера синхронно с его речью.

СТРОГИЕ ПРАВИЛА:
- Бей эфир на ${Math.min(maxSlides, 8)}..${maxSlides} смысловых кусков (тем). Каждый кусок = один слайд.
- start/end слайда бери из таймкодов транскрипта (в секундах): слайд показывается, пока спикер говорит про эту тему.
- headCream + headOrange = короткий заголовок темы В ДВЕ СТРОКИ (2-4 слова всего), СЛОВАМИ СПИКЕРА. headOrange = ключевое слово (акцент). Регистр не важен, движок сам сделает.
- sub = ОДНА самая важная фраза спикера из этого куска, ДОСЛОВНО как он сказал. Чистить только слова-паразиты (ну, вот, значит, короче) и оговорки. НЕ перефразировать, НЕ выдумывать.
- bullets = 2-4 коротких пункта, что он говорит по теме, ЕГО формулировками, сжато. Только реально сказанное. Если пунктов нет, пустой массив.
- chips = термины/инструменты/названия, реально упомянутые (Claude, YouTube, эфир и т.п.), 0-3 штуки. chipsLabel = короткий лейбл ("ИНСТРУМЕНТЫ"/"ЧТО ДЕЛАЕМ") или "".
- num = "01","02",... по порядку.
- Язык русский, как у спикера.

Верни СТРОГО JSON: {"slides":[{"start":num,"end":num,"num":"01","headCream":"...","headOrange":"...","sub":"...","bullets":["..."],"chipsLabel":"...","chips":["..."]}]}`;

const USER = `Транскрипт эфира (таймкоды в секундах), общая длительность ${totalDur}s:\n\n${lines}\n\nСобери монтажный лист слайдов по правилам. Только JSON.`;

async function callAnthropic() {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 4000, system: SYSTEM, messages: [{ role: 'user', content: USER }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Anthropic: ' + JSON.stringify(j).slice(0, 300));
  return j.content[0].text;
}

async function callOpenAI() {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + process.env.OPENAI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5',
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: USER }],
      response_format: { type: 'json_object' },
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('OpenAI: ' + JSON.stringify(j).slice(0, 300));
  return j.choices[0].message.content;
}

(async () => {
  const raw = process.env.ANTHROPIC_API_KEY ? await callAnthropic() : await callOpenAI();
  const jsonStr = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  const parsed = JSON.parse(jsonStr);
  let slides = (parsed.slides || []).map((s, i) => ({
    start: Number(s.start) || 0,
    end: Number(s.end) || (Number(s.start) || 0) + 4,
    num: s.num || String(i + 1).padStart(2, '0'),
    headCream: s.headCream || '', headOrange: s.headOrange || '',
    sub: s.sub || '', bullets: Array.isArray(s.bullets) ? s.bullets.slice(0, 4) : [],
    chipsLabel: s.chipsLabel || '', chips: Array.isArray(s.chips) ? s.chips.slice(0, 3) : [],
  }));
  slides.sort((a, b) => a.start - b.start);
  for (let i = 0; i < slides.length - 1; i++) if (slides[i].end > slides[i + 1].start) slides[i].end = slides[i + 1].start;

  const out = { theme, name: 'Спикер', role: '', faceSrc: null, slides };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`слайдов: ${slides.length} -> ${outPath}`);
})().catch((e) => { console.error('gen-slides FAIL:', e.message); process.exit(1); });
