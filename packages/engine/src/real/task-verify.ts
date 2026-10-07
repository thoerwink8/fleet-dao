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
//   diff 超过 MAX_DIFF_CHARS：回 unavailable，不截断了假装看全。
// - 有文本文件 GitHub 的文件接口没给 patch（大文件，#1308）：先用引擎镜像里的 git 补读（基线...头）；补出来超过
//   MAX_FILE_DIFF_LINES 行就只给摘要（行数、头尾各几十行），diff 里明说「这个文件太大，只给了摘要」；接口和 git 两条路都读不到
//   才回 unavailable，原因写明是哪个文件、哪一步没成，不当成通过。
// - 迁移工具生成的快照（packages/db/migrations/meta/*_snapshot.json）按生成文件处理：不逐行给，只写同一 PR 里有没有
//   对得上的迁移 sql、_journal.json、schema 改动，让验收核对对不对得上。
// - 叫停（工作流放弃、活动被取消）：ctx.signal 接进会话的看守，会话被杀；随后把取消原样抛出去。
// - 切号叫停（#59）不是叫停：挑中路由就登记（sessions.enter），切号把这一次验收停下，回 retry（不贴 failure、不算一轮），
//   工作流隔一会儿再验，选路照常选到切过去的那个池。
// - runs 里这一次验收记到这张单名下（#216）：tasks.id、单号、工作流编号经单子那一样（spec）交给 invokeVerifier，PR 号、分支
//   它本来就有；验收不分档，不带派工档。
// - 按族选路时给这一次验收预占池的名额（#757，pickRoute 的 reserve）：开跑那一行写进去时换掉；挑中了又没用上的（选路交回的
//   族对不上）、没开跑就收场的，收场时一个个放掉，放不掉只记日志（到点自己过期）。开跑时名额已经没了抛 VERIFY_NO_SLOT，
//   可以重试。

import { randomUUID } from 'node:crypto';
import { COLD_VERIFY_CONTEXT } from '@fleet-dao/conventions';
import type { RepoRef } from '@fleet-dao/github';
import { errMessage } from '@fleet-dao/shared/util';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { EngineTasks } from '../activities.ts';
import { familyPickerFrom } from '../cold-verify-pick.ts';
import { runColdVerifyForPr } from '../cold-verify-run.ts';
import { type PickRouteInput, type PickRouteResult, type PortContext, PortError } from '../ports.ts';
import type { RunsWriter } from '../runner/not-wired.ts';
import { type OneShotDeps, OneShotError, SESSION_ARTIFACT_TTL_MS } from '../runner/one-shot.ts';
import {
  type ColdVerifyInput,
  type ColdVerifyResult,
  ROUTE_RETRY_SECONDS,
  SEGMENT_STAGE,
} from '../task-contract.ts';
import { judgeUiWork, UI_UNRECOGNIZED_NOTE } from '../ui-work.ts';
import { FAMILY_ORDER, invokeVerifier } from '../verifier-invoke.ts';
import type { EngineGitHub } from './github-ports.ts';
import type { MemoryAdmissionDeps } from './memory-admission.ts';
import { mapped } from './mirror.ts';
import type { OneShotSessions, OneShotTicket } from './one-shot-sessions.ts';
import type { SegmentReservations } from './runs-writer.ts';
import { hostSegmentSpawner, resolveSegmentRoute, type SegmentSpawnerDeps } from './segment-spawner.ts';
import { sweepRunDirs } from './task-segment.ts';

