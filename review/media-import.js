function importError(status, code) {
  const error = new Error(code);
  error.name = 'MediaImportError';
  error.status = status;
  error.code = code;
  return error;
}

function invoke(callback, value) {
  return typeof callback === 'function' ? callback(value) : undefined;
}

function notify(callback, value) {
  try {
    return invoke(callback, value);
  } catch (_) {
    return undefined;
  }
}

function uploadMimeType(file) {
  if (typeof file?.name === 'string' && file.name.toLowerCase().endsWith('.m4v')) {
    return 'video/x-m4v';
  }
  return file.type || 'application/octet-stream';
}

export function createMediaImporter({
  endpoint,
  token,
  origin,
  onPhase,
  onProgress,
  onSuccess,
  onError,
}) {
  const endpointUrl = new URL(endpoint, origin);
  if (endpointUrl.origin !== origin || typeof token !== 'string' || token.length === 0) {
    throw new TypeError('media importer configuration is invalid');
  }

  let active = false;
  let request = null;

  async function finishSuccess(value, resolve, reject) {
    try {
      await invoke(onSuccess, value);
      resolve(value);
    } catch (_) {
      const error = importError(201, 'MEDIA_IMPORT_COMMITTED_REFRESH_ERROR');
      error.committed = true;
      reject(error);
    } finally {
      active = false;
      request = null;
    }
  }

  async function finishError(error, reject) {
    try {
      await Promise.resolve(notify(onError, error)).catch(() => {});
    } finally {
      active = false;
      request = null;
      reject(error);
    }
  }

  function importFile(file) {
    if (active) return Promise.reject(importError(409, 'MEDIA_IMPORT_BUSY'));
    if (!(file instanceof File) || file.size <= 0) {
      return Promise.reject(importError(400, 'MEDIA_IMPORT_FILE_INVALID'));
    }
    active = true;
    notify(onPhase, { phase: 'uploading', file });

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let completed = false;
      const fail = (error) => {
        if (completed) return;
        completed = true;
        void finishError(error, reject);
      };
      request = xhr;
      xhr.open('POST', endpointUrl.pathname + endpointUrl.search);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('X-Automontage-Filename', encodeURIComponent(file.name));
      xhr.setRequestHeader('Content-Type', uploadMimeType(file));
      xhr.upload.onprogress = ({ loaded, total, lengthComputable }) => {
        notify(onProgress, {
          loaded,
          total: lengthComputable ? total : file.size,
        });
      };
      xhr.upload.onload = () => notify(onPhase, { phase: 'processing', file });
      xhr.onload = () => {
        if (completed) return;
        if (xhr.status !== 201) {
          fail(importError(xhr.status, `MEDIA_IMPORT_HTTP_${xhr.status}`));
          return;
        }
        let body;
        try {
          body = JSON.parse(xhr.responseText);
        } catch (_) {
          fail(importError(500, 'MEDIA_IMPORT_RESPONSE_INVALID'));
          return;
        }
        if (!body || body.ok !== true || !body.asset) {
          fail(importError(500, 'MEDIA_IMPORT_RESPONSE_INVALID'));
          return;
        }
        completed = true;
        void finishSuccess(body.asset, resolve, reject);
      };
      xhr.onerror = () => fail(importError(0, 'MEDIA_IMPORT_NETWORK_ERROR'));
      xhr.onabort = () => fail(importError(0, 'MEDIA_IMPORT_ABORTED'));
      try {
        xhr.send(file);
      } catch (_) {
        fail(importError(0, 'MEDIA_IMPORT_NETWORK_ERROR'));
      }
    });
  }

  return {
    importFile,
    abort() {
      if (active && request) request.abort();
    },
    busy() {
      return active;
    },
  };
}
