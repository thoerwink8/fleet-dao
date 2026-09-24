// fleet done 的核实：不是说了就算。证据只认库里的——GitHub 镜像里的 PR 与它的 CI、会话过程记录里读出来的测试。
import type { DoneRequest, StageKind } from '@fleet-dao/shared';
import type { z } from 'zod';
import type { PullRequestRecord, TestRunRecord } from './ports.ts';

/** 写码类的活交活必须带 PR、必须有测试证据。其余阶段（写需求文档、调研等）只核实带来的 PR。 */
export const CODE_STAGES: ReadonlySet<StageKind> = new Set(['execute', 'ui']);

export interface DoneEvidence {
  ci: PullRequestRecord['checks'] | 'no_pr';
  lastSessionTest?: TestRunRecord | undefined;
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
  branch: string;
  request: z.output<typeof DoneRequest>;
  /** request.prNumber 对应的镜像记录；没带 PR 编号或库里没有都是 null。 */
  pr: PullRequestRecord | null;
  tests: TestRunRecord[];
}): DoneVerdict {
  const { request, pr } = input;
  const needsCode = CODE_STAGES.has(input.stage);
  const n = request.prNumber;

  const reasons: string[] = [];
  if (!request.testsPassed) reasons.push('你自己报了测试没过：修好再交，或者用 fleet blocked 说明卡在哪');
  if (needsCode && n === undefined) reasons.push('写码的活交活要带 PR 编号');
  if (reasons.length > 0) return rejected(reasons);

  if (n !== undefined && !pr) {
    const reason = `PR #${n} 还没同步进库（GitHub 事件可能还在路上），过一两分钟再交；编号写错了就改正再交`;
    return { ok: false, status: 409, code: 'not_verifiable_yet', message: reason, reasons: [reason] };
  }
  if (pr) {
    if (pr.headRef !== input.branch) {
      reasons.push(`PR #${pr.number} 的分支是 ${pr.headRef}，不是本会话的分支 ${input.branch}`);
    }
    if (pr.state === 'closed') reasons.push(`PR #${pr.number} 已经关了`);
  }

  const sessionTests = [...input.tests].sort((a, b) => a.at.localeCompare(b.at));
  const lastSessionTest = sessionTests.at(-1);
  if (needsCode) {
    const ci = pr?.checks;
    if (ci === 'failure') {
      reasons.push(`PR #${n} 当前提交上的 CI 没过`);
    } else if (ci !== 'success') {
      // CI 还没出结果时，看本会话自己跑的最后一次测试。
      if (!lastSessionTest) reasons.push('没查到本次会话跑过测试的记录：先跑测试再交');
      else if (!lastSessionTest.passed) {
        reasons.push(
          `本次会话最后一次跑测试没过（${lastSessionTest.command ?? '测试'}，${lastSessionTest.at}）`,
        );
      }
    }
  }
  if (reasons.length > 0) return rejected(reasons);
  return { ok: true, evidence: { ci: pr?.checks ?? 'no_pr', lastSessionTest } };
}
