// 验收（verify）段入口：合之前一次冷调用。
// 喂三样：diff + 要什么 + 怎么算做完（specs/509 第五、六节）。**PR 是参数**——不许本段跨进程去数据库翻
// 「上一段的 PR#」。diff 由调用方在起会话之前现算出来塞进 brief.diffText。

import { renderBrief, type VerifyBrief } from '../runner/brief.ts';
import type { OneShotDeps, OneShotResult } from '../runner/one-shot.ts';
import { runOneShot } from '../runner/one-shot.ts';
import type { BriefEvidence, SegmentVerdict } from '../runner/verdict.ts';
import { judgeVerify } from '../runner/verdict.ts';

export interface RunVerifyInput {
  brief: VerifyBrief;
  modelId: string;
  channel?: string;
  issueNumber?: number;
  cwd: string;
  timeoutMinutes?: number;
  /**
   * 会话结束_stdout 的最后一行_（调用方在 result.stdout 里挑出来）：判「pass / fail」用。不给就把
   * stdout 的最后一行当它。
   */
  verdictLine?: string;
}

export interface RunVerifyOutput {
  result: OneShotResult;
  verdict: SegmentVerdict;
}

export async function runVerify(input: RunVerifyInput, deps: OneShotDeps): Promise<RunVerifyOutput> {
  const prompt = renderBrief(input.brief);
  const result = await runOneShot(
    {
      segment: 'verify',
      modelId: input.modelId,
      ...(input.channel !== undefined ? { channel: input.channel } : {}),
      ...(input.issueNumber !== undefined ? { issueNumber: input.issueNumber } : {}),
      prompt,
      cwd: input.cwd,
      ...(input.timeoutMinutes !== undefined ? { timeoutMinutes: input.timeoutMinutes } : {}),
    },
    deps,
  );
  const evidence: BriefEvidence = {
    verdictLine:
      input.verdictLine ??
      result.stdout
        .trim()
        .split('\n')
        .filter((l) => l.trim() !== '')
        .at(-1) ??
      '',
  };
  return { result, verdict: judgeVerify(result, evidence) };
}
