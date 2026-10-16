// 贴了「本机做」超过 24 小时、又没有本机租约的开着的单（每小时对账写，fleet-api attention 只读）。
// 判在不在这份名单里只在对账那一处做；这里不另判，读到什么就是什么。没写过这一行 = 还没有这份名单（空数组）。
// 写过、形状认不出照抛，不拿空数组顶。
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../client.ts';
import { settings } from '../schema/index.ts';

/** 设置表里这一行的键。 */
export const LOCAL_ORPHANS_SETTING = 'reconcile.localOrphans';

const Item = z.object({
  /** owner/name。 */
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  issue: z.number().int().positive(),
  /** 贴了「本机做」多少毫秒（对账那一轮算的）。 */
  labeledForMs: z.number().int().nonnegative(),
  /** 贴上多久，给人看的说法（对账那一轮写死，巡检不重算）。 */
  labeledFor: z.string().trim().min(1),
  /** 谁贴的，以及留下的原因。 */
  reason: z.string().trim().min(1),
});

/** 对账写下来、巡检原样读走的一条。 */
export type LocalOrphan = z.infer<typeof Item>;

/** 认这份名单。认不出抛错。 */
export function parseLocalOrphans(value: unknown): LocalOrphan[] {
  const parsed = z.array(Item).safeParse(value);
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${i.path.join('.') || '整份'}：${i.message}`).join('；');
    throw new Error(`本机没人领的名单认不出（${why}）`);
  }
  return parsed.data;
}

/** 读。没有这一行是空数组（对账还没写过）。有、认不出照抛。 */
export async function readLocalOrphans(db: Db): Promise<LocalOrphan[]> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, LOCAL_ORPHANS_SETTING));
  if (!row) return [];
  return parseLocalOrphans(row.value);
}

/** 整份换上（有就换、没有就建）。写之前先认一遍，形状不对不写。 */
export async function writeLocalOrphans(db: Db, items: readonly LocalOrphan[], by: string): Promise<void> {
  const value = parseLocalOrphans([...items]);
  await db
    .insert(settings)
    .values({ key: LOCAL_ORPHANS_SETTING, value, updatedBy: by })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedBy: by, version: sql`${settings.version} + 1` },
    });
}
