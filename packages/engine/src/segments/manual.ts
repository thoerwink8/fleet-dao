// 动手（manual）段入口：写代码起 PR。
// 只调 one-shot + brief，不推分支、不开 PR、不动 GitHub——**会话只写代码**；分支和 PR 由调用方在它自己的
// 工作树里办（Fusion 时代的 pushBranch / openPr 留着走老路，本切片不替代它们）。
//
// Evidence 是**调用方在会话结束后现读的**（prNumber / branch / headSha / changedFiles），
// 不许本模块自己再去翻数据库——那是「上一段的 PR#」反模式（specs/509 第六节）。

import { type ManualBrief, renderBrief } from '../runner/brief.ts';
import type { OneShotDeps, OneShotResult } from '../runner/one-shot.ts';
import { runOneShot } from '../runner/one-shot.ts';
import type { BriefEvidence, SegmentVerdict } from '../runner/verdict.ts';
import { judgeManual } from '../runner/verdict.ts';

export interface RunManualInput {
  brief: ManualBrief;
  modelId: string;
  channel?: string;
  issueNumber?: number;
  cwd: string;
  timeoutMinutes?: number;
}

export interface RunManualOutput {
  result: OneShotResult;
  verdict: SegmentVerdict;
}

export async function runManual(input: RunManualInput, deps: OneShotDeps): Promise<RunManualOutput> {
  const prompt = renderBrief(input.brief);
  const result = await runOneShot(
    {
      segment: 'manual',
      modelId: input.modelId,
      ...(input.channel !== undefined ? { channel: input.channel } : {}),
      ...(input.issueNumber !== undefined ? { issueNumber: input.issueNumber } : {}),
      prompt,
      cwd: input.cwd,
      ...(input.timeoutMinutes !== undefined ? { timeoutMinutes: input.timeoutMinutes } : {}),
    },
    deps,
  );
  // Evidence：本切片只接 brief 已经给的东西——更细的（prNumber、真 changedFiles）由调用方在自己工作树里现算后
  // 再调一次 judgeManual；这里给 0 帧版本，让上层先跑通接口。
  const evidence: BriefEvidence = {
    branch: input.brief.branch,
    headSha: input.brief.baseSha,
    changedFiles: [],
  };
  return { result, verdict: judgeManual(result, evidence) };
}
