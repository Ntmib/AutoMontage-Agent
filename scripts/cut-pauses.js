#!/usr/bin/env node
// Вырезает длинные паузы из видео по словным таймкодам транскрипта.
// node cut-pauses.js <video> <transcript.json> <out.mp4> [maxGap] [pad]
const fs = require('node:fs');

const { finiteNumber } = require('./build-options');
const { hostPath } = require('./process');
const { collectWords } = require('./tighten');
const { runTrim } = require('./trim-media');

function parseCutOptions(args) {
  return {
    maxGap: finiteNumber(args[3] ?? '0.55', 'maxGap', { min: 0.001, max: 60 }),
    pad: finiteNumber(args[4] ?? '0.10', 'pad', { min: 0.001, max: 5 }),
  };
}

function buildKeepIntervals(words, options) {
  const keep = [];
  let start = Math.max(0, words[0].s - options.pad);
  let end = words[0].e;
  for (let index = 1; index < words.length; index++) {
    const gap = words[index].s - end;
    if (gap > options.maxGap && gap > options.pad * 2) {
      keep.push([start, end + options.pad]);
      start = words[index].s - options.pad;
    }
    end = words[index].e;
  }
  keep.push([start, end + options.pad]);
  return keep;
}

function main(args = process.argv.slice(2)) {
  const [videoArg, transcriptArg, outputArg] = args;
  if (!videoArg || !transcriptArg || !outputArg) {
    throw new Error('укажи video, transcript и output');
  }
  const options = parseCutOptions(args);
  const video = hostPath(videoArg);
  const transcript = hostPath(transcriptArg);
  const output = hostPath(outputArg);
  const words = collectWords(JSON.parse(fs.readFileSync(transcript, 'utf8')));
  const keep = buildKeepIntervals(words, options);
  const duration = keep.reduce((sum, [start, end]) => sum + end - start, 0);
  console.log(`keep-сегментов: ${keep.length}, длительность после: ${duration.toFixed(1)}с`);
  runTrim({ input: video, output, intervals: keep });
  console.log(`✅ ${outputArg}`);
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
  buildKeepIntervals,
  main,
  parseCutOptions,
};
