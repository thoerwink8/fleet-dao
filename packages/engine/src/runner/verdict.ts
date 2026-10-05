// 一次 one-shot 跑完以后的判定：exit code + stdout + 结论行。
// **空 stdout + exit != 0 一律失败**，不许拿空当跑完（specs/509：「代码里读不到、没跑成、格式认不出，要返回
// 明确的失败，不许拿空、0 或 ok 冒充没事」）。
//
// 只剩冷调用验收（verifier-invoke.ts）在用：要 exit 0 + 结论行带 pass/fail，由 BriefEvidence 表达——
// **不给就是没证据，按失败处理，不鲁式化**。

import type { OneShotResult } from './one-shot.ts';

/** 调用方对一段 one-shot 结果想要的「最小证据」——不给就当没有。 */
export interface BriefEvidence {
  /** verify：它的结论行（一行内带 "pass" 或 "fail"，大小写都行）。 */
  verdictLine?: string;
}

export type SegmentVerdict = { kind: 'ok'; reason: string } | { kind: 'failed'; reason: string };

/** 「跑完了」基础判定。 */
function requireDone(r: OneShotResult): SegmentVerdict | null {
  if (r.outcome === 'done') return null;
  return {
    kind: 'failed',
    reason: `outcome=${r.outcome}${r.failureReason ? `（${r.failureReason}）` : ''}，不是 done`,
  };
}

function requireStdout(r: OneShotResult): SegmentVerdict | null {
  if (r.stdout.trim() !== '') return null;
  return {
    kind: 'failed',
    reason: 'exit=0 但 stdout 空——不许拿空 stdout 当跑完',
  };
}

/** 判 verify 段：跑完 + 结论行明确 pass / fail（不许它判「写得好不好」）。 */
export function judgeVerify(result: OneShotResult, ev: BriefEvidence): SegmentVerdict {
  const base = requireDone(result) ?? requireStdout(result);
  if (base !== null) return base;
  const line = ev.verdictLine ?? '';
  const hasPass = /\bpass\b/i.test(line);
  const hasFail = /\bfail\b/i.test(line);
  if (hasPass && hasFail) {
    return { kind: 'failed', reason: `verify 结论行又 pass 又 fail（${line}）：一句话说不清的当成没结论` };
  }
  if (!hasPass && !hasFail) {
    return {
      kind: 'failed',
      reason: `verify 结论行没写 pass 或 fail（${line}）：验收必须明确给结论（specs/509 只有三种能挡）`,
    };
  }
  return { kind: 'ok', reason: `verify 段跑完：${line}` };
}
