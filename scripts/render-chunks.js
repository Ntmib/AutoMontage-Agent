#!/usr/bin/env node
// Фаза 3.3 — рендер длинного ролика порциями с resume + склейка.
//   node render-chunks.js <comp> <props.json> <out.mp4> <totalFrames> [--chunk 300]
// Готовые порции (out/.chunks/<id>_N.mp4) не перерендериваются — resume после сбоя.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { finiteNumber, optionValue } = require('./build-options');
const { resolveRemotionCommand } = require('./env');
const { hostPath, runTool } = require('./process');

const ROOT = path.join(__dirname, '..');

function parseChunkOptions(args, root = ROOT) {
  const [composition, propsArg, outputArg, totalValue] = args;
  if (!composition || !propsArg || !outputArg || totalValue == null) {
    throw new Error('укажи composition, props, output и totalFrames');
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(composition)) {
    throw new Error('composition должен быть безопасным Remotion id');
  }
  const audioValue = optionValue(args, 'audio', null);
  return {
    composition,
    props: hostPath(propsArg, root),
    output: hostPath(outputArg, root),
    total: finiteNumber(totalValue, 'totalFrames', {
      min: 1,
      max: 10_000_000,
      integer: true,
    }),
    chunk: finiteNumber(optionValue(args, 'chunk', '300'), '--chunk', {
      min: 1,
      max: 1_000_000,
      integer: true,
    }),
    audio: audioValue == null ? null : hostPath(audioValue, root),
  };
}

function chunkRanges(total, chunk) {
  const ranges = [];
  for (let from = 0; from < total; from += chunk) {
    ranges.push({ from, to: Math.min(from + chunk - 1, total - 1) });
  }
  return ranges;
}

function remotionChunkCommand(resolvedRemotion, {
  composition,
  props,
  output,
  from,
  to,
}) {
  return {
    command: resolvedRemotion.command,
    args: [
      ...resolvedRemotion.argsPrefix,
      'render',
      'src/index.js',
      composition,
      hostPath(output),
      '--props', hostPath(props),
      '--frames', `${from}-${to}`,
      '--codec=h264',
      '--log=error',
    ],
  };
}

function concatChunksCommand(parts, output) {
  if (!Array.isArray(parts) || parts.length === 0) throw new Error('нет chunk-файлов для concat');
  const args = ['-y'];
  for (const part of parts) args.push('-i', hostPath(part));
  const filterInputs = parts.map((_, index) => `[${index}:v]`).join('');
  args.push(
    '-filter_complex', `${filterInputs}concat=n=${parts.length}:v=1:a=0[vout]`,
    '-map', '[vout]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    hostPath(output),
  );
  return { command: 'ffmpeg', args };
}

function muxAudioCommand(video, audio, output) {
  return {
    command: 'ffmpeg',
    args: [
      '-y',
      '-i', hostPath(video),
      '-i', hostPath(audio),
      '-map', '0:v',
      '-map', '1:a',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-movflags', '+faststart',
      hostPath(output),
    ],
  };
}

function temporaryPartPath(part, id) {
  const extension = path.extname(part) || '.mp4';
  return `${part.slice(0, -extension.length)}.tmp-${id}${extension}`;
}

function renderChunkAtomically({
  resolvedRemotion,
  composition,
  props,
  part,
  from,
  to,
}, {
  fileSystem = fs,
  run = runTool,
  temporaryId = randomUUID,
} = {}) {
  const temporary = temporaryPartPath(part, temporaryId());
  try {
    const command = remotionChunkCommand(resolvedRemotion, {
      composition,
      props,
      output: temporary,
      from,
      to,
    });
    run(command.command, command.args, { cwd: ROOT, stage: `chunk ${from}-${to}` });
    if (!fileSystem.existsSync(temporary) || fileSystem.statSync(temporary).size <= 1000) {
      throw new Error(`chunk ${from}-${to}: Remotion не создал полный MP4`);
    }
    fileSystem.renameSync(temporary, part);
    return part;
  } finally {
    if (fileSystem.existsSync(temporary)) fileSystem.unlinkSync(temporary);
  }
}

function main(args = process.argv.slice(2)) {
  const options = parseChunkOptions(args);
  const id = path.basename(options.output).replace(/\.mp4$/i, '');
  const directory = path.join(ROOT, 'out/.chunks');
  fs.mkdirSync(directory, { recursive: true });
  const resolvedRemotion = resolveRemotionCommand();
  const parts = [];
  let reused = 0;
  for (const { from, to } of chunkRanges(options.total, options.chunk)) {
    const part = path.join(directory, `${id}_${from}-${to}.mp4`);
    parts.push(part);
    if (fs.existsSync(part) && fs.statSync(part).size > 1000) {
      console.log(`· порция ${from}-${to}: уже есть, пропускаю (resume)`);
      reused++;
      continue;
    }
    console.log(`· рендер порции ${from}-${to} …`);
    renderChunkAtomically({
      resolvedRemotion,
      composition: options.composition,
      props: options.props,
      part,
      from,
      to,
    });
  }
  console.log(`порций: ${parts.length} (переиспользовано ${reused})`);

  const glued = path.join(directory, `${id}_v.mp4`);
  const concat = concatChunksCommand(parts, glued);
  runTool(concat.command, concat.args, { cwd: ROOT, stage: 'chunk concat' });
  if (options.audio && fs.existsSync(options.audio)) {
    const mux = muxAudioCommand(glued, options.audio, options.output);
    runTool(mux.command, mux.args, { cwd: ROOT, stage: 'chunk audio mux' });
    console.log(`✅ склеено с цельным аудио → ${options.output}`);
  } else {
    fs.copyFileSync(glued, options.output);
    console.log(`✅ склеено → ${options.output}`);
  }
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
  chunkRanges,
  concatChunksCommand,
  main,
  muxAudioCommand,
  parseChunkOptions,
  remotionChunkCommand,
  renderChunkAtomically,
};
