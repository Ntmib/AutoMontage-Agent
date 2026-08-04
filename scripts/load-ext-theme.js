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

// Пытается загрузить внешнюю тему по id. Возвращает объект-тему или null.
// null означает «внешней темы нет» – вызывающий код оставляет строковый id как есть.
function loadExtTheme(id) {
  if (typeof id !== 'string') return null;            // уже объект или пусто – не наше дело
  if (BUILTIN.has(id)) return null;                   // встроенная тема
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) return null; // невалидный id (защита от ../, слэшей и т.п.)

  const ext = process.env.THEMES_EXT;
  if (!ext) return null;                              // путь к бренд-паку не задан

  const file = path.join(ext, id, 'theme.json');
  // защита от path-traversal: итоговый путь обязан лежать ВНУТРИ ext
  if (!path.resolve(file).startsWith(path.resolve(ext) + path.sep)) return null;
  if (!fs.existsSync(file)) return null;

  let theme;
  try {
    theme = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`внешняя тема "${id}" (${file}): битый JSON: ${e.message}`);
  }
  if (!theme || !theme.colors) {
    throw new Error(`внешняя тема "${id}" (${file}) без обязательного блока colors`);
  }
  return theme;
}

module.exports = { loadExtTheme, BUILTIN };
