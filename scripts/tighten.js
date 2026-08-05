#!/usr/bin/env node
// Фаза 1.1 — «уплотнение»: вырезает паузы И слова-паразиты (явными интервалами),
// пересчитывает таймкоды слов (без второго whisper). Гварды: хук, мин-длина, дыхание.
//   node tighten.js <video> <transcript.json> <out.mp4> <out.transcript.json>
//        [--maxGap 0.6] [--pad 0.1] [--hookGuard 1.5] [--minDur 3] [--no-fillers]
const fs = require('node:fs');

const { finiteNumber, optionValue } = require('./build-options');
const { hostPath } = require('./process');
const { runTrim } = require('./trim-media');

const FILLER = /^(э+|эм+|ээ+|мм+|ну|типа|короче|значит|как-то|вот|это самое|как бы|в общем|собственно)[.,!?]*$/i;

function parseTightenOptions(args) {
  return {
    maxGap: finiteNumber(optionValue(args, 'maxGap', '0.6'), '--maxGap', { min: 0.001, max: 60 }),
    pad: finiteNumber(optionValue(args, 'pad', '0.1'), '--pad', { min: 0.001, max: 5 }),
    hookGuard: finiteNumber(optionValue(args, 'hookGuard', '1.5'), '--hookGuard', { min: 0.001, max: 60 }),
    minDur: finiteNumber(optionValue(args, 'minDur', '3'), '--minDur', { min: 0.001, max: 86400 }),
    useFillers: !args.includes('--no-fillers'),
  };
}

function collectWords(segments) {
  if (!Array.isArray(segments)) throw new Error('транскрипт должен быть массивом сегментов');
  const words = [];
  for (const segment of segments) {
    for (const word of (segment.words || [])) {
      const text = String(word.w || '').trim();
      if (!text) continue;
      const start = Number(word.s);
      const end = Number(word.e);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
        throw new Error('таймкоды слов должны быть конечными и иметь end > start >= 0');
      }
      words.push({ w: text, s: start, e: end });
    }
  }
  if (!words.length) throw new Error('нет слов');
  return words;
}

function buildCuts(words, options) {
  const isFiller = (word) => options.useFillers && FILLER.test(word.w);
  const start = words[0].s;
  const end = words.at(-1).e;
  let cuts = [];
  for (let index = 0; index < words.length; index++) {
    if (!isFiller(words[index])) continue;
    const previousEnd = index > 0 ? words[index - 1].e : start;
    const nextStart = index < words.length - 1 ? words[index + 1].s : end;
    cuts.push([previousEnd + options.pad, nextStart - options.pad]);
  }
  for (let index = 1; index < words.length; index++) {
    const gap = words[index].s - words[index - 1].e;
    if (gap > options.maxGap) {
      cuts.push([words[index - 1].e + options.pad, words[index].s - options.pad]);
    }
  }
  cuts = cuts
    .map(([cutStart, cutEnd]) => [
      Math.max(cutStart, cutStart < options.hookGuard ? options.hookGuard : cutStart),
      cutEnd,
    ])
    .filter(([cutStart, cutEnd]) => cutEnd - cutStart > 0.05)
    .sort((left, right) => left[0] - right[0]);
  const merged = [];
  for (const cut of cuts) {
    if (merged.length && cut[0] <= merged.at(-1)[1] + 0.02) {
      merged.at(-1)[1] = Math.max(merged.at(-1)[1], cut[1]);
    } else {
      merged.push([...cut]);
    }
  }
  return { merged, isFiller, start, end };
}

function main(args = process.argv.slice(2)) {
  const [videoArg, transcriptInputArg, videoOutputArg, transcriptOutputArg] = args;
  if (!videoArg || !transcriptInputArg || !videoOutputArg || !transcriptOutputArg) {
    throw new Error('укажи video, transcript input, MP4 output и transcript output');
  }
  const options = parseTightenOptions(args);
  const video = hostPath(videoArg);
  const transcriptInput = hostPath(transcriptInputArg);
  const videoOutput = hostPath(videoOutputArg);
  const transcriptOutput = hostPath(transcriptOutputArg);
  const words = collectWords(JSON.parse(fs.readFileSync(transcriptInput, 'utf8')));
  const { merged, isFiller, start, end } = buildCuts(words, options);
  const fillersCut = words.filter(isFiller).length;
  const totalCut = merged.reduce((sum, [cutStart, cutEnd]) => sum + cutEnd - cutStart, 0);
  const newDuration = end - start - totalCut;

  if (!merged.length || newDuration < options.minDur) {
    console.log('ℹ нечего резать. Копирую исходник.');
    fs.copyFileSync(video, videoOutput);
    fs.copyFileSync(transcriptInput, transcriptOutput);
    return;
  }

  const keep = [];
  let cursor = start;
  for (const [cutStart, cutEnd] of merged) {
    if (cutStart > cursor) keep.push([cursor, cutStart]);
    cursor = cutEnd;
  }
  if (cursor < end) keep.push([cursor, end]);
  console.log(`вырезано: интервалов ${merged.length} (филлеров ${fillersCut}) | было ${(end - start).toFixed(1)}с → стало ${newDuration.toFixed(1)}с`);
  runTrim({
    input: video,
    output: videoOutput,
    intervals: keep,
    audioFadeSec: 0.04,
    precision: 3,
  });

  const removedBefore = (time) => merged.reduce(
    (sum, [cutStart, cutEnd]) => sum + (cutEnd <= time
      ? cutEnd - cutStart
      : (cutStart < time ? time - cutStart : 0)),
    0,
  );
  const inCut = (time) => merged.some(([cutStart, cutEnd]) => time >= cutStart && time <= cutEnd);
  const remap = (time) => +(time - removedBefore(time)).toFixed(2);
  const keptWords = words.filter((word) => !isFiller(word) && !inCut(word.s));
  const newSegments = [{
    start: 0,
    end: +newDuration.toFixed(2),
    text: keptWords.map((word) => word.w).join(' '),
    words: keptWords.map((word) => ({ w: word.w, s: remap(word.s), e: remap(word.e) })),
  }];
  fs.writeFileSync(transcriptOutput, JSON.stringify(newSegments, null, 1));
  console.log(`✅ ${videoOutputArg} + транскрипт (${keptWords.length} слов)`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildCuts,
  collectWords,
  main,
  parseTightenOptions,
};
