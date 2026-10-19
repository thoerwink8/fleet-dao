// 仅支持本仓当前 PG7 迁移数据；未知结构不获快照折扣。不加载候选 schema/config。
import { generateMigration } from 'drizzle-kit/api';
import { parseDocument } from 'yaml';
import { z } from 'zod';

const Journal = z
  .object({
    version: z.literal('7'),
    dialect: z.literal('postgresql'),
    entries: z.array(
      z
        .object({
          idx: z.number().int().nonnegative(),
          version: z.literal('7'),
          when: z.number().int().positive(),
          tag: z.string().regex(/^\d{4}_[a-zA-Z0-9_]+$/),
          breakpoints: z.literal(true),
        })
        .strict(),
    ),
  })
  .strict();
export interface MigrationBudgetData {
  baseJournal: string;
  headJournal: string;
  baseSnapshot: string;
  headSnapshot: string;
  sql: string;
  snapshotPath: string;
  sqlPath: string;
}

const fields: Record<string, string> = {
  $: 'id prevId version dialect tables enums schemas sequences roles policies views _meta',
  '$.tables.*':
    'name schema columns indexes foreignKeys compositePrimaryKeys uniqueConstraints policies checkConstraints isRLSEnabled',
  '$.tables.*.columns.*': 'name type typeSchema primaryKey notNull default identity',
  '$.tables.*.columns.*.identity': 'type name schema increment startWith minValue maxValue cache cycle',
  '$.tables.*.indexes.*': 'name columns isUnique with method where concurrently',
  '$.tables.*.indexes.*.columns.*': 'expression isExpression asc nulls opclass',
  '$.tables.*.foreignKeys.*': 'name tableFrom tableTo columnsFrom columnsTo schemaTo onDelete onUpdate',
  '$.tables.*.compositePrimaryKeys.*': 'name columns',
  '$.tables.*.uniqueConstraints.*': 'name columns nullsNotDistinct',
  '$.tables.*.checkConstraints.*': 'name value',
  '$.enums.*': 'name schema values',
  '$._meta': 'columns tables schemas',
};
const dictionaries = new Set([
  '$.tables',
  '$.enums',
  '$.tables.*.columns',
  '$.tables.*.indexes',
  '$.tables.*.foreignKeys',
  '$.tables.*.compositePrimaryKeys',
  '$.tables.*.uniqueConstraints',
  '$.tables.*.checkConstraints',
]);
const emptyOnly = new Set([
  '$.schemas',
  '$.sequences',
  '$.roles',
  '$.policies',
  '$.views',
  '$._meta.columns',
  '$._meta.tables',
  '$._meta.schemas',
  '$.tables.*.policies',
  '$.tables.*.indexes.*.with',
]);
const arrays = new Set([
  '$.tables.*.indexes.*.columns',
  '$.tables.*.foreignKeys.*.columnsFrom',
  '$.tables.*.foreignKeys.*.columnsTo',
  '$.tables.*.compositePrimaryKeys.*.columns',
  '$.tables.*.uniqueConstraints.*.columns',
  '$.enums.*.values',
]);
function checkFields(value: unknown, at = '$', depth = 0): void {
  if (depth > 20) throw new Error('JSON 层级超过已支持结构');
  if (Array.isArray(value)) {
    if (!arrays.has(at)) throw new Error(`未支持的数组：${at}`);
    for (const item of value) checkFields(item, `${at}.*`, depth + 1);
  } else if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (emptyOnly.has(at)) {
      if (entries.length) throw new Error(`未支持的非空结构：${at}`);
    } else if (dictionaries.has(at)) {
      for (const [, item] of entries) checkFields(item, `${at}.*`, depth + 1);
    } else {
      const allowed = fields[at]?.split(' ');
      if (!allowed) throw new Error(`未支持的对象：${at}`);
      if ((at === '$' || at === '$._meta' || at === '$.tables.*') && entries.length < allowed.length) {
        throw new Error(`完整结构缺字段：${at}`);
      }
      for (const [key, item] of entries) {
        if (!allowed.includes(key)) throw new Error(`未知字段：${at}.${key}`);
        checkFields(item, `${at}.${key}`, depth + 1);
      }
    }
  }
}
/** JSON.parse 先约束语言；现有 YAML parser 只检测重复键，包括转义后相同的键。 */
function readJson(text: string): unknown {
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('单份迁移数据超过 1MiB');
  const data: unknown = JSON.parse(text);
  const doc = parseDocument(text, { strict: true, uniqueKeys: true });
  if (doc.errors.length) throw new Error(`JSON 结构不明确：${doc.errors.map((e) => e.code).join(',')}`);
  return data;
}
export function migrationPaths(
  baseText: string,
  headText: string,
): {
  baseSnapshotPath: string;
  snapshotPath: string;
  sqlPath: string;
} {
  const before = Journal.parse(readJson(baseText)),
    after = Journal.parse(readJson(headText));
  if (after.entries.length !== before.entries.length + 1 || !before.entries.length) {
    throw new Error('journal 必须只追加一项');
  }
  for (const [index, entry] of before.entries.entries()) {
    if (entry.idx !== index || JSON.stringify(entry) !== JSON.stringify(after.entries[index])) {
      throw new Error('journal 既有项或编号变化');
    }
  }
  const next = after.entries.at(-1),
    prev = before.entries.at(-1);
  if (
    !next ||
    !prev ||
    next.idx !== prev.idx + 1 ||
    next.tag.slice(0, 4) !== String(next.idx).padStart(4, '0')
  ) {
    throw new Error('journal 新项编号和 tag 不符');
  }
  return {
    baseSnapshotPath: `packages/db/migrations/meta/${String(prev.idx).padStart(4, '0')}_snapshot.json`,
    snapshotPath: `packages/db/migrations/meta/${String(next.idx).padStart(4, '0')}_snapshot.json`,
    sqlPath: `packages/db/migrations/${next.tag}.sql`,
  };
}

export async function verifyMigrationData(data: MigrationBudgetData): Promise<void> {
  const expected = migrationPaths(data.baseJournal, data.headJournal);
  if (expected.snapshotPath !== data.snapshotPath || expected.sqlPath !== data.sqlPath) {
    throw new Error('journal 与新增文件身份不符');
  }
  const before = readJson(data.baseSnapshot),
    after = readJson(data.headSnapshot);
  checkFields(before);
  checkFields(after);
  const Header = z.object({
    id: z.uuid(),
    prevId: z.uuid(),
    version: z.literal('7'),
    dialect: z.literal('postgresql'),
  });
  const left = Header.parse(before),
    right = Header.parse(after);
  if (left.id !== right.prevId || left.id === right.id) throw new Error('snapshot 身份或 prevId 断链');
  const generated = await generateMigration(
    before as Parameters<typeof generateMigration>[0],
    after as Parameters<typeof generateMigration>[1],
  );
  if (generated.join('--> statement-breakpoint\n') !== data.sql)
    throw new Error('snapshot 独立生成 SQL 与新增 SQL 不完全相等');
}
