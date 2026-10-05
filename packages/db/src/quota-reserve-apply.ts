// 各渠道额度留量线的种子（packages/db/quota-reserve.default.json，进仓）和装载器（#194 方案 4.8），沿用路由骨架（routing-config.ts、
// routing-apply.ts）的做法：只读和校验种子；发布时由 bin/routing.ts 在路由骨架之后调，只补缺写进库的设置 engine.quotaReserve——
// 库里已经有这一行（包括创始人在驾驶舱改过的）一个字不动。线只存在库里，引擎、驾驶舱都读库，代码里没有任何具体数值。
// 种子读不到、不是 JSON、格式认不出（负数、大于 1、不是数字、未知窗口）、引用的池库里没有：一行不写、明确报错
// （QuotaReserveSeedError），由命令行变成退出码 1、发布那一步红，不当成空配置、不吞。
import { readFile } from 'node:fs/promises';
import {
  QUOTA_RESERVE_SEED_ACTOR,
  QUOTA_RESERVE_SETTING,
  QuotaReserveSettingSchema,
} from '@fleet-dao/shared';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from './client.ts';
import { stripComments } from './routing-config.ts';
import { pools, settings } from './schema/index.ts';

export const QUOTA_RESERVE_DEFAULT_PATH = new URL('../quota-reserve.default.json', import.meta.url);

const SeedSchema = z.strictObject({ pools: QuotaReserveSettingSchema });
export type QuotaReserveSeed = z.infer<typeof SeedSchema>;

export class QuotaReserveSeedError extends Error {
  readonly problems: string[];
  constructor(title: string, problems: string[]) {
    super([title, ...problems.map((p) => `- ${p}`)].join('\n'));
    this.name = 'QuotaReserveSeedError';
    this.problems = problems;
  }
}

/** 文本 → 种子；`source` 只用在报错里说是哪个文件。 */
export function parseQuotaReserveSeed(text: string, source = 'quota-reserve.default.json'): QuotaReserveSeed {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new QuotaReserveSeedError(`${source} 不是合法的 JSON`, [(err as Error).message]);
  }
  const parsed = SeedSchema.safeParse(stripComments(raw));
  if (!parsed.success) {
    throw new QuotaReserveSeedError(
      `${source} 格式不对`,
      parsed.error.issues.map((i) => `${i.path.join('.') || '(根)'}：${i.message}`),
    );
  }
  return parsed.data;
}

/** 读种子文件；读不到明确报错，不当成空配置。 */
export async function loadQuotaReserveSeed(
  path: string | URL = QUOTA_RESERVE_DEFAULT_PATH,
): Promise<QuotaReserveSeed> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new QuotaReserveSeedError(`读不到额度留量线种子 ${String(path)}`, [(err as Error).message]);
  }
  return parseQuotaReserveSeed(text, String(path));
}

export interface QuotaReserveApplyReport {
  /** true = 这次装进去了；false = 库里已有这一行，一个字没动。 */
  applied: boolean;
}

/**
 * 只补缺：设置 engine.quotaReserve 在库里没有才装（updatedBy 记成种子，驾驶舱据此写「来自种子」）；已有的不动。
 * 种子里写的池库里没有 → 一行不写、报错（编号写错的线不会悄悄不起作用）。
 */
export async function applyQuotaReserveSeed(
  db: Db,
  seed: QuotaReserveSeed,
): Promise<QuotaReserveApplyReport> {
  const ids = Object.keys(seed.pools);
  const known = new Set(
    ids.length === 0
      ? []
      : (await db.select({ id: pools.id }).from(pools).where(inArray(pools.id, ids))).map((p) => p.id),
  );
  const problems = ids.filter((id) => !known.has(id)).map((id) => `账号池 ${id} 库里没有`);
  if (problems.length > 0) throw new QuotaReserveSeedError('额度留量线种子和库里对不上，一行没写', problems);
  const inserted = await db
    .insert(settings)
    .values({ key: QUOTA_RESERVE_SETTING, value: seed.pools, updatedBy: QUOTA_RESERVE_SEED_ACTOR })
    .onConflictDoNothing({ target: settings.key })
    .returning({ key: settings.key });
  return { applied: inserted.length > 0 };
}

/** 给发布日志看的摘要：装了还是已有没动，不留空。 */
export function formatQuotaReserveApplyReport(r: QuotaReserveApplyReport, seed: QuotaReserveSeed): string {
  const n = Object.keys(seed.pools).length;
  return r.applied
    ? `额度留量线：库里原来没有，按种子装进去了（${n} 个池写了线）`
    : '额度留量线：库里已有，一个字没动（驾驶舱改过的不覆盖）';
}

/** 命令行（bin/routing.ts）和测试共用的一趟：读种子 → 只补缺写进库 → 摘要。读不到、认不出、引用对不上照样抛。 */
export async function runQuotaReserveApply(
  db: Db,
  path: string | URL = QUOTA_RESERVE_DEFAULT_PATH,
): Promise<string> {
  const seed = await loadQuotaReserveSeed(path);
  return formatQuotaReserveApplyReport(await applyQuotaReserveSeed(db, seed), seed);
}
