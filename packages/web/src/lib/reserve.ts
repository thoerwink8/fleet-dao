// 设置页「各渠道的额度留量线」的输入和存值互转（#194 方案 4.8）。存的是 {池编号: {窗口: 比例 | null}}（shared 的
// QuotaReserveSettingSchema）；输入框里写百分数：留空 = 未配置（从存值里删掉这一项，也是不限），写「不限」= 明确不限（存 null），
// 写 0–100 的数 = 到这个百分比就停。认不出的输入明确报错，不当成不限。这里没有任何具体数值的默认：线只来自库里。
import { QUOTA_RESERVE_SEED_ACTOR, type QuotaWindowKind } from '@fleet-dao/shared';

export type ReserveInput = { ok: true; value: number | null | undefined } | { ok: false; why: string };

export const UNLIMITED_WORD = '不限';

/** 输入框文字 → 存值。undefined = 未配置（删掉）；null = 明确不限；数 = 比例。 */
export function parseReserveInput(text: string): ReserveInput {
  const t = text.trim();
  if (t === '') return { ok: true, value: undefined };
  if (t === UNLIMITED_WORD) return { ok: true, value: null };
  const n = Number(t.replace(/%$/, ''));
  if (!Number.isFinite(n))
    return { ok: false, why: `「${t}」不是数字（写 0–100，或「${UNLIMITED_WORD}」，或留空 = 未配置）` };
  if (n < 0 || n > 100) return { ok: false, why: `留量线要 0 到 100 之间，写的是 ${n}` };
  // 去掉浮点尾巴：0.7、不是 0.7000000000000001
  return { ok: true, value: Math.round(n * 100) / 10_000 };
}

/** 存值 → 输入框文字（没写 = 空，未配置）。 */
export function reserveInputText(v: number | null | undefined): string {
  if (v === undefined) return '';
  if (v === null) return UNLIMITED_WORD;
  return String(Math.round(v * 10_000) / 100);
}

/** 这个池界面上列哪几种窗口：池读到的、存值里写了的，去重，按固定顺序。 */
export function reserveKindsFor(
  seen: readonly QuotaWindowKind[],
  saved: Partial<Record<QuotaWindowKind, unknown>>,
): QuotaWindowKind[] {
  const all = new Set<QuotaWindowKind>([...seen, ...(Object.keys(saved) as QuotaWindowKind[])]);
  const order: QuotaWindowKind[] = ['5h', '7d', '7d_model', 'month_usd', 'period_usd', 'points', 'other'];
  return order.filter((k) => all.has(k));
}

/** 这一项设置现在是谁定的：种子装的（还没人在驾驶舱改过）、人改过、库里没有（种子没装上）。 */
export function reserveSource(
  s: { version: number; updatedBy?: string | undefined } | undefined,
): { kind: 'missing' } | { kind: 'seed' } | { kind: 'edited'; by: string | undefined } {
  if (!s || s.version === 0) return { kind: 'missing' };
  if (s.updatedBy === QUOTA_RESERVE_SEED_ACTOR) return { kind: 'seed' };
  return { kind: 'edited', by: s.updatedBy };
}