/** 一次验收会话最长几分钟：验收只读 diff，比动手会话短得多。 */
export const VERIFY_MINUTES = 30;
/** 喂给验收会话的 diff 最多多少字符（约 8 万 token）；再大一次看不全，要人看。 */
export const MAX_DIFF_CHARS = 240_000;
/** 补读来的单个文件 diff 最多多少行；超过只给摘要。 */
export const MAX_FILE_DIFF_LINES = 2_000;
/** 摘要里头、尾各给多少行。 */
export const SUMMARY_EDGE_LINES = 40;
/** 摘要里每行最多多少字符（防一行压缩过的超长内容撑爆提示词）。 */
export const SUMMARY_LINE_CHARS = 300;
/** 迁移工具生成的快照：按生成文件处理，不逐行给。 */
const GENERATED_SNAPSHOT = /^packages\/db\/migrations\/meta\/([^/]+)_snapshot\.json$/;
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
  /** 选路时预占的名额（#757）：没开跑就收场的、挑中了没用上的，收场时放掉（runs-writer.ts 的 realReservations）。 */
  reservations: SegmentReservations;
  memoryAdmission?: MemoryAdmissionDeps;
  /** one-shot 落盘的根（<引擎状态目录>/runs）。 */
  runsDir: string;
  /** 一次性会话的登记（#59，real/one-shot-sessions.ts）：切号照它停下这一次验收。不给 = 停不下，切号等它跑完。 */
  sessions?: OneShotSessions;
  timeoutMinutes?: number;
  maxDiffChars?: number;
  /**
   * 文件接口没给 patch 的文件，用 git 补读它的 `基线...头` diff（生产：mirrorFileDiff，读引擎镜像）。
   * 不给 = 补不了，这样的文件照旧回 unavailable。
   */
  fileDiff?: FileDiffReader;
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

/** 补读一个文件的 diff：回从第一个 `@@` 起的 unified patch；读不到抛。 */
export type FileDiffReader = (input: {
  repo: RepoRef;
  branch: string;
  baseSha: string;
  headSha: string;
  /** 改名的给改名前后两个路径。 */
  paths: string[];
  signal: AbortSignal;
}) => Promise<string>;

/** 生产的补读：把基线（主线）和 PR 分支的头抓进引擎镜像，再在镜像里 `git diff 基线...头 -- 路径`。 */
export function mirrorFileDiff(
  gh: Pick<EngineGitHub, 'fetchMainline' | 'fetchBranchHead' | 'readFileDiff'>,
): FileDiffReader {
  return async ({ repo, branch, baseSha, headSha, paths, signal }) => {
    await mapped(() => gh.fetchMainline({ repo, signal }));
    await mapped(() => gh.fetchBranchHead({ repo, branch, signal }));
    const read = await mapped(() => gh.readFileDiff({ repo, baseSha, headSha, paths, signal }));
    return read.patch;
  };
}

const refOf = (repo: { owner: string; name: string }): RepoRef => ({ owner: repo.owner, name: repo.name });
const short = (sha: string) => sha.slice(0, 7);

/** 太大的 unified patch → 摘要：改动行数、头尾各 SUMMARY_EDGE_LINES 行、中间省了多少行，开头明说只给了摘要。 */
export function summarizePatch(patch: string): string {
  const lines = patch.split('\n');
  const added = lines.filter((l) => l.startsWith('+')).length;
  const removed = lines.filter((l) => l.startsWith('-')).length;
  const clip = (l: string) => (l.length > SUMMARY_LINE_CHARS ? `${l.slice(0, SUMMARY_LINE_CHARS)}…` : l);
  const head = lines.slice(0, SUMMARY_EDGE_LINES).map(clip);
  const tail = lines.slice(-SUMMARY_EDGE_LINES).map(clip);
  const skipped = lines.length - head.length - tail.length;
  return [
    `（这个文件太大，只给了摘要：diff 共 ${lines.length} 行，其中加 ${added} 行、删 ${removed} 行；下面是头 ${head.length} 行和尾 ${tail.length} 行，中间省略 ${skipped} 行。摘要里看不到的部分不能当成没做到，也不要凭它挑毛病。）`,
    ...head,
    `…（省略 ${skipped} 行）…`,
    ...tail,
  ].join('\n');
}

