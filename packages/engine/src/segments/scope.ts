// 对题（scope）段入口：建单前的整理稿。
// 只做一件事——拿到需求文字 → 起一次无头会话 → 拿整理稿 → 判成败。不建单、不动 GitHub、不改任何数据库。

import { renderBrief, type ScopeBrief } from '../runner/brief.ts';
import type { OneShotDeps, OneShotResult } from '../runner/one-shot.ts';
import { runOneShot } from '../runner/one-shot.ts';
import type { SegmentVerdict } from '../runner/verdict.ts';
import { judgeScope } from '../runner/verdict.ts';

export interface RunScopeInput {
  brief: ScopeBrief;
  /** 挑好的模型 id（上游；554-3 场景按档位挑）。 */
  modelId: string;
  channel?: string;
  issueNumber?: number;
  cwd: string;
  timeoutMinutes?: number;
}

export interface RunScopeOutput {
  result: OneShotResult;
  verdict: SegmentVerdict;
}

export async function runScope(input: RunScopeInput, deps: OneShotDeps): Promise<RunScopeOutput> {
  const prompt = renderBrief(input.brief);
  const result = await runOneShot(
    {
      segment: 'scope',
      modelId: input.modelId,
      ...(input.channel !== undefined ? { channel: input.channel } : {}),
      ...(input.issueNumber !== undefined ? { issueNumber: input.issueNumber } : {}),
      prompt,
      cwd: input.cwd,
      ...(input.timeoutMinutes !== undefined ? { timeoutMinutes: input.timeoutMinutes } : {}),
    },
    deps,
  );
  return { result, verdict: judgeScope(result) };
}
