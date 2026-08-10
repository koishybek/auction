/**
 * Генератор ERD из schema.prisma в docs/ERD.md (Mermaid + таблицы полей).
 *
 * Пишется скриптом, а не руками: диаграмма, которую обновляют вручную, расходится
 * со схемой на второй же миграции и начинает врать. Запуск: pnpm db:erd
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

interface Field {
  readonly name: string;
  readonly type: string;
  readonly optional: boolean;
  readonly isList: boolean;
  readonly attributes: string;
  readonly doc: string;
}

interface Model {
  readonly name: string;
  readonly table: string;
  readonly fields: readonly Field[];
  readonly blockAttributes: readonly string[];
  readonly doc: string;
}

interface EnumDef {
  readonly name: string;
  readonly values: readonly string[];
}

function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/** Убираем комментарии, чтобы `//` внутри них не ломал разбор. */
function stripComments(line: string): { code: string; doc: string } {
  const docMatch = /^\s*\/\/\/\s?(.*)$/.exec(line);
  if (docMatch) return { code: '', doc: docMatch[1] ?? '' };
  const idx = line.indexOf('//');
  return { code: idx === -1 ? line : line.slice(0, idx), doc: '' };
}

function parseEnums(source: string): EnumDef[] {
  const enums: EnumDef[] = [];
  const re = /^enum\s+(\w+)\s*\{([^}]*)\}/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const name = match[1] ?? '';
    const values = (match[2] ?? '')
      .split('\n')
      .map((line) => stripComments(line).code.trim())
      .filter((line) => line !== '');
    enums.push({ name, values });
  }
  return enums;
}

function parseModels(source: string): Model[] {
  const models: Model[] = [];
  const re = /(?:^\/\/\/\s?(.*)\n)?^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let match: RegExpExecArray | null;

  while ((match = re.exec(source)) !== null) {
    const doc = match[1] ?? '';
    const name = match[2] ?? '';
    const body = match[3] ?? '';

    const fields: Field[] = [];
    const blockAttributes: string[] = [];
    let table = name;
    let pendingDoc = '';

    for (const rawLine of body.split('\n')) {
      const { code, doc: lineDoc } = stripComments(rawLine);
      if (lineDoc !== '') {
        pendingDoc = lineDoc;
        continue;
      }
      const line = code.trim();
      if (line === '') continue;

      if (line.startsWith('@@')) {
        const mapMatch = /^@@map\("([^"]+)"\)/.exec(line);
        if (mapMatch?.[1] !== undefined) {
          table = mapMatch[1];
        } else {
          blockAttributes.push(line);
        }
        continue;
      }

      const fieldMatch = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(line);
      if (fieldMatch) {
        fields.push({
          name: fieldMatch[1] ?? '',
          type: fieldMatch[2] ?? '',
          isList: fieldMatch[3] === '[]',
          optional: fieldMatch[4] === '?',
          attributes: (fieldMatch[5] ?? '').trim(),
          doc: pendingDoc,
        });
        pendingDoc = '';
      }
    }

    models.push({ name, table, fields, blockAttributes, doc });
  }

  return models;
}

function isScalar(type: string, modelNames: ReadonlySet<string>): boolean {
  return !modelNames.has(type);
}

function mermaid(models: readonly Model[]): string {
  const modelNames = new Set(models.map((m) => m.name));
  const lines: string[] = ['erDiagram'];

  for (const model of models) {
    lines.push(`  ${model.table} {`);
    for (const field of model.fields) {
      if (!isScalar(field.type, modelNames)) continue;
      const dbName = /@map\("([^"]+)"\)/.exec(field.attributes)?.[1] ?? field.name;
      const isPk = field.attributes.includes('@id');
      const isUnique = field.attributes.includes('@unique');
      const key = isPk ? ' PK' : isUnique ? ' UK' : '';
      const type = `${field.type}${field.isList ? '_list' : ''}${field.optional ? '_nullable' : ''}`;
      lines.push(`    ${type} ${dbName}${key}`);
    }
    lines.push('  }');
  }

  // Связи рисуем по полям с @relation(fields: [...]): именно они несут внешний ключ.
  const drawn = new Set<string>();
  for (const model of models) {
    for (const field of model.fields) {
      if (isScalar(field.type, modelNames)) continue;
      if (!field.attributes.includes('@relation') || !field.attributes.includes('fields:'))
        continue;

      const target = models.find((m) => m.name === field.type);
      if (!target) continue;

      const cardinality = field.optional ? '}o--||' : '}|--||';
      const edge = `  ${model.table} ${cardinality} ${target.table} : "${field.name}"`;
      if (!drawn.has(edge)) {
        drawn.add(edge);
        lines.push(edge);
      }
    }
  }

  return lines.join('\n');
}

function fieldTables(models: readonly Model[]): string {
  const modelNames = new Set(models.map((m) => m.name));
  const out: string[] = [];

  for (const model of models) {
    out.push(`### \`${model.table}\``);
    out.push('');
    if (model.doc !== '') {
      out.push(model.doc);
      out.push('');
    }
    out.push('| Колонка | Тип | Null | Комментарий |');
    out.push('| --- | --- | --- | --- |');

    for (const field of model.fields) {
      if (!isScalar(field.type, modelNames)) continue;
      const dbName = /@map\("([^"]+)"\)/.exec(field.attributes)?.[1] ?? field.name;
      const marks: string[] = [];
      if (field.attributes.includes('@id')) marks.push('PK');
      if (field.attributes.includes('@unique')) marks.push('UNIQUE');
      const type = `${field.type}${field.isList ? '[]' : ''}${marks.length > 0 ? ` (${marks.join(', ')})` : ''}`;
      out.push(`| \`${dbName}\` | ${type} | ${field.optional ? 'да' : 'нет'} | ${field.doc} |`);
    }
    out.push('');

    if (model.blockAttributes.length > 0) {
      out.push('Индексы и ограничения:');
      out.push('');
      for (const attribute of model.blockAttributes) {
        out.push(`- \`${attribute}\``);
      }
      out.push('');
    }
  }

  return out.join('\n');
}

function main(): void {
  const root = findRepoRoot(process.cwd());
  const schemaPath = resolve(root, 'apps/api/prisma/schema.prisma');
  const outPath = resolve(root, 'docs/ERD.md');

  const source = readFileSync(schemaPath, 'utf8');
  const models = parseModels(source);
  const enums = parseEnums(source);

  if (models.length === 0) {
    throw new Error(`Не разобрано ни одной модели из ${schemaPath}`);
  }

  const doc = [
    '# ERD — схема БД',
    '',
    '> Файл сгенерирован из `apps/api/prisma/schema.prisma` командой `pnpm db:erd`.',
    '> Руками не править: правки затрутся при следующей генерации.',
    '',
    `Моделей: ${String(models.length)}, перечислений: ${String(enums.length)}.`,
    '',
    'Деньги везде в **целых тиынах** (`BigInt` → `BIGINT`), суффикс `_tiyn`.',
    'ПДн — только в зашифрованных колонках `*_enc`.',
    '',
    '## Диаграмма',
    '',
    '```mermaid',
    mermaid(models),
    '```',
    '',
    '## Перечисления',
    '',
    ...enums.map((e) => `- **${e.name}**: ${e.values.map((v) => `\`${v}\``).join(', ')}`),
    '',
    '## Таблицы',
    '',
    fieldTables(models),
  ].join('\n');

  writeFileSync(outPath, doc, 'utf8');
  console.log(
    `ERD записан: ${outPath} (${String(models.length)} моделей, ${String(enums.length)} перечислений)`,
  );
}

main();
