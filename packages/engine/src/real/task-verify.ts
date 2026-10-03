// 任务工作流的冷验收（coldVerify，#632 S2-5b；specs/555）：合并之前，对 PR 当前的头起一次换了家族的无头会话，
// 只给它 diff、需求原文、验收条，结论贴成 PR 头上的 cold-verify 提交状态（合并闸认的那条，packages/conventions/src/merge-gate.ts）。
// 取三样、换家族、起会话、贴状态的顺序在 cold-verify-run.ts，会话本体在 verifier-invoke.ts；这里只把它们接上生产的真东西：
// GitHub 的 PR 和文件、选路（pickRoute）、生产 Spawner、会话用户的临时目录、runs 记账，并把结局整理成工作流要的形状。
//
// 改这里之前必须知道：
// - 结论只有引擎机器人贴的 cold-verify 才算数：没贴上、贴在旧头上都等于没验。所以开跑前先贴 pending（贴不上就不起会话），
//   会话跑完贴 success / failure；贴不上抛错，工作流按失败分流处理，不当成验过。
// - 「做不出来」和「没过」是两回事：读不到 PR 或 diff、diff 太大、没有别家的模型、会话没跑成、结论认不出，一律回 unavailable
//   （工作流停下报人，不让写代码的会话白改一轮）；只有会话跑成、写出了算挡的问题才回 pass: false 加 problems。
// - 过一会儿就行的（没空位、内存放不下、额度要等、引擎在停机）回 retry，工作流隔一会儿再来，不算一轮、不报人。
//   选路回「一条能用的都没有」（waitFor 为 none）不算这一类：等也等不来。
// - PR 的头不是要验的那个了（有人推过新提交）回 headMoved，工作流对新的头重走一遍。
// - 读 GitHub 先于一切、在 runColdVerifyForPr 外面做：GitHub 一时不通是 PortError（工作流按失败分流重试），不是「读不到 PR」那种要报人的结论。
// - 验收会话手上没有仓库的检出：只给一个空的临时目录（归那条路由的会话用户，会话收场就删），diff 全在提示词里。
//   diff 超过 MAX_DIFF_CHARS、或有文本文件 GitHub 没给 diff：回 unavailable，不截断了假装看全。
// - 叫停（工作流放弃、活动被取消）：ctx.signal 接进会话的看守，会话被杀；随后把取消原样抛出去。
// - 切号叫停（#59）不是叫停：挑中路由就登记（sessions.enter），切号把这一次验收停下，回 retry（不贴 failure、不算一轮），
//   工作流隔一会儿再验，选路照常选到切过去的那个池。

import { randomUUID } from 'node:crypto';
import { COLD_VERIFY_CONTEXT } from '@fleet-dao/conventions';
import type { RepoRef } from '@fleet-dao/github';
import type { EngineTasks } from '../activities.ts';
import { familyPickerFrom } from '../cold-verify-pick.ts';
import { runColdVerifyForPr } from '../cold-verify-run.ts';
import { type PickRouteInput, type PickRouteResult, type PortContext, PortError } from '../ports.ts';
import type { RunRecord, RunStart, RunsWriter } from '../runner/not-wired.ts';
import { type OneShotDeps, OneShotError, SESSION_ARTIFACT_TTL_MS } from '../runner/one-shot.ts';
import { type ColdVerifyInput, type ColdVerifyResult, ROUTE_RETRY_SECONDS } from '../task-contract.ts';
import { FAMILY_ORDER, invokeVerifier } from '../verifier-invoke.ts';
import type { EngineGitHub } from './github-ports.ts';
import type { MemoryAdmissionDeps } from './memory-admission.ts';
import { mapped } from './mirror.ts';
import type { OneShotSessions, OneShotTicket } from './one-shot-sessions.ts';
import { hostSegmentSpawner, resolveSegmentRoute, type SegmentSpawnerDeps } from './segment-spawner.ts';
import { sweepRunDirs } from './task-segment.ts';

/** 一次验收会话最长几分钟：验收只读 diff，比动手会话短得多。 */
export const VERIFY_MINUTES = 30;
/** 喂给验收会话的 diff 最多多少字符（约 8 万 token）；再大一次看不全，要人看。 */
export const MAX_DIFF_CHARS = 240_000;
/** 会话跑着时多久报一次活着（远小于心跳超时）。 */
export const VERIFY_HEARTBEAT_MS = 15_000;
/** 内存放不下新会话时，隔多久再来（秒）。 */
export const VERIFY_ADMISSION_RETRY_SECONDS = 60;
/** 切号停下了这一次验收（#59），隔多久再验（秒）：切号停派十几秒、切完下一轮探针探过才派得到切过去的池。 */
export const VERIFY_ORG_SWITCH_RETRY_SECONDS = 30;

