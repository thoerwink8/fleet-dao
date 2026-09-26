// fleet done 的核实：不是说了就算。
// 会话只在本地提交，推分支、开 PR、跑 GitHub 上的 CI 都由引擎在会话结束后做（设计文档第十四节），
// 所以交活时能核实的证据是会话自己跑的测试（插头从过程记录里读出来记进库的）。PR 和 CI 由引擎的验证步骤再核。
// 测试只认会话里真跑了仓的测试命令（repos.test_command，fleet-dao 是 pnpm test:changed：只跑改动影响到的测试；
// 全量检查和卫生检查归 CI 和引擎推分支时的扫描，specs/164-会话内存与交活测试/）；以最后一次为准，认不出结果的那一次
// 也算最后一次（不让它前面的「通过」顶上）。
// 带了 PR 编号（返工轮次 PR 已经在了）就顺带核对它确实是本会话的分支、没被关掉；它上面的 CI 是上一次推送的结果，
// 不代表这次会话的改动，不拿来判。
import type { DoneRequest, StageKind } from '@fleet-dao/shared';
import type { z } from 'zod';
import type { PullRequestRecord, TestRunRecord } from './ports.ts';

/** 写码类的活交活必须有测试证据。其余阶段（写需求文档、调研等）只核实带来的 PR。 */
export const CODE_STAGES: ReadonlySet<StageKind> = new Set(['execute', 'ui']);

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
  /** 仓的测试命令（repos.test_command）：退回时写明要跑哪一条。 */
  testCommand: string;
  request: z.output<typeof DoneRequest>;
  /** request.prNumber 对应的镜像记录；没带 PR 编号或库里没有都是 null。 */
  pr: PullRequestRecord | null;
  tests: TestRunRecord[];
}): DoneVerdict {
  const { request, pr } = input;
  const reasons: string[] = [];
  const run = `\`${input.testCommand}\``;

  if (!request.testsPassed) reasons.push('你自己报了测试没过：修好再交，或者用 fleet blocked 说明卡在哪');

  const lastSessionTest = [...input.tests].sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  if (CODE_STAGES.has(input.stage)) {
    if (!lastSessionTest) {
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
