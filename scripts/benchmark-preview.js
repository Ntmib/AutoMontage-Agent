#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { remotionRenderCommand } = require('./build-commands');
const {
  ROOT,
  configureMediaToolPath,
  resolveRemotionCommand,
} = require('./env');
const { REMOTION_AUDIO_ADVANCE_MS } = require('./finish-audio');
const { captureToolResult, runNodeTool, runTool } = require('./process');

const DEFAULT_EQUIVALENCE_THRESHOLD = 0.965;

function roundedMilliseconds(value) {
  return Math.round(value);
}

function roundedRatio(value) {
  return Number(value.toFixed(3));
}

function benchmarkFixture(input, dependencies = {}) {
  const nowImpl = dependencies.nowImpl || (() => performance.now());
  const renderImpl = dependencies.renderImpl;
  if (!input || typeof input.fixture !== 'string' || !input.fixture) {
    throw new Error('benchmark fixture name is required');
  }
  if (typeof renderImpl !== 'function') throw new Error('benchmark render implementation is required');

  const measure = (kind, cycle) => {
    const started = nowImpl();
    const rendered = renderImpl(kind, cycle);
    const measured = rendered && Number.isFinite(rendered.renderMs)
      ? rendered.renderMs
      : nowImpl() - started;
    const output = rendered && typeof rendered === 'object' && 'output' in rendered
      ? rendered.output
      : rendered;
    return { elapsed: roundedMilliseconds(measured), output };
  };
  const cold = measure('preview', 'cold');
  const warm = measure('preview', 'warm');
  const final = measure('final', 'final');
  if (final.elapsed <= 0) throw new Error('final benchmark duration must be positive');
  return {
    fixture: input.fixture,
    previewColdMs: cold.elapsed,
    previewWarmMs: warm.elapsed,
    finalMs: final.elapsed,
    previewToFinalRatio: roundedRatio(warm.elapsed / final.elapsed),
  };
}

function applyTextOnlyBenchmarkChange(props) {
  const changed = structuredClone(props);
  const scene = changed.scenes?.find((candidate) => candidate && typeof candidate === 'object');
  if (!scene) throw new Error('benchmark fixture has no scene for a text-only change');
  const field = ['headOrange', 'headCream', 'caption', 'label', 'quoteOrange', 'quoteCream']
    .find((name) => typeof scene[name] === 'string' && scene[name].length > 0);
  if (!field) throw new Error('benchmark fixture has no editable scene text');
  scene[field] = `${scene[field]} · ПРАВКА`;
  return changed;
}

function watermarkMask(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error('equivalence geometry is invalid');
  }
  const maskWidth = Math.ceil(width * 0.30);
  const maskHeight = Math.ceil(height * 0.16);
  return { x: width - maskWidth, y: 0, width: maskWidth, height: maskHeight };
}

function buildFrameComparisonArgs({ previewPath, finalPath, atSec, width, height }) {
  if (!Number.isFinite(atSec) || atSec < 0) throw new Error('control frame time is invalid');
  const mask = watermarkMask(width, height);
  const drawbox = `drawbox=x=${mask.x}:y=${mask.y}:w=${mask.width}:h=${mask.height}:color=black:t=fill`;
  const filter = [
    `[0:v]scale=${width}:${height}:flags=lanczos,format=yuv444p,${drawbox}[preview]`,
    `[1:v]format=yuv444p,${drawbox}[final]`,
    '[preview][final]ssim',
  ].join(';');
  const time = String(atSec);
  return [
    '-v', 'info',
    '-ss', time, '-i', path.resolve(previewPath),
    '-ss', time, '-i', path.resolve(finalPath),
    '-filter_complex', filter,
    '-frames:v', '1',
    '-f', 'null', '-',
  ];
}

function parseSsimScore(output) {
  const matches = String(output || '').match(/\bAll:([0-9]+(?:\.[0-9]+)?)/g);
  if (!matches || !matches.length) throw new Error('ffmpeg did not report an SSIM score');
  const value = Number(matches.at(-1).slice(4));
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('ffmpeg reported an invalid SSIM score');
  }
  return value;
}

function verifyPreviewFinalEquivalence(input, dependencies = {}) {
  const captureToolResultImpl = dependencies.captureToolResultImpl || captureToolResult;
  const threshold = input.threshold ?? DEFAULT_EQUIVALENCE_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new Error('equivalence threshold must be between 0 and 1');
  }
  if (!Array.isArray(input.controlFramesSec) || !input.controlFramesSec.length) {
    throw new Error('at least one control frame is required');
  }
  const scores = input.controlFramesSec.map((atSec) => {
    const result = captureToolResultImpl('ffmpeg', buildFrameComparisonArgs({ ...input, atSec }), {
      cwd: ROOT,
      stage: `preview/final equivalence at ${atSec}s`,
      maxBuffer: 1024 * 1024,
    });
    const score = parseSsimScore(`${result.stdout || ''}\n${result.stderr || ''}`);
    if (score < threshold) {
      throw new Error(
        `preview/final frame at ${atSec}s scored ${score.toFixed(4)} below ${threshold.toFixed(4)}`,
      );
    }
    return score;
  });
  return { scores, minimumScore: Math.min(...scores), threshold };
}

function parseFixture(value) {
  const [fixture, propsPath, publicDirectory] = String(value || '').split('::');
  if (!fixture || !propsPath || !publicDirectory) {
    throw new Error('--fixture requires NAME::PROPS_JSON::PUBLIC_DIR');
  }
  return {
    fixture,
    propsPath: path.resolve(propsPath),
    publicDirectory: path.resolve(publicDirectory),
  };
}

