// 三段（对题 / 动手 / 验收）走 runner 的会话端口（#554-4）：
// 三个段不起 Fusion 的会话链——工作树、db session_runs 行、流出 .fleet-out/ 的 OutputKind 都不动，只起一次
// 用完就退的无头进程（runner/one-shot.ts）＋把 runs 记账（NotWired JSONL；#556-4 建表后从这份 JSONL 补导入）。
//
// 与 sessions.ts 老链路的分界：进来的 LaunchSessionInput 里的 `brief.segment` 给了就跑这里；没给就走原
// startSession → launch。三段的**模型选路 / 分档挑档**是 #554-3 之后的事，本切片从 input.route.modelId 拿现成的。
//
// **生产 Spawner 还没接**：SegmentsRunnerDeps.spawner 为 undefined 时抛 SEGMENT_NOT_WIRED（明确失败，
// 不鲁式化）。装上真 Spawner 是下一片（554-2 测试移出会话、555 验收实做那一档）。
//
// 返回形状不走 Fusion 的 SessionEnd / SessionOutput：那是 Lead / OutputKind 一路的形状，runner 段的产出是
// stdout 短句 + verdict + 落盘的 runs。调用方（老链路、#554-2 各段实做）接**这一份**。

import { randomUUID } from 'node:crypto';
import type { Db } from '@fleet-dao/db';
import type { LaunchSessionInput } from '../ports.ts';
import { PortError } from '../ports.ts';
import { renderBrief } from '../runner/brief.ts';
import {
  type OneShotDeps,
  type OneShotInput,
  type OneShotResult,
  type OneShotSpawner,
  runOneShot,
} from '../runner/one-shot.ts';
import { judgeScope, judgeVerify, type SegmentVerdict } from '../runner/verdict.ts';
import { segmentBriefFrom } from './prompts.ts';

/** 「runner 的 Spawner 还没挂」的错码：失败分流 / 驾驶舱按它认「这不是会话失败，是机制没接」。 */
export const SEGMENT_NOT_WIRED_CODE = 'SEGMENT_NOT_WIRED';

/** buildSegmentCommand 的返回形状：起 segment 会话的 argv 和 cwd。 */
export interface SegmentCommandSpec {
  argv: string[];
  cwd?: string;
}

/** 把 one-shot 输入换成 argv/cwd 的回调（生产接 grok/claude 命令行；测试给 fake）。 */
export type BuildSegmentCommand = (input: OneShotInput) => SegmentCommandSpec;

