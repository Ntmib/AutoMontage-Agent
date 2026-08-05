const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sanitizeNamespace(namespace) {
  const value = String(namespace ?? 'dynamic').normalize('NFKC');
  const sanitized = value
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return sanitized || 'dynamic';
}

function safeTemporaryId(temporaryId) {
  const value = String(temporaryId ?? randomUUID()).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error('public media: temporaryId должен быть UUID');
  }
  return value;
}

function directoryWithoutSymlink(directory, { create = false } = {}) {
  if (!fs.existsSync(directory)) {
    if (!create) return false;
    fs.mkdirSync(directory);
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`public media: небезопасный каталог ${directory}`);
  }
  return true;
}

function preparePublicMedia({
  root,
  sourcePath,
  namespace = 'dynamic',
  temporaryId = randomUUID(),
}) {
  const resolvedRoot = path.resolve(root);
  const source = path.resolve(sourcePath);
  const sourceStat = fs.statSync(source);
  if (!sourceStat.isFile()) throw new Error('public media: sourcePath должен быть файлом');

  const publicDirectory = path.join(resolvedRoot, 'public');
  directoryWithoutSymlink(publicDirectory);
  const leaseBase = path.join(publicDirectory, '.automontage');
  directoryWithoutSymlink(leaseBase, { create: true });

  const id = safeTemporaryId(temporaryId);
  const directoryName = `${sanitizeNamespace(namespace)}-${id}`;
  const leaseDirectory = path.join(leaseBase, directoryName);
  const extension = path.extname(source);
  const absolutePath = path.join(leaseDirectory, `source${extension}`);
  const publicPath = path.posix.join('.automontage', directoryName, `source${extension}`);

  fs.mkdirSync(leaseDirectory);
  try {
    fs.copyFileSync(source, absolutePath);
  } catch (error) {
    fs.rmSync(leaseDirectory, { recursive: true, force: true });
    throw error;
  }

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    const resolvedBase = path.resolve(leaseBase);
    const resolvedLease = path.resolve(leaseDirectory);
    if (path.dirname(resolvedLease) !== resolvedBase
      || path.basename(resolvedLease) !== directoryName) {
      throw new Error('public media: lease cleanup отказался удалять путь вне своего base');
    }
    let leaseStat;
    try {
      leaseStat = fs.lstatSync(leaseDirectory);
    } catch (error) {
      if (error.code === 'ENOENT') {
        cleaned = true;
        return;
      }
      throw error;
    }

    if (!leaseStat.isDirectory() || leaseStat.isSymbolicLink()) {
      throw new Error('public media: lease cleanup отказался удалять небезопасный путь');
    }
    directoryWithoutSymlink(publicDirectory);
    directoryWithoutSymlink(leaseBase);
    fs.rmSync(leaseDirectory, { recursive: true, force: false });
    cleaned = true;
  }

  return { publicPath, absolutePath, cleanup };
}

function withPublicMediaLease(options, operation) {
  if (typeof operation !== 'function') throw new TypeError('public media: operation должна быть функцией');
  const lease = preparePublicMedia(options);
  let operationError = null;
  let operationFailed = false;
  try {
    return operation(lease);
  } catch (error) {
    operationError = error;
    operationFailed = true;
    throw error;
  } finally {
    try {
      lease.cleanup();
    } catch (cleanupError) {
      if (!operationFailed) throw cleanupError;
      if (operationError && (typeof operationError === 'object' || typeof operationError === 'function')) {
        Object.defineProperty(operationError, 'cleanupError', { value: cleanupError });
      }
    }
  }
}

module.exports = {
  preparePublicMedia,
  sanitizeNamespace,
  withPublicMediaLease,
};
