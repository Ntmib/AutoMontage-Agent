#!/usr/bin/env node
// Фаза 2.1 — валидация монтажного листа против JSON-схемы ДО рендера.
//   node validate.js <лист.json>   ИЛИ   require('./validate').validate(obj)
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../schema/scenario.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
const validator = ajv.compile(schema);

function validate(obj) {
  const ok = validator(obj);
  const errors = [];
  if (!ok) {
    for (const e of validator.errors) errors.push(`${e.instancePath || '(корень)'} ${e.message}${e.params && e.params.allowedValues ? ' [' + e.params.allowedValues.join(', ') + ']' : ''}`);
  }
  // доп. смысловые проверки
  (obj.blocks || []).forEach((b, i) => {
    if (b.end != null && b.end <= b.start) errors.push(`blocks[${i}] (${b.type}): end (${b.end}) ≤ start (${b.start})`);
  });
  return { ok: errors.length === 0, errors };
}

module.exports = { validate };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.error('укажи файл листа'); process.exit(1); }
  const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { ok, errors } = validate(obj);
  if (ok) { console.log('✅ монтажный лист валиден'); process.exit(0); }
  console.error('❌ ошибки в монтажном листе:');
  errors.forEach((e) => console.error('  · ' + e));
  process.exit(1);
}
