// 发给别家（非 Claude）的整份提示词先过卫生检查：查出真密钥或没扫成都不发，报带码的错（失败分流 HY2、HY4 认）。
// 从 sessions.ts 拆出来，函数体原样，sessions.ts 原样重新导出。

import type { RepoRef } from '@fleet-dao/github';
import { errMessage } from '@fleet-dao/shared/util';
import { PortError } from '../ports.ts';
import type { SessionPortsDeps } from './session-types.ts';

/** 发给别家的材料在卫生检查里叫什么（报错里的位置只有它和行号、规则名，没有值）。 */
export interface Material {
  what: string;
  path: string;
}
export const VERIFY_MATERIAL: Material = { what: '发给别家的验证材料', path: '验证提示词' };
export const WORK_MATERIAL: Material = { what: '发给别家的交代', path: '提示词' };

/** 自家（Claude）之外的族都算别家：派给它的整份提示词先过卫生检查。 */
export function otherVendor(family: string): boolean {
  return family.trim().toLowerCase() !== 'claude';
}

/**
 * 发给别家之前的卫生检查：查出真密钥的报 MATERIAL_BLOCKED（不可重试；失败分流 HY4 当场挂起报警——材料是工作流交代的，
 * 换路由、退回会话都还是它）；没扫成原样报 HYGIENE_UNSCANNED（HY2 挂起）；没配检查、检查自己出错都算没扫成，不发。
 * 报错里只有位置、行号和规则名（assertPublishable 不打值）。
 */
export function screenForOtherVendor(
  repo: RepoRef,
  screen: SessionPortsDeps['screen'],
  prompt: string,
  to: string,
  material: Material = VERIFY_MATERIAL,
): void {
  if (!screen) {
    throw new PortError(
      'HYGIENE_UNSCANNED',
      `${material.what}没法过卫生检查（会话端口没配检查），不发给${to}`,
      {
        retryable: false,
      },
    );
  }
  try {
    screen(repo, material.what, [{ path: material.path, text: prompt }]);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const details = (error as { details?: unknown } | null)?.details;
    if (code === 'HYGIENE_BLOCKED') {
      const raw = (details as { findings?: unknown } | undefined)?.findings;
      const findings = Array.isArray(raw)
        ? (raw as { path?: unknown; line?: unknown; rule?: unknown }[])
        : [];
      const where = findings
        .slice(0, 10)
        .map(
          (f) =>
            `${String(f.path)}${typeof f.line === 'number' && f.line > 0 ? ` 第 ${f.line} 行` : ''} ${String(f.rule)}`,
        )
        .join('；');
      throw new PortError(
        'MATERIAL_BLOCKED',
        where
          ? `${material.what}没过卫生检查，没发给${to}：查出 ${findings.length} 处（${where}）`
          : `${material.what}没过卫生检查，没发给${to}：${errMessage(error)}`,
        { retryable: false, details },
      );
    }
    if (code === 'HYGIENE_UNSCANNED') {
      throw new PortError(code, errMessage(error), { retryable: false, details });
    }
    throw new PortError('HYGIENE_UNSCANNED', `${material.what}没扫成，不发给${to}：${errMessage(error)}`, {
      retryable: false,
    });
  }
}
