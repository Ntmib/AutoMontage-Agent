// Загрузчик ВНЕШНИХ тем (бренд-паков) через переменную окружения THEMES_EXT.
//
// Зачем: фирменный стиль (палитра, шрифты, декор) может лежать ВНЕ этого
// открытого репозитория – в приватной папке/репо. Движок подхватывает его по id,
// не таща сам стиль в open-source. См. docs/TEMPLATES.md, «Свой приватный бренд-пак».
//
// Как работает: THEMES_EXT указывает на папку с темами вида <theme-id>/theme.json.
// Если пользователь передал `--theme <id>`, которого нет среди встроенных, и во
// внешней папке лежит <id>/theme.json – читаем его и возвращаем объектом-темой.
// getTheme() в src/theme/index.js принимает тему объектом, поэтому этого достаточно.
const fs = require('fs');
const path = require('path');

// Встроенные темы репозитория – их грузить снаружи не нужно.
const BUILTIN = new Set(['craft', 'cyber', 'lesson-neutral']);

function themeLabel(id) {
  return JSON.stringify(String(id));
}

// Пытается загрузить внешнюю тему по id. Для встроенной темы возвращает null.
// Любой другой явный id обязан разрешиться во внешнюю тему, иначе рендер останавливается.
function loadExtTheme(id) {
  if (typeof id !== 'string') return null;            // уже объект или пусто – не наше дело
  if (BUILTIN.has(id)) return null;                   // встроенная тема
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
    throw new Error(`недопустимый id внешней темы ${themeLabel(id)}`);
  }

  const ext = process.env.THEMES_EXT;
  if (!ext) {
    throw new Error(
      `внешняя тема ${themeLabel(id)} недоступна: задай THEMES_EXT (встроенные: ${[...BUILTIN].join(', ')})`,
    );
  }

  const file = path.join(ext, id, 'theme.json');
  // защита от path-traversal: итоговый путь обязан лежать ВНУТРИ ext
  if (!path.resolve(file).startsWith(path.resolve(ext) + path.sep)) {
    throw new Error(`недопустимый id внешней темы ${themeLabel(id)}`);
  }
  if (!fs.existsSync(file)) {
    throw new Error(`внешняя тема ${themeLabel(id)} не найдена в THEMES_EXT`);
  }

  let theme;
  try {
    theme = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`внешняя тема ${themeLabel(id)}: битый JSON: ${e.message}`);
  }
  if (!theme || !theme.colors) {
    throw new Error(`внешняя тема ${themeLabel(id)} без обязательного блока colors`);
  }
  return theme;
}

module.exports = { loadExtTheme, BUILTIN };
