// 给开 PR 前验证留一家（0003 第 5 条「验证只派别家」，ChooseRouteInput.keepVerifier）：选副手、Lead 换路由这类会给这张单
// 加一个写手族的步骤，按候选的族把「写手族 + 它」交给验证那一步现选一次——和 workflows/verify.ts 真验证时同一个 chooseRoute、
// 同一份事实，只派别家、界面类 GPT 不验都照它判。派不出（none）就是验证没人可派；等得来（空位、额度、熔断到点）不算。
// 选法本身（挡谁、放行谁、什么时候照常选）在 choose.ts。
import { familyKey } from './filter.ts';
import type { ChooseRouteInput, ChooseRouteResult, KeepVerifier } from './types.ts';

export interface VerifierGuard {
  /** 写这张单的族（小写、去重）。 */
  writers: readonly string[];
  /**
   * 写手族再加上 family（null = 不加）之后验证派不出：白话原因（写手族 + 验证那一步每条路由为什么派不出）；派得出为 null。
   * 同一组族只现选一次。
   */
  left(family: string | null): string | null;
  /** 候选挡掉（no-verifier）时写的短话：驾驶舱逐条显示，长的原因在 left 里。 */
  block(family: string): string;
}

export function verifierGuard(
  keep: KeepVerifier,
  choose: (input: ChooseRouteInput) => ChooseRouteResult,
): VerifierGuard {
  const writers = unique(keep.writers.map(familyKey));
  const familiesWith = (family: string | null) =>
    family === null ? writers : unique([...writers, familyKey(family)]);
  const memo = new Map<string, string | null>();
  const probe = (families: string[]): string | null => {
    const key = families.join('\n');
    const known = memo.get(key);
    if (known !== undefined) return known;
    const r = choose({ ...keep.verify, stage: 'verify', avoid: { ...keep.verify.avoid, families } });
    const reason = r.kind === 'none' ? r.reason : null;
    memo.set(key, reason);
    return reason;
  };
  return {
    writers,
    left(family) {
      const families = familiesWith(family);
      const reason = probe(families);
      if (reason === null) return null;
      return family !== null && !writers.includes(familyKey(family))
        ? `再派 ${familyKey(family)} 族的话，写这张单的就有 ${families.join('、')} 族，${reason}`
        : `写这张单的已经有 ${writers.join('、')} 族，${reason}`;
    },
    block(family) {
      return `选它开 PR 前验证就没有别家可派了（写这张单的会是 ${familiesWith(family).join('、')} 族）`;
    },
  };
}

function unique(families: string[]): string[] {
  return [...new Set(families)];
}