function parseOptions(argv) {
  const options = { fixtures: [], output: null, threshold: DEFAULT_EQUIVALENCE_THRESHOLD };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--fixture') {
      options.fixtures.push(parseFixture(value));
    } else if (argument === '--output') {
      options.output = path.resolve(value || '');
    } else if (argument === '--threshold') {
      options.threshold = Number(value);
    } else {
      throw new Error(`unknown benchmark option: ${argument}`);
    }
    index += 1;
  }
  if (options.fixtures.length !== 2) {
    throw new Error('benchmark requires exactly two --fixture values (horizontal and vertical)');
  }
  if (!Number.isFinite(options.threshold) || options.threshold <= 0 || options.threshold > 1) {
    throw new Error('benchmark threshold must be between 0 and 1');
  }
  return options;
}

function benchmarkRenderCycle(input, dependencies = {}) {
  const runToolImpl = dependencies.runToolImpl || runTool;
  const runNodeToolImpl = dependencies.runNodeToolImpl || runNodeTool;
  const resolved = dependencies.resolvedRemotion || resolveRemotionCommand(ROOT);
  const nowImpl = dependencies.nowImpl || (() => performance.now());
  const rawOutput = path.join(input.workDirectory, `${input.kind}-${input.cycle}.raw.mp4`);
  const output = path.join(input.workDirectory, `${input.kind}-${input.cycle}.mp4`);
  const command = remotionRenderCommand(resolved, {
    entry: 'src/index.js',
    composition: 'ReelScenes',
    output: rawOutput,
    props: input.propsPath,
    publicDir: input.publicDirectory,
    scale: input.kind === 'preview' ? 0.5 : null,
    crf: input.kind === 'preview' ? 28 : null,
    concurrency: input.kind === 'preview' ? '50%' : null,
    overwrite: true,
  });
  const renderStarted = nowImpl();
  runToolImpl(command.command, command.args, {
    cwd: ROOT,
    stage: `${input.fixture} ${input.kind} Remotion`,
  });
  const renderMs = roundedMilliseconds(nowImpl() - renderStarted);
  runNodeToolImpl(path.join(ROOT, 'scripts', 'finish.js'), [
    rawOutput,
    output,
    '--hdrfix', 'auto',
    '--audio-advance-ms', String(REMOTION_AUDIO_ADVANCE_MS),
  ], { cwd: ROOT, stage: `${input.fixture} ${input.kind} finish` });
  return { output, renderMs };
}

function benchmarkRealFixture(fixture, options = {}, dependencies = {}) {
  const fileSystem = dependencies.fileSystem || fs;
  const runToolImpl = dependencies.runToolImpl || runTool;
  const runNodeToolImpl = dependencies.runNodeToolImpl || runNodeTool;
  const resolveRemotionCommandImpl = dependencies.resolveRemotionCommandImpl
    || resolveRemotionCommand;
  const props = JSON.parse(fileSystem.readFileSync(fixture.propsPath, 'utf8'));
  if (props.draftPreview !== true) throw new Error(`${fixture.fixture}: props must be draft preview`);
  const work = fileSystem.mkdtempSync(path.join(os.tmpdir(), 'automontage-preview-benchmark-'));
  try {
    const previewColdProps = path.join(work, 'preview-cold.props.json');
    const previewWarmProps = path.join(work, 'preview-warm.props.json');
    const finalProps = path.join(work, 'final.props.json');
    const changedProps = applyTextOnlyBenchmarkChange(props);
    fileSystem.writeFileSync(previewColdProps, `${JSON.stringify(props)}\n`);
    fileSystem.writeFileSync(previewWarmProps, `${JSON.stringify(changedProps)}\n`);
    fileSystem.writeFileSync(finalProps, `${JSON.stringify({ ...changedProps, draftPreview: false })}\n`);
    const outputs = {};
    const resolved = resolveRemotionCommandImpl(ROOT);
    const result = benchmarkFixture(fixture, {
      renderImpl: (kind, cycle) => {
        const cycleResult = benchmarkRenderCycle({
          ...fixture,
          kind,
          cycle,
          propsPath: kind === 'preview'
            ? (cycle === 'cold' ? previewColdProps : previewWarmProps)
            : finalProps,
          workDirectory: work,
        }, { resolvedRemotion: resolved, runToolImpl, runNodeToolImpl });
        outputs[`${kind}-${cycle}`] = cycleResult.output;
        return cycleResult;
      },
    });
    const durationSec = props.durationInFrames / props.fps;
    const controlFramesSec = [
      Math.min(1, durationSec / 4),
      durationSec / 2,
      Math.max(0, durationSec - 1),
    ];
    const equivalence = verifyPreviewFinalEquivalence({
      previewPath: outputs['preview-warm'],
      finalPath: outputs['final-final'],
      width: props.width,
      height: props.height,
      controlFramesSec,
      threshold: options.threshold,
    });
    return { ...result, equivalence };
  } finally {
    fileSystem.rmSync(work, { recursive: true, force: true });
  }
}

function main(argv = process.argv.slice(2)) {
  try {
    configureMediaToolPath();
    const options = parseOptions(argv);
    const results = options.fixtures.map((fixture) => benchmarkRealFixture(fixture, options));
    const json = `${JSON.stringify(results, null, 2)}\n`;
    if (options.output) fs.writeFileSync(options.output, json, { flag: 'wx', mode: 0o600 });
    process.stdout.write(json);
  } catch (error) {
    console.error(`❌ benchmark отменён: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  DEFAULT_EQUIVALENCE_THRESHOLD,
  applyTextOnlyBenchmarkChange,
  benchmarkFixture,
  benchmarkRealFixture,
  benchmarkRenderCycle,
  buildFrameComparisonArgs,
  parseOptions,
  parseSsimScore,
  verifyPreviewFinalEquivalence,
  watermarkMask,
};
