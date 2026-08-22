const { spawn } = require('node:child_process');

const DEFAULT_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;

function processError(code, message, properties = {}) {
  return Object.assign(new Error(message), { code, ...properties });
}

function runMediaProcess({
  command,
  args,
  cwd,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxStdoutBytes = DEFAULT_OUTPUT_BYTES,
  maxStderrBytes = DEFAULT_OUTPUT_BYTES,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  spawnImpl = spawn,
}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, {
        cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(processError('MEDIA_PROCESS_SPAWN', `cannot start ${command}`, { cause: error }));
      return;
    }

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let pendingError = null;
    let terminationSent = false;
    let escalationTimer = null;

    const terminate = (error) => {
      if (!pendingError) pendingError = error;
      if (!terminationSent) {
        terminationSent = true;
        child.kill('SIGTERM');
        const grace = Number.isFinite(terminationGraceMs) && terminationGraceMs >= 0
          ? terminationGraceMs
          : DEFAULT_TERMINATION_GRACE_MS;
        escalationTimer = setTimeout(() => child.kill('SIGKILL'), grace);
        escalationTimer.unref?.();
      }
    };
    const collect = (chunks, limit, streamName) => (chunk) => {
      const bytes = Buffer.from(chunk);
      const current = streamName === 'stdout' ? stdoutBytes : stderrBytes;
      const next = current + bytes.length;
      if (streamName === 'stdout') stdoutBytes = next;
      else stderrBytes = next;
      if (next > limit) {
        terminate(processError('MEDIA_PROCESS_OUTPUT_LIMIT', `${command} ${streamName} exceeded limit`));
        return;
      }
      chunks.push(bytes);
    };
    child.stdout?.on('data', collect(stdoutChunks, maxStdoutBytes, 'stdout'));
    child.stderr?.on('data', collect(stderrChunks, maxStderrBytes, 'stderr'));

    const onAbort = () => terminate(processError('MEDIA_PROCESS_ABORTED', `${command} aborted`));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    const timer = Number.isFinite(timeoutMs) && timeoutMs >= 0
      ? setTimeout(() => terminate(processError('MEDIA_PROCESS_TIMEOUT', `${command} timed out`)), timeoutMs)
      : null;
    timer?.unref?.();

    child.on('error', (error) => {
      if (!pendingError) {
        pendingError = processError('MEDIA_PROCESS_SPAWN', `cannot start ${command}`, { cause: error });
      }
    });
    child.once('close', (code, closeSignal) => {
      if (timer) clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      signal?.removeEventListener('abort', onAbort);
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (pendingError) {
        pendingError.stdout = stdout;
        pendingError.stderr = stderr;
        reject(pendingError);
        return;
      }
      if (code !== 0) {
        reject(processError('MEDIA_PROCESS_EXIT', `${command} exited with code ${code}`, {
          exitCode: code,
          processSignal: closeSignal,
          stdout,
          stderr,
        }));
        return;
      }
      resolve({ stdout, stderr, code, signal: closeSignal });
    });
  });
}

module.exports = { runMediaProcess };