/** 生成文件（迁移快照）的说明：不逐行给，列出同一 PR 里和它配套的改动，让验收核对对不对得上。 */
function generatedSnapshotNote(f: DiffFile, all: readonly DiffFile[]): string {
  const num = GENERATED_SNAPSHOT.exec(f.filename)?.[1] ?? '';
  const names = (pred: (name: string) => boolean) =>
    all
      .map((g) => g.filename)
      .filter(pred)
      .join('、');
  const sql = names((n) => new RegExp(`^packages/db/migrations/${num}_[^/]+\\.sql$`).test(n));
  const journal = all.some((g) => g.filename === 'packages/db/migrations/meta/_journal.json');
  const schema = names((n) => n.startsWith('packages/db/src/schema/'));
  return [
    `（生成文件：迁移工具生成的快照，改了 ${f.changes ?? '不知道多少'} 行，不逐行给，也不要逐行看。只核对它和同一 PR 里 schema 的改动对得上（文件名和迁移编号）。`,
    `同一 PR 里：编号 ${num} 的迁移 sql ${sql || '没有（对不上，要查）'}；_journal.json ${journal ? '改了' : '没改（对不上，要查）'}；schema（packages/db/src/schema/）改动 ${schema || '没有（对不上，要查）'}。）`,
  ].join('\n');
}

/**
 * 文件接口没给 patch 的文本文件，用 git 补读；补出来超过 MAX_FILE_DIFF_LINES 行就换成摘要。
 * 生成文件（迁移快照）不读，二进制 / 纯改名（changes 为 0）也不读。读不到抛，写明是哪个文件、哪一步没成。
 */
export async function fillMissingPatches(
  files: readonly DiffFile[],
  read: ((paths: string[]) => Promise<string>) | undefined,
  beat: () => void = () => undefined,
): Promise<DiffFile[]> {
  const out: DiffFile[] = [];
  for (const f of files) {
    if (f.patch !== undefined || f.changes === 0 || GENERATED_SNAPSHOT.test(f.filename)) {
      out.push(f);
      continue;
    }
    const gone = `文件 ${f.filename} 的 diff GitHub 没给（改了 ${f.changes ?? '不知道多少'} 行，多半是文件太大）`;
    if (read === undefined) {
      throw new Error(`${gone}，也没有用 git 补读的办法：验收看不全，不截断了假装看全`);
    }
    beat();
    let patch: string;
    try {
      patch = await read(f.previous === undefined ? [f.filename] : [f.previous, f.filename]);
    } catch (error) {
      throw new Error(`${gone}，用 git 补读也失败了（${errMessage(error)}）：验收看不全，不当成通过`);
    }
    if (patch.trim() === '') {
      throw new Error(`${gone}，用 git 补读回来的是空的（和 GitHub 说的改动对不上）：验收看不全，不当成通过`);
    }
    out.push({
      ...f,
      patch: patch.split('\n').length > MAX_FILE_DIFF_LINES ? summarizePatch(patch) : patch,
    });
  }
  return out;
}