export interface ColdVerifyActivityDeps {
  /** 读 PR、读改到的文件、贴提交状态（引擎机器人）。 */
  gh: Pick<EngineGitHub, 'pullFiles' | 'claims'>;
  /** 选路（store-ports 的 pickRoute）：按族问「这一族此刻有没有能派的路由」。 */
  pickRoute: (input: PickRouteInput, ctx: PortContext) => Promise<PickRouteResult>;
  /** 生产 Spawner 要的东西（路由查询、各家执行方式的驱动、会话临时目录、资源上限）；会话用户的空目录也经它的 trees 备。 */
  spawner: SegmentSpawnerDeps;
  runs: RunsWriter;
  memoryAdmission?: MemoryAdmissionDeps;
  /** one-shot 落盘的根（<引擎状态目录>/runs）。 */
  runsDir: string;
  /** 一次性会话的登记（#59，real/one-shot-sessions.ts）：切号照它停下这一次验收。不给 = 停不下，切号等它跑完。 */
  sessions?: OneShotSessions;
  timeoutMinutes?: number;
  maxDiffChars?: number;
  now?: () => Date;
  /** 以下测试用。 */
  newRunId?: () => string;
  heartbeatEveryMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

/** 改到的文件，GitHub 给的样子（packages/github 的 PrFile）。 */
export interface DiffFile {
  filename: string;
  status: string;
  patch?: string;
  previous?: string;
  changes?: number;
}

const refOf = (repo: { owner: string; name: string }): RepoRef => ({ owner: repo.owner, name: repo.name });
const short = (sha: string) => sha.slice(0, 7);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * PR 改到的文件 → 喂给验收会话的 unified diff 和文件名单。
 * 看不全就抛（不截断）：有文本文件 GitHub 没给 diff（太大）、总长超过上限。二进制、纯改名、只改权限的文件没有文本改动，
 * 注明一句，不算看不全（GitHub 对它们回的 changes 是 0）。
 */
export function renderDiff(
  files: readonly DiffFile[],
  maxChars: number = MAX_DIFF_CHARS,
): { diffText: string; changedFiles: string[] } {
  const parts: string[] = [];
  let total = 0;
  for (const f of files) {
    const before = f.previous ?? f.filename;
    const head = [
      `diff --git a/${before} b/${f.filename}`,
      ...(f.status === 'renamed' && f.previous !== undefined
        ? [`rename from ${f.previous}`, `rename to ${f.filename}`]
        : []),
      f.status === 'added' ? '--- /dev/null' : `--- a/${before}`,
      f.status === 'removed' ? '+++ /dev/null' : `+++ b/${f.filename}`,
    ];
    let body: string;
    if (f.patch !== undefined) body = f.patch;
    else if (f.changes === 0) body = '（没有文本改动：二进制文件、纯改名或只改了权限）';
    else {
      throw new Error(
        `文件 ${f.filename} 的 diff GitHub 没给（改了 ${f.changes ?? '不知道多少'} 行，多半是文件太大）：验收看不全，不截断了假装看全`,
      );
    }
    const piece = `${head.join('\n')}\n${body}`;
    total += piece.length + 1;
    if (total > maxChars) {
      throw new Error(
        `diff 太大（超过 ${maxChars} 个字符，已经看了 ${parts.length + 1}/${files.length} 个文件）：一次验收看不全，不截断了假装看全`,
      );
    }
    parts.push(piece);
  }
  return { diffText: parts.join('\n'), changedFiles: files.map((f) => f.filename) };
}

/** 选路回「过一会儿再来」的那几次（按族问，每族一条）。 */
interface PickWait {
  family: string;
  waitFor: 'slot' | 'quota';
  detail: string;
  retryAfterSeconds?: number | undefined;
}

/** 这一次执行里闭包回调留下的东西（用对象装着：闭包里赋的值，外面的类型收窄看不见）。 */
interface Seen {
  /** 读到 PR 的头已经不是要验的那个了：现在的头。 */
  headMoved?: string;
  /** 抛过「重试有用」的 PortError（GitHub 一时不通、目录交不出去）：跑完往外抛，让工作流按失败分流重试。 */
  transient?: PortError;
  /** 内存放不下没派出去。 */
  admission?: boolean;
  /** 切号停下了这一次验收（#59）。 */
  orgSwitch?: boolean;
}

export function createColdVerify(deps: ColdVerifyActivityDeps): NonNullable<EngineTasks['coldVerify']> {
  const now = deps.now ?? (() => new Date());
  const newRunId = deps.newRunId ?? (() => randomUUID());
  const heartbeatEveryMs = deps.heartbeatEveryMs ?? VERIFY_HEARTBEAT_MS;
  const maxDiffChars = deps.maxDiffChars ?? MAX_DIFF_CHARS;
  const log = deps.log ?? (() => undefined);
  const spawn = hostSegmentSpawner(deps.spawner);

  return async (input: ColdVerifyInput, ctx: PortContext): Promise<ColdVerifyResult> => {
    ctx.heartbeat();
    const repo = refOf(input.repo);
    const { prNumber, round } = input;

    // 1. 读 GitHub（先于一切、在 runColdVerifyForPr 外面）：不通是 PortError，工作流按失败分流重试。
    const pull = await mapped(() => deps.gh.claims.readPull(repo, prNumber));
    const files = await mapped(() => deps.gh.pullFiles({ repo, prNumber, signal: ctx.signal }));
    ctx.heartbeat();

    const seen: Seen = {};
    const waits: PickWait[] = [];
    const picker = familyPickerFrom(
      (pickInput) => deps.pickRoute(pickInput, ctx),
      FAMILY_ORDER,
      'review',
      (family, why) => {
        if (why.waitFor !== 'none') {
          waits.push({
            family,
            waitFor: why.waitFor,
            detail: why.detail,
            retryAfterSeconds: why.retryAfterSeconds,
          });
        }
      },
    )(input.taskId);
    // 挑中路由就登记（#59）：切号照它停下这一次验收；收场（下面的 finally）走
    let ticket: OneShotTicket | undefined;
    // 验收的会话记到这张单名下（invokeVerifier 不知道单号）
    const runs: RunsWriter = {
      ...(deps.runs.notWired === undefined ? {} : { notWired: deps.runs.notWired }),
      start: (run: RunStart) =>
        deps.runs.start({ ...run, issueNumber: run.issueNumber ?? input.issueNumber }),
      record: (run: RunRecord) =>
        deps.runs.record({ ...run, issueNumber: run.issueNumber ?? input.issueNumber }),
    };
    // 挑中路由时补上切号叫停的信号（挑之前不知道跑在哪个池）
    const oneShot: OneShotDeps = {
      spawn: (cmd) => spawn({ ...cmd, signal: AbortSignal.any([cmd.signal, ctx.signal]) }),
      ...(deps.memoryAdmission ? { memoryAdmission: deps.memoryAdmission } : {}),
      tmpDir: deps.runsDir,
      runs,
      now,
    };

    const retryFor = (reason: string): NonNullable<ColdVerifyResult['retry']> => {
      if (seen.orgSwitch) return { wait: 'slot', reason, afterSeconds: VERIFY_ORG_SWITCH_RETRY_SECONDS };
      if (seen.admission) return { wait: 'slot', reason, afterSeconds: VERIFY_ADMISSION_RETRY_SECONDS };
      const slot = waits.filter((w) => w.waitFor === 'slot');
      const pool = slot.length > 0 ? slot : waits;
      return {
        wait: slot.length > 0 ? 'slot' : 'quota',
        reason,
        afterSeconds: Math.min(...pool.map((w) => w.retryAfterSeconds ?? ROUTE_RETRY_SECONDS)),
      };
    };

    const beat = setInterval(() => ctx.heartbeat(), heartbeatEveryMs);
    let run: Awaited<ReturnType<typeof runColdVerifyForPr>>;
    try {
      run = await runColdVerifyForPr(prNumber, {
        sources: {
          pr: async () => {
            if (pull.state !== 'open') {
              throw new Error(`PR #${prNumber} ${pull.merged ? '已经合并' : '已经关闭'}了，没有要验的头`);
            }
            if (pull.headSha !== input.headSha) {
              seen.headMoved = pull.headSha;
              throw new Error(
                `PR #${prNumber} 的头是 ${short(pull.headSha)}，不是要验的 ${short(input.headSha)}（有人推过新提交）`,
              );
            }
            return { head: input.headSha, baseSha: input.baseSha, branch: input.branch };
          },
          diff: async () => renderDiff(files, maxDiffChars),
          spec: async () => {
            if (input.what.trim() === '') throw new Error('单子的「要什么」是空的');
            if (input.howToFinish.length === 0) throw new Error('单子的「怎么算做完」一条都没有');
            return { taskId: input.taskId, what: input.what, howToFinish: input.howToFinish };
          },
          authorFamilies: async () => input.authorFamilies,
        },
        invoke: async (verifierInput, verifierDeps) => {
          try {
            return await invokeVerifier(verifierInput, verifierDeps);
          } catch (error) {
            if (error instanceof PortError && error.retryable) seen.transient = error;
            // 开跑那一行写不进 runs（#157）：会话没起，库一时不通，过一会儿再验（不是「验收做不出来」）
            if (error instanceof OneShotError && error.code === 'RUN_START_FAILED') {
              seen.transient = new PortError('VERIFY_RUNS_UNWRITABLE', error.message, { retryable: true });
            }
            throw error;
          }
        },
        oneShot,
        chooseModelForFamily: async (family) => {
          const route = await picker.pickRouteForFamily(family);
          if (route === undefined) return undefined;
          // 这一次的编号挑中时就定下、交给登记：起会话之前（备目录那一下）被切号停下，操作记录 stopped 里写的就是
          // 随后记成 org_switch 的那一行
          const runId = randomUUID();
          if (deps.sessions) {
            ticket?.leave();
            ticket = deps.sessions.enter({ poolId: route.poolId });
            ticket.attempt(runId);
            oneShot.stop = ticket.signal;
          }
          return {
            modelId: route.modelId,
            ...(route.poolId ? { channel: route.poolId } : {}),
            routeId: route.routeId,
            runId,
          };
        },
        // 会话的工作目录由 prepareCwd 备（挑完路由才知道归哪个会话用户）；这个只是占个位，不会被用到
        cwd: deps.runsDir,
        prepareCwd: async (picked) => {
          const { user } = await resolveSegmentRoute(deps.spawner, picked.routeId);
          const dir = deps.spawner.trees.tmpFor(`verify-${newRunId()}`);
          await deps.spawner.trees.adopt(dir, user);
          return {
            cwd: dir,
            release: async () => {
              await deps.spawner.trees.remove(dir).catch((error: unknown) => {
                log('验收会话的空目录没删掉（引擎下次起来时的清理会收）', { dir, error: message(error) });
              });
            },
          };
        },
        writeStatus: async ({ head, status }) => {
          await mapped(() =>
            deps.gh.claims.setStatus(repo, head, {
              context: COLD_VERIFY_CONTEXT,
              state: status.state,
              description: status.description,
            }),
          );
        },
        round,
        timeoutMinutes: deps.timeoutMinutes ?? VERIFY_MINUTES,
        waitReason: (verdict) => {
          if (verdict.session?.outcome === 'org_switch') {
            seen.orgSwitch = true;
            return '切号：这一次验收先停下，切完重验';
          }
          if (verdict.session?.outcome === 'admission_blocked') {
            seen.admission = true;
            return '机器内存放不下新会话';
          }
          if (
            verdict.session === undefined &&
            waits.length > 0 &&
            verdict.problems.some((p) => p.startsWith('没讨论成：'))
          ) {
            return `这会儿没有能派的验收路由：${waits.map((w) => `${w.family}（${w.detail}）`).join('；')}`;
          }
          return undefined;
        },
      });
    } finally {
      clearInterval(beat);
      ticket?.leave();
    }
    // 叫停：取消原样往外抛，不回「没跑成」
    if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('被叫停了');
    void sweepRunDirs(deps.runsDir, now(), SESSION_ARTIFACT_TTL_MS, log);
    if (seen.transient) throw seen.transient;

    // 2. 把结局整理成工作流要的形状
    if (run.sourceProblem !== undefined) {
      if (seen.headMoved !== undefined)
        return { pass: false, problems: [], round, headMoved: seen.headMoved };
      return { pass: false, problems: [], round, unavailable: run.sourceProblem };
    }
    if (run.wait !== undefined) return { pass: false, problems: [], round, retry: retryFor(run.wait) };
    const verdict = run.verdict;
    if (verdict === undefined) {
      // 读得到、没在等、也没有结论：不会发生；真发生了是这一层自己的毛病，明说，不当成过
      throw new PortError(
        'COLD_VERIFY_NO_VERDICT',
        '验收既没读不成、也不是在等，却没有结论（装配层的毛病）',
        {
          retryable: false,
        },
      );
    }
    if (!verdict.pass && verdict.problems.length === 0) {
      return {
        pass: false,
        problems: [],
        round,
        unavailable: '验收说没过，却没有写出任何一条问题：没法交给写代码的会话去改，要人看',
      };
    }
    return {
      pass: verdict.pass,
      problems: verdict.problems,
      round: verdict.round,
      ...(verdict.notes === undefined ? {} : { notes: verdict.notes }),
    };
  };
}
