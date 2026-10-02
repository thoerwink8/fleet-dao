// 按改动面分档：单看「这一单相对 base 改了哪些文件」给个档位（fast / medium / heavyweight）+ 推理强度。
//
// 判据原文（specs/509-需求梳理/流程重做方案.md §四；#554-3 任务三行，**严格顺序判定**）：
//   1. 空改动列表 → 明确失败，不默认 fast
//   2. 改动面 > TIER_HEAVYWEIGHT_FILE_THRESHOLD 个文件 → 不再 refine，直接 heavyweight
//   3. **一个文件 → fast**（不管是不是碰了接口包）
//   4. **同一个 packages/<包>/ 内几个文件 → medium**（不管是不是碰了接口包）
//   5. 其余（跨包 / 不是 packages/<包>/ 路径）→ heavyweight
//
// 顺序是任务三行从上往下的自然解读；三个例子的归位（packages/api/src/cli.ts 单文件 → fast；
// packages/shared/src/*.ts 同包多文件 → medium；packages/api + packages/core 跨包 → heavyweight）
// 只有按这个顺序判定才全对得上。tasks 里把 `packages/{api,core,shared}/` 叫「接口」是对第 5 条的
// 说明（跨模块跨到这三包时触发 heavy），不是对 3、4 的覆盖。
//
// 一次定死：**不升档、不回退**——tier 输出后不再随输入变化。纯函数，不接 engine，不读 git，
// 由调用方把 `git diff --name-only <base>..<head>` 的结果（文件路径列表）喂进来。

import { z } from 'zod';

export const TierEnum = z.enum(['fast', 'medium', 'heavyweight']);
export type Tier = z.infer<typeof TierEnum>;

export const EffortEnum = z.enum(['high', 'medium']);
export type Effort = z.infer<typeof EffortEnum>;

export const TierDecisionSchema = z.object({
  tier: TierEnum,
  effort: EffortEnum,
  /** 为什么是这个档：reason 是给验收和事后复盘看的，**必写**。 */
  reason: z.string().min(1),
});
export type TierDecision = z.infer<typeof TierDecisionSchema>;

/** 「接口」包：task §四原文列的三包；当前实现里仅作为注释性常量保留（用于 reason 文案），不影响判定。 */
const INTERFACE_PACKAGES = new Set(['api', 'core', 'shared']);

/** 改动面 >50 个文件时不再 refine，直接 heavyweight。任务原文：「输入超大文件数（>50）不动 refine」。 */
export const TIER_HEAVYWEIGHT_FILE_THRESHOLD = 50;

/** 「一个模块」在本仓的形状：`packages/<包名>/...`。不是这种形状的（根目录、agents、docs、specs……）一律算跨面。 */
const PACKAGE_PATH_RE = /^packages\/([^/]+)\//;

export class TierError extends Error {
  readonly code: 'EMPTY_DIFF_INPUT';
  constructor(code: TierError['code'], message: string) {
    super(message);
    this.name = 'TierError';
    this.code = code;
  }
}

/**
 * 分档。输入空列表（真的没有改动，或上游 `git diff` 读不出来）→ 抛 TierError，**不默认 fast**。
 * 不拿空当「改了一个文件」（通用段底线：「代码里读不到、没跑成、格式认不出，要返回明确的失败」）。
 */
export function decideTier(changedFiles: readonly string[]): TierDecision {
  if (changedFiles.length === 0) {
    throw new TierError(
      'EMPTY_DIFF_INPUT',
      'decideTier 拿到空的文件列表——上游拿 diff 失败了应该明确失败（不默认 fast 档）。',
    );
  }

  if (changedFiles.length > TIER_HEAVYWEIGHT_FILE_THRESHOLD) {
    return {
      tier: 'heavyweight',
      effort: 'high',
      reason: `改动面超过 ${TIER_HEAVYWEIGHT_FILE_THRESHOLD} 个文件（实际 ${changedFiles.length} 个）：不再 refine 档位，直接主力档`,
    };
  }

  if (changedFiles.length === 1) {
    const only = changedFiles[0];
    if (only === undefined) {
      // 前端永远到不了这里（length===1 必有第一个），但 noUncheckedIndexedAccess 下要守。
      throw new TierError(
        'EMPTY_DIFF_INPUT',
        'decideTier 拿到的文件列表第一个元素是 undefined（不该发生）。',
      );
    }
    return {
      tier: 'fast',
      effort: 'medium',
      reason: `只改了一个文件（${only}）→ 快档`,
    };
  }

  // 拿到每个文件归属的包名；任何一条不是 packages/<包>/ 路径 → null（第 5 条主力档的候选）。
  const pkgs = new Set<string | null>();
  for (const f of changedFiles) {
    const m = PACKAGE_PATH_RE.exec(f);
    pkgs.add(m?.[1] ?? null);
  }

  // 第 4 条：全是同一 packages/<包>/ → medium（不管碰不碰接口包——顺序判定，第 5 条还没轮到）。
  if (pkgs.size === 1) {
    const p = [...pkgs][0];
    if (p !== null && p !== undefined) {
      const interfaceNote = INTERFACE_PACKAGES.has(p) ? '（接口包内多文件，按顺序仍属中档）' : '';
      return {
        tier: 'medium',
        effort: 'high',
        reason: `都在同一模块 packages/${p}/（${changedFiles.length} 个文件）${interfaceNote} → 中档`,
      };
    }
  }

  // 第 5 条：跨包 / 不在 packages/<包>/ 路径下 → heavyweight。任务里点名的「碰接口」就是这个分支：
  // api / core / shared 只要出现在这堆包里，都走到了这里。
  const touched = [...pkgs].filter((p): p is string => p !== null && INTERFACE_PACKAGES.has(p));
  const interfaceHint =
    touched.length > 0 ? `，碰接口包：${touched.map((p) => `packages/${p}/`).join('、')}` : '';
  const paths = changedFiles.slice(0, 5).join(', ');
  return {
    tier: 'heavyweight',
    effort: 'high',
    reason: `跨模块或非 packages/<包>/ 路径（前 5 个：${paths}${changedFiles.length > 5 ? `…共 ${changedFiles.length} 个` : ''}${interfaceHint}）→ 主力档`,
  };
}