/**
 * PR 改到的文件 → 喂给验收会话的 unified diff 和文件名单。
 * 看不全就抛（不截断）：有文本文件 GitHub 没给 diff（太大；要先过 fillMissingPatches 补读）、总长超过上限。二进制、纯改名、
 * 只改权限的文件没有文本改动，注明一句，不算看不全（GitHub 对它们回的 changes 是 0）。迁移快照按生成文件写一段说明。
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
    if (GENERATED_SNAPSHOT.test(f.filename)) body = generatedSnapshotNote(f, files);
    else if (f.patch !== undefined) body = f.patch;
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

    // 界面活（改到页面代码，或没认出）：选路带 uiWork，GPT 不派（含审界面）；没认出的要在结论 notes 里写明
    const ui = judgeUiWork(files.map((f) => f.filename));
    if (ui.uiWork) log('验收按界面活选路（GPT 不派）', { prNumber, recognized: ui.recognized, why: ui.why });
    const withUiNote = (result: ColdVerifyResult): ColdVerifyResult =>
      ui.recognized
        ? result
        : {
            ...result,
            notes: result.notes ? `${result.notes}；${UI_UNRECOGNIZED_NOTE}` : UI_UNRECOGNIZED_NOTE,
          };

    const seen: Seen = {};
    const waits: PickWait[] = [];
    // 选路给这一次验收预占的名额（#757）：每挑中一次记下，收场（下面的 finally）一个个放掉，开跑了的放一次什么都不做
    const reservations: string[] = [];
    const picker = familyPickerFrom(
      async (pickInput) => {
        const got = await deps.pickRoute({ ...pickInput, reserve: { segment: 'verify' } }, ctx);
        if (got.ok && got.route.reservationId) reservations.push(got.route.reservationId);
        return got;
      },
      FAMILY_ORDER,
      SEGMENT_STAGE.verify,
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
      ui.uiWork,
    )(input.taskId);
    // 挑中路由就登记（#59）：切号照它停下这一次验收；收场（下面的 finally）走
    let ticket: OneShotTicket | undefined;
    // 挑中路由时补上切号叫停的信号（挑之前不知道跑在哪个池）
    const oneShot: OneShotDeps = {
      spawn: (cmd) => {
        ticket?.running();
        return spawn({ ...cmd, signal: AbortSignal.any([cmd.signal, ctx.signal]) });
      },
      ...(deps.memoryAdmission ? { memoryAdmission: deps.memoryAdmission } : {}),
      tmpDir: deps.runsDir,
      runs: deps.runs,
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
          diff: async () => {
            const { fileDiff } = deps;
            const complete = await fillMissingPatches(
              files,
              fileDiff
                ? (paths) =>
                    fileDiff({
                      repo,
                      branch: input.branch,
                      baseSha: input.baseSha,
                      headSha: input.headSha,
                      paths,
                      signal: ctx.signal,
                    })
                : undefined,
              () => ctx.heartbeat(),
            );
            return renderDiff(complete, maxDiffChars);
          },
          spec: async () => {
            if (input.what.trim() === '') throw new Error('单子的「要什么」是空的');
            if (input.howToFinish.length === 0) throw new Error('单子的「怎么算做完」一条都没有');
            return {
              taskId: input.taskId,
              issueNumber: input.issueNumber,
              workflowId: ctx.workflowId ?? taskWorkflowId(input.repo, input.issueNumber),
              what: input.what,
              howToFinish: input.howToFinish,
            };
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
            // 预占的名额过期了、空位给了别的单（#757）：会话没起，过一会儿重新选路再验
            if (error instanceof OneShotError && error.code === 'NO_SLOT') {
              seen.transient = new PortError('VERIFY_NO_SLOT', error.message, { retryable: true });
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
            ticket = deps.sessions.enter({
              poolId: route.poolId,
              stage: SEGMENT_STAGE.verify,
              taskId: input.taskId,
            });
            ticket.attempt(runId);
            oneShot.stop = ticket.signal;
          }
          return {
            modelId: route.modelId,
            ...(route.poolId ? { channel: route.poolId } : {}),
            routeId: route.routeId,
            runId,
            ...(route.reservationId ? { reservationId: route.reservationId } : {}),
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
                log('验收会话的空目录没删掉（引擎下次起来时的清理会收）', { dir, error: errMessage(error) });
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
      for (const reservationId of reservations) {
        await deps.reservations.release(reservationId).catch((error: unknown) => {
          log('选路时给验收预占的池的名额没放掉（最多占到预占过期，到点自己不算）', {
            reservationId,
            error: errMessage(error),
          });
        });
      }
    }
    // 叫停：取消原样往外抛，不回「没跑成」
    if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error('被叫停了');
    void sweepRunDirs(deps.runsDir, now(), SESSION_ARTIFACT_TTL_MS, log);
    if (seen.transient) throw seen.transient;

    // 2. 把结局整理成工作流要的形状
    if (run.sourceProblem !== undefined) {
      if (seen.headMoved !== undefined)
        return { pass: false, problems: [], round, headMoved: seen.headMoved };
      return withUiNote({ pass: false, problems: [], round, unavailable: run.sourceProblem });
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
      return withUiNote({
        pass: false,
        problems: [],
        round,
        unavailable: '验收说没过，却没有写出任何一条问题：没法交给写代码的会话去改，要人看',
      });
    }
    return withUiNote({
      pass: verdict.pass,
      problems: verdict.problems,
      round: verdict.round,
      ...(verdict.notes === undefined ? {} : { notes: verdict.notes }),
    });
  };
}
