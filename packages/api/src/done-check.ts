// fleet done 的核实：不是说了就算。
// 会话只在本地提交，推分支、开 PR、跑 GitHub 上的 CI 都由引擎在会话结束后做（设计文档第十四节），
// 所以交活时能核实的证据是会话自己跑的测试（插头从过程记录里读出来记进库的）。PR 和 CI 由引擎的验证步骤再核。
// 带了 PR 编号（返工轮次 PR 已经在了）就顺带核对它确实是本会话的分支、没被关掉；它上面的 CI 是上一次推送的结果，
// 不代表这次会话的改动，不拿来判。
import type { DoneRequest, StageKind } from '@fleet-dao/shared';
import type { z } from 'zod';
import type { PullRequestRecord, TestRunRecord } from './ports.ts';

/** 写码类的活交活必须有测试证据。其余阶段（写需求文档、调研等）只核实带来的 PR。 */
export const CODE_STAGES: ReadonlySet<StageKind> = new Set(['execute', 'ui']);

export interface DoneEvidence {
  lastSessionTest?: TestRunRecord | undefined;
  pr?: { number: number; state: PullRequestRecord['state']; headRef: string } | undefined;
}

export type DoneVerdict =
  | { ok: true; evidence: DoneEvidence }
  | {
      ok: false;
      /** 422 = 核实不过，要改了再交；409 = 暂时核实不了（PR 还没同步进库），过一会儿再交。 */
      status: 409 | 422;
      code: 'done_rejected' | 'not_verifiable_yet';
      message: string;
      reasons: string[];
    };

function rejected(reasons: string[]): DoneVerdict {
  return {
    ok: false,
    status: 422,
    code: 'done_rejected',
    message: `交活没通过核实：${reasons.join('；')}`,
    reasons,
  };
}

export function checkDone(input: {
  stage: StageKind;
  /** 本会话的分支；引擎还没建分支时没有。 */
  branch?: string | undefined;
  request: z.output<typeof DoneRequest>;
  /** request.prNumber 对应的镜像记录；没带 PR 编号或库里没有都是 null。 */
  pr: PullRequestRecord | null;
  tests: TestRunRecord[];
}): DoneVerdict {
  const { request, pr } = input;
  const reasons: string[] = [];

  if (!request.testsPassed) reasons.push('你自己报了测试没过：修好再交，或者用 fleet blocked 说明卡在哪');

  const lastSessionTest = [...input.tests].sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  if (CODE_STAGES.has(input.stage)) {
    if (!lastSessionTest) reasons.push('没查到本次会话跑过测试的记录：先跑测试再交');
    else if (!lastSessionTest.passed) {
      reasons.push(
        `本次会话最后一次跑测试没过（${lastSessionTest.command ?? '测试'}，${lastSessionTest.at}）`,
      );
    }
  }

  if (pr) {
    if (input.branch === undefined) {
      reasons.push(`本次会话还没有分支，没法核对 PR #${pr.number} 是不是它的`);
    } else if (pr.headRef !== input.branch) {
      reasons.push(`PR #${pr.number} 的分支是 ${pr.headRef}，不是本会话的分支 ${input.branch}`);
    }
    if (pr.state === 'closed') reasons.push(`PR #${pr.number} 已经关了`);
  }
  if (reasons.length > 0) return rejected(reasons);

  if (request.prNumber !== undefined && !pr) {
    const reason = `PR #${request.prNumber} 还没同步进库，过一两分钟再交；编号写错了就改正再交，或者不带 --pr`;
    return { ok: false, status: 409, code: 'not_verifiable_yet', message: reason, reasons: [reason] };
  }
  return {
    ok: true,
    evidence: {
      lastSessionTest,
      pr: pr ? { number: pr.number, state: pr.state, headRef: pr.headRef } : undefined,
    },
  };
}
