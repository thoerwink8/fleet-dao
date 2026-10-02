// 一次 one-shot 跑完以后的判定：exit code + stdout 短句 + 「它给的 PR# 是不是真存在 / branch 是不是真起了」。
// **空 stdout + exit != 0 一律失败**，不许拿空当跑完（specs/509：「代码里读不到、没跑成、格式认不出，要返回
// 明确的失败，不许拿空、0 或 ok 冒充没事」）。
//
// 每一段的「最小证据」不一样（scope 只要 exit 0 + 短句；manual 还要 PR# 存在 + branch 起了、diff 非空；
// verify 还要 exit 0 + 结论行带 pass/fail），由 BriefEvidence 这块可空的字段表达出来——
// **不给就是没证据，按失败处理，不鲁式化**。

import type { OneShotResult } from './one-shot.ts';

/** 调用方对一段 one-shot 结果想要的「最小证据」——不给就当没有。 */
export interface BriefEvidence {
  /** manual：它说 PR 号是这么多。 */
  prNumber?: number;
  /** manual / verify：branch 名。 */
  branch?: string;
  /** manual / verify：相对主线的 head sha。 */
  headSha?: string;
  /** manual / verify：改了哪些文件；空数组 = 明确没改。 */
  changedFiles?: string[];
  /** verify：它的结论行（一行内带 "pass" 或 "fail"，大小写都行）。 */
  verdictLine?: string;
}

export type SegmentVerdict = { kind: 'ok'; reason: string } | { kind: 'failed'; reason: string };

/** 判 scope 段：只要 exit 0 + stdout 非空。 */
export function judgeScope(result: OneShotResult): SegmentVerdict {
  if (result.outcome !== 'done') {
    return {
      kind: 'failed',
      reason: `scope 段没跑完：outcome=${result.outcome}${result.failureReason ? `（${result.failureReason}）` : ''}`,
    };
  }
  if (result.stdout.trim() === '') {
    return {
      kind: 'failed',
      reason:
        'scope 段 exit 0 但 stdout 是空的：「建单需要整理稿」就是它的产出，空就是没干活（不许拿空当跑完）',
    };
  }
  return { kind: 'ok', reason: `scope 段跑完：${result.stdout.trim().slice(0, 80)}…` };
}

/** manual / verify 都要的「跑完了」基础判定。 */
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

/** 判 manual 段：跑完 + PR# 存在 + branch 起了 + 有 changedFiles（任缺 = 明确没干完）。 */
export function judgeManual(result: OneShotResult, ev: BriefEvidence): SegmentVerdict {
  const base = requireDone(result) ?? requireStdout(result);
  if (base !== null) return base;
  // 最小证据：PR、branch、changedFiles 三样。
  if (ev.prNumber === undefined || ev.prNumber <= 0) {
    return { kind: 'failed', reason: 'manual 段跑完了但 PR# 没给：没法确认它开了 PR' };
  }
  if (ev.branch === undefined || ev.branch === '') {
    return { kind: 'failed', reason: 'manual 段跑完了但 branch 没给：没法看分支起没起' };
  }
  if (ev.headSha === undefined || ev.headSha === '') {
    return { kind: 'failed', reason: 'manual 段跑完了但 headSha 没给：没法看分支有没有真提交' };
  }
  const files = ev.changedFiles;
  if (files === undefined || files.length === 0) {
    return { kind: 'failed', reason: 'manual 段跑完了但 changedFiles 空：没改任何文件就是没干活' };
  }
  return {
    kind: 'ok',
    reason: `manual 段跑完：PR #${ev.prNumber} / branch=${ev.branch} / ${files.length} 个文件`,
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

// 没有统一的 judgeSegment：三种判法入口各是 judgeScope / judgeManual / judgeVerify（由 segments/*.ts 按段挑）。