/** 起一段 runner 会话要的全部东西。spawner 依赖注入——测试给 fake、不碰真进程。 */
export interface SegmentPortsDeps {
  db: Db;
  /** Spawner：生产真起一个 child_process（下一片接 `real/exec.ts`）；测试给 fake。 */
  spawner?: OneShotSpawner;
  /** buildCommand：把 one-shot 输入换成 argv/cwd。 */
  buildCommand?: BuildSegmentCommand;
  /** 工作目录 root：优先 input.worktreePath，不给再取这里。 */
  cwd?: string;
  /** runs 落点（554-1 的 NotWired 占位或 #556 的真 Writer）；没给就当没写——不鲁式化。 */
  runs?: OneShotDeps['runs'];
  /** 落盘根目录（default `_tmp`）；测试给临时目录。 */
  tmpDir?: string;
  now?: () => Date;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** sessions.ts 的 SessionPortsDeps 上挂的 runner 依赖（不要把 db 也抄一份——sessions 已有 db）。 */
export type SegmentPortsDepsForSessions = Omit<SegmentPortsDeps, 'db'>;

/** 起一段 runner 会话的结果。比 Fusion 的 StartSessionResult/SessionOutput 小——是 runner 自己的形状。 */
export interface SegmentOutcome {
  /** 和 Fusion 一样：执行体自己的会话号（UUID、调用方可拿它续）。 */
  sessionId: string;
  result: OneShotResult;
  verdict: SegmentVerdict;
}

/**
 * 起一段 runner 会话。**同步返回**——等子进程跑完、拿到 OneShotResult + verdict。
 *
 * 与 Fusion 老链路 startSession 的差异：
 * - 不开 db session_runs 行（runs 表还没建；NotWired JSONL 已经记了）。
 * - 不起 worktree、不查 flow-gate（没有 Fusion 的 testCommand 链；554-2 之后才有）。
 * - 不调驱动 / 不读 .fleet-out/（runner 没有 Lead 形状）。
 *
 * 调用方拿 SegmentOutcome 自己决定后续：554-2 把 manual 的 evidence 现算、555 把 verify 的 PR 合并/退回处理。
 */
export async function launchSegment(
  input: LaunchSessionInput,
  deps: SegmentPortsDeps,
): Promise<SegmentOutcome> {
  if (deps.spawner === undefined || deps.buildCommand === undefined) {
    throw new PortError(
      SEGMENT_NOT_WIRED_CODE,
      'runner 段会话的生产 Spawner 还没接（#554-2 / #555 那一档）：还不许起',
      { retryable: false },
    );
  }
  if (deps.runs === undefined) {
    throw new PortError(SEGMENT_NOT_WIRED_CODE, 'runner 段会话没装 runs Writer（NotWired 也要装）', {
      retryable: false,
    });
  }
  const seg = input.brief.segment;
  if (!seg) {
    throw new PortError('BAD_INPUT', 'launchSegment 被调了，但 brief.segment 没给', { retryable: false });
  }
  const brief = segmentBriefFrom(input.brief);
  const cwd = input.worktreePath ?? deps.cwd;
  if (!cwd) {
    throw new PortError('BAD_INPUT', 'runner 段会话没给工作目录（worktreePath 或 deps.cwd）', {
      retryable: false,
    });
  }
  const oneShotInput: OneShotInput = {
    runId: input.runId ?? randomUUID(),
    segment: brief.kind,
    modelId: input.route.modelId,
    prompt: renderBrief(brief),
    cwd,
    timeoutMinutes: input.sessionMinutes,
  };
  const oneShotDeps: OneShotDeps = {
    spawn: deps.spawner,
    buildCommand: deps.buildCommand,
    runs: deps.runs,
    ...(deps.tmpDir !== undefined ? { tmpDir: deps.tmpDir } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };
  const result = await runOneShot(oneShotInput, oneShotDeps);
  const verdict = judgeFor(brief.kind, result);
  deps.log?.('runner 段会话起完', {
    segment: brief.kind,
    runId: result.runId,
    outcome: result.outcome,
    verdict: verdict.kind,
  });
  return { sessionId: result.runId, result, verdict };
}

function judgeFor(kind: 'scope' | 'manual' | 'verify', result: OneShotResult): SegmentVerdict {
  if (kind === 'scope') return judgeScope(result);
  if (kind === 'verify') {
    // verdictLine 默认取 stdout 的最后一行（与 segments/verify.ts 的形状一致）。
    const last =
      result.stdout
        .trim()
        .split('\n')
        .filter((l) => l.trim() !== '')
        .at(-1) ?? '';
    return judgeVerify(result, { verdictLine: last });
  }
  // manual 段：evidence（prNumber / headSha / changedFiles）必须由调用方在会话结束后现读（specs/509 第六节
  // 「验收那一遍现读，不存副本」），554-2 之后由上游那一柄交给 judgeManual。这里不调：只认「会话跑完」。
  // 调用方拿到 SegmentOutcome 后自己再调 judgeManual(result, evidence)。
  if (result.outcome !== 'done') {
    return {
      kind: 'failed',
      reason: `manual 段没跑完：outcome=${result.outcome}${result.failureReason ? `（${result.failureReason}）` : ''}`,
    };
  }
  if (result.stdout.trim() === '') {
    return {
      kind: 'failed',
      reason: 'manual 段 exit=0 但 stdout 空——没拿 brief 里那一截干活（不许拿空当跑完）',
    };
  }
  return { kind: 'ok', reason: 'manual 段会话起完（evidence 还没读——见 #554-2）' };
}
