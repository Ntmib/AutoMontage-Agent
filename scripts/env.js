// Кросс-платформенные помощники (Windows / macOS / Linux).
// Убирает жёсткие /tmp и python3 – движок ставится и работает на любой ОС.
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// Временная папка ОС (/tmp на Unix, %TEMP% на Windows) + путь под наш файл.
const TMPDIR = os.tmpdir();
function tmp(name) {
  return path.join(TMPDIR, name);
}

// Автоопределение интерпретатора Python 3.
// Windows: обычно `python`. macOS/Linux: обычно `python3`. Берём тот, что реально Python 3.
let _py = null;
function pythonCandidates(root = ROOT, platform = process.platform) {
  const localPython = platform === 'win32'
    ? path.join(root, '.venv', 'Scripts', 'python.exe')
    : path.join(root, '.venv', 'bin', 'python');
  return platform === 'win32'
    ? [localPython, 'python', 'python3', 'py']
    : [localPython, 'python3', 'python'];
}

function python() {
  if (_py) return _py;
  const candidates = pythonCandidates();
  for (const cmd of candidates) {
    try {
      const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      if (r.status === 0 && /Python 3\./.test(out)) { _py = cmd; return _py; }
    } catch (_) { /* пробуем следующий */ }
  }
  throw new Error('Python 3 не найден. Установи Python 3 и добавь его в PATH '
    + '(Windows: python.org или "winget install Python.Python.3"; macOS: "brew install python").');
}

// Запуск локального Remotion CLI кросс-платформенно, без попытки что-либо скачивать.
// Резолвим бинарь из node_modules пакета (на Windows это .cmd, execSync это учитывает).
function resolveRemotionCommand(root = ROOT, platform = process.platform) {
  const bin = path.join(root, 'node_modules', '.bin',
    platform === 'win32' ? 'remotion.cmd' : 'remotion');
  return fs.existsSync(bin)
    ? { command: bin, argsPrefix: [] }
    : { command: 'npx', argsPrefix: ['--no-install', 'remotion'] };
}

function remotionBin() {
  const resolved = resolveRemotionCommand();
  return resolved.argsPrefix.length
    ? [resolved.command, ...resolved.argsPrefix].join(' ')
    : `"${resolved.command}"`;
}

module.exports = {
  ROOT,
  TMPDIR,
  tmp,
  python,
  pythonCandidates,
  remotionBin,
  resolveRemotionCommand,
  execSync,
};
