#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const { startReviewServer } = require('./server');

const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

function parseReviewOptions(argv) {
  if (!Array.isArray(argv)) throw new Error('review arguments are invalid');
  const options = {
    projectDir: null,
    editable: false,
    open: true,
    port: 0,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--edit' || argument === '--no-open') {
      if (seen.has(argument)) throw new Error('duplicate review option');
      seen.add(argument);
      if (argument === '--edit') options.editable = true;
      else options.open = false;
      continue;
    }
    if (argument === '--project-dir' || argument === '--port') {
      if (seen.has(argument)) throw new Error('duplicate review option');
      seen.add(argument);
      const value = argv[index + 1];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === '--project-dir') options.projectDir = path.resolve(value);
      else {
        const port = Number(value);
        if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 0 || port > 65535) {
          throw new Error('port must be an integer from 0 to 65535');
        }
        options.port = port;
      }
      continue;
    }
    throw new Error('unknown review option');
  }

  if (!options.projectDir) throw new Error('--project-dir is required');
  let stat;
  try {
    stat = fs.statSync(options.projectDir);
  } catch (_) {
    throw new Error('--project-dir must be an existing directory');
  }
  if (!stat.isDirectory()) throw new Error('--project-dir must be an existing directory');
  return options;
}

async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseReviewOptions(argv);
    const session = await startReviewServer(options);
    installReviewShutdownHandlers({
      server: session.server,
      abortActiveImport: session.abortActiveImports,
    });
    for (const message of formatReviewSessionMessages({ session, editable: options.editable })) {
      console.log(message);
    }
  } catch (_) {
    console.error('Review server failed to start. Check --project-dir and options.');
    process.exitCode = 1;
  }
}

function installReviewShutdownHandlers({
  server,
  processLike = process,
  abortActiveImport = () => {},
} = {}) {
  if (!server || typeof server.close !== 'function'
    || !processLike || typeof processLike.on !== 'function'
    || typeof processLike.removeListener !== 'function'
    || typeof processLike.exit !== 'function'
    || typeof abortActiveImport !== 'function') {
    throw new Error('review shutdown handler requires a server and process');
  }
  let installed = true;
  let shuttingDown = false;
  const handlers = {};
  const restore = () => {
    if (!installed) return;
    installed = false;
    for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
      processLike.removeListener(signal, handlers[signal]);
    }
    server.removeListener('close', restore);
  };
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { abortActiveImport(); } catch (_) { /* shutdown must still close the server */ }
    const finish = () => {
      restore();
      processLike.exit(SIGNAL_EXIT_CODES[signal]);
    };
    if (!server.listening) {
      finish();
      return;
    }
    try {
      server.close(finish);
    } catch (_) {
      finish();
    }
  };
  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
    handlers[signal] = () => shutdown(signal);
    processLike.on(signal, handlers[signal]);
  }
  server.once('close', restore);
  return restore;
}

function formatReviewSessionMessages({ session, editable }) {
  const messages = [`Review server: ${session.origin}`];
  if (session.handoffPath) messages.push(`Secure session URL file: ${session.handoffPath}`);
  messages.push(editable ? 'Mode: edit-enabled session' : 'Mode: read-only');
  return messages;
}

if (require.main === module) main();

module.exports = {
  formatReviewSessionMessages,
  installReviewShutdownHandlers,
  main,
  parseReviewOptions,
};
