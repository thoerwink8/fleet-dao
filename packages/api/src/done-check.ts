// fleet done 的核实：不是说了就算。
// 判法分两种，新判在前：
//
// 1. 调用方带了 PR 编号（这是 554-2 起的主流程）：**判 done = 看这张 PR 的 CI 是不是全绿**（
//    pull_requests.checks：checks.ts 的 mirrorChecks 已经把必过检查合成 success/failure/pending/none）。
//    拿不到 PR、CI 还没起、CI 还在跑，都明确失败（409 not_verifiable_yet），**不拿空当绿**。
//    测试由 CI 跑，会话里不再原样跑 test:changed（554-1 已经把「无头一次性子进程不跑测试」做成骨架；
//    会话提示词同步改成「交活只带提交」）。
//
// 2. 没带 PR 编号的旧路径（Fusion 写码阶段「会话只在本地提交、PR 由引擎在会话后开」）：**fallback** 保留
//    lastSessionTest 判定不变——只认起会话时记下的那条测试命令最后一次的结果（以 lastSessionTest 为准，
//    认不出的那一次也算最后一次）。Fusion 还在跑时这条不能拔。
//
// 以最后一次为准。带 PR 编号同时顺带核它的分支和状态（没被关、是本会话的分支）。
import { CODE_STAGES } from '@fleet-dao/core';
import type { DoneRequest, StageKind } from '@fleet-dao/shared';
import type { z } from 'zod';
import type { PullRequestRecord, TestRunRecord } from './ports.ts';

/**
 * kind=test 的进度载荷 → 一次测试记录。插头写的是 { command, passed } 或 { command, unknownBecause }；
 * 两样都没有的（载荷坏了）照样列出、算认不出，不悄悄丢掉。
 */
export function testRunOf(at: string, payload: unknown): TestRunRecord {
  const p = (typeof payload === 'object' && payload !== null ? payload : {}) as {
    passed?: unknown;
    command?: unknown;
    unknownBecause?: unknown;
  };
  const command = typeof p.command === 'string' ? p.command : undefined;
  if (typeof p.passed === 'boolean') return { at, passed: p.passed, command };
  const why = typeof p.unknownBecause === 'string' && p.unknownBecause.trim() ? p.unknownBecause.trim() : '';
  return { at, passed: null, command, unknownBecause: why || '记录里没有结果' };
}

export interface DoneEvidence {
  lastSessionTest?: TestRunRecord | undefined;
  pr?: { number: number; state: PullRequestRecord['state']; headRef: string } | undefined;
}

export type DoneVerdict =
  | { ok: true; evidence: DoneEvidence }
  | {
      ok: false;
      /** 422 = 核实不过，要改了再交；409 = 暂时核实不了（PR 还没同步进库、CI 还没跑完），过一会儿再交。 */
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

function waitOn(reasons: string[]): DoneVerdict {
  return {
    ok: false,
    status: 409,
    code: 'not_verifiable_yet',
    message: `暂时核实不了：${reasons.join('；')}`,
    reasons,
  };
}

export function checkDone(input: {
  stage: StageKind;
  /** 本会话的分支；引擎还没建分支时没有。 */
  branch?: string | undefined;
  /**
   * 起会话时交代给它的测试命令（session_runs.test_command）：**fallback 路径**用——没带 PR 编号的写码阶段只认它。
   * 带了 PR 编号这条不再参与判定（测试由 CI 跑，不在这里）。
   */
  testCommand?: string | undefined;
  request: z.output<typeof DoneRequest>;
  /** request.prNumber 对应的镜像记录；没带 PR 编号或库里没有都是 null。 */
  pr: PullRequestRecord | null;
  tests: TestRunRecord[];
}): DoneVerdict {
  const { request, pr } = input;
  const reasons: string[] = [];

  if (!request.testsPassed) reasons.push('你自己报了测试没过：修好再交，或者用 fleet blocked 说明卡在哪');

  // PR 分支和状态先核一遍：两条路径共用的额外核实（不带 PR 就没了）。
  const prProblems: string[] = [];
  if (pr) {
    if (input.branch === undefined) {
      prProblems.push(`本次会话还没有分支，没法核对 PR #${pr.number} 是不是它的`);
    } else if (pr.headRef !== input.branch) {
      prProblems.push(`PR #${pr.number} 的分支是 ${pr.headRef}，不是本会话的分支 ${input.branch}`);
    }
    if (pr.state === 'closed') prProblems.push(`PR #${pr.number} 已经关了`);
  }

  // 1) 主判：带了 PR 编号 → 看 PR 的 CI（mirrorChecks 的汇总）。**读不到 PR 不当绿当 409**。
  if (request.prNumber !== undefined) {
    if (!pr) {
      reasons.push(
        `PR #${request.prNumber} 还没同步进库，过一两分钟再交；编号写错了就改正再交，或者不带 --pr`,
      );
      return waitOn([...reasons, ...prProblems]);
    }
    if (prProblems.length > 0) return rejected([...reasons, ...prProblems]);
    /** CODE_STAGES 才看 check；非写码阶段（分诊、写文档）不问 CI，PR 在不在都行。 */
    if (CODE_STAGES.has(input.stage)) {
      switch (pr.checks) {
        case 'success':
          break;
        case 'failure':
          reasons.push(`PR #${pr.number} 的 CI 是红的（必要检查有一条没过）：修好这条 PR 再交`);
          return rejected(reasons);
        case 'pending':
          reasons.push(`PR #${pr.number} 的 CI 还在跑，等它跑完再交`);
          return waitOn(reasons);
        case 'none':
          reasons.push(`PR #${pr.number} 的 CI 还没起（一条必要检查都没出现），等它起出来再交`);
          return waitOn(reasons);
      }
    }
    if (reasons.length > 0) return rejected(reasons);
    return {
      ok: true,
      evidence: {
        pr: { number: pr.number, state: pr.state, headRef: pr.headRef },
      },
    };
  }

  // 2) Fallback：没带 PR 编号 → Fusion 旧路径，只认会话里跑过的测试（最后一条为准）。
  const run = `\`${input.testCommand}\``;
  const lastSessionTest = [...input.tests].sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  if (CODE_STAGES.has(input.stage)) {
    if (!input.testCommand) {
      reasons.push(
        '这次会话开工时没记下要跑的测试命令（加这一列之前开的会话），核对不了测试：别再交，用 fleet blocked 说明，由引擎重开一轮',
      );
    } else if (!lastSessionTest) {
      reasons.push(`没查到本次会话跑过 ${run} 的记录：先原样跑它再交（别的测试命令不算）`);
    } else if (lastSessionTest.passed === null) {
      reasons.push(
        `本次会话最后一次跑测试（${lastSessionTest.command ?? input.testCommand}，${lastSessionTest.at}）结果认不出：${lastSessionTest.unknownBecause ?? '记录里没有结果'}。原样跑 ${run}（别接管道、别放后台）再交`,
      );
    } else if (!lastSessionTest.passed) {
      reasons.push(
        `本次会话最后一次跑测试没过（${lastSessionTest.command ?? input.testCommand}，${lastSessionTest.at}）`,
      );
    }
  }

  if (prProblems.length > 0) reasons.push(...prProblems);
  if (reasons.length > 0) return rejected(reasons);

  return {
    ok: true,
    evidence: {
      lastSessionTest,
      pr: pr ? { number: pr.number, state: pr.state, headRef: pr.headRef } : undefined,
    },
  };
}
