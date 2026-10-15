// 任务工作流的冷验收（coldVerify，#632 S2-5b；specs/555）：合并之前，对 PR 当前的头起一次换了家族的无头会话，
// 只给它 diff、需求原文、验收条，结论贴成 PR 头上的 cold-verify 提交状态（合并闸认的那条，packages/conventions/src/merge-gate.ts）。
// 取三样、换家族、起会话、贴状态的顺序在 cold-verify-run.ts，会话本体在 verifier-invoke.ts；这里只把它们接上生产的真东西：
// GitHub 的 PR 和文件、选路（pickRoute）、生产 Spawner、会话用户的临时目录、runs 记账，并把结局整理成工作流要的形状。
//
// 改这里之前必须知道：
// - 结论只有引擎机器人贴的 cold-verify 才算数：没贴上、贴在旧头上都等于没验。所以开跑前先贴 pending（贴不上就不起会话），
//   会话跑完贴 success / failure；贴不上抛错，工作流按失败分流处理，不当成验过。
// - 「做不出来」和「没过」是两回事：读不到 PR、一个文件的 diff 都看不到、所有候选（含作者族的同族兜底验）都试过还没验成，
//   回 unavailable（工作流停下报人，不让写代码的会话白改一轮）；只有会话跑成、写出了算挡的问题才回 pass: false 加 problems。
// - 材料（决定 0093）：diff、需求原文之外，PR 正文和引擎跑过的测试输出（有才给）也交给验收。只要求测试、检查、
//   构建或类型检查通过的验收条归合并闸的 CI，不因这份输出里没出现它判不过；输出里明确写了失败才写成问题
//   （判法在 verifier-invoke 的提示词里）。验收回的「不归我验」（要截图、
//   现场、线上数据、审计结果才判得了的验收条）不算没过、不回炉：这里留言到单上转给人（指挥官），结论里带 outOfScope。
//   会话没跑成（额度用完、超时、结论认不出……）先换下一条路由、下一族再验（verifier-invoke.ts，#1731），试遍了才 unavailable，
//   说明里列出试过的路由和原因。
// - 过一会儿就行的（没空位、内存放不下、额度要等、引擎在停机、上游临时故障、一个验收模型都派不出）回 retry，工作流隔一会儿再来，
//   不算一轮、不报人。上游临时故障认的是失败分流规则表上标了 blip 的那些（容量满、503、限流、连接被重置），不在这里另写关键词。
//   一个模型都派不出（每一族选路都回「一条能用的都没有」，#1731）也按这一类：隔 ROUTE_RETRY_SECONDS 再来，不停下等人。
// - PR 的头不是要验的那个了（有人推过新提交）回 headMoved，工作流对新的头重走一遍。引擎推完马上就来验（和等 CI 同时起），
//   GitHub 改 PR 的头是异步的、比推送晚一两秒：读到的头对不上先隔 HEAD_SETTLE_WAIT_MS 再读，读满 HEAD_SETTLE_READS 次还对不上
//   才算有人推过（#2181：推完 0.1 秒就读到推之前的头，判成「头被别人改了」停下等人两个多小时）。
// - 读 GitHub 先于一切、在 runColdVerifyForPr 外面做：GitHub 一时不通是 PortError（工作流按失败分流重试），不是「读不到 PR」那种要报人的结论。
// - 验收会话手上没有仓库的检出：只给一个空的临时目录（归那条路由的会话用户，会话收场就删），diff 全在提示词里。
//   diff 超过 MAX_DIFF_CHARS：放不下的文件跳过并写明，不截断了假装看全。
// - 有文本文件 GitHub 的文件接口没给 patch（大文件，#1308）：先用引擎镜像里的 git 补读（基线...头）；补出来超过
//   MAX_FILE_DIFF_LINES 行就只给摘要（行数、头尾各几十行），diff 里明说「这个文件太大，只给了摘要」；接口和 git 两条路都读不到、
//   或加上它总长超过 MAX_DIFF_CHARS 的，这个文件跳过：diff 里写明「跳过：原因」，验收不凭它挡也不凭它放，只靠它才判得了的
//   验收条回「不归我验」转给人。每个有文本改动的文件都跳过了（一点内容都看不到）才回 unavailable。
// - 迁移工具生成的快照（packages/db/migrations/meta/*_snapshot.json）按生成文件处理：不逐行给，只写同一 PR 里有没有
//   对得上的迁移 sql、_journal.json、schema 改动，让验收核对对不对得上。
// - 叫停（工作流放弃、活动被取消）：ctx.signal 接进会话的看守，会话被杀；随后把取消原样抛出去。
// - 切号叫停（#59）不是叫停：起会话前（prepareCwd 那一下）登记（sessions.enter），切号把这一次验收停下，回 retry（不贴 failure、不算一轮），
//   工作流隔一会儿再验，选路照常选到切过去的那个池。
// - runs 里这一次验收记到这张单名下（#216）：tasks.id、单号、工作流编号经单子那一样（spec）交给 invokeVerifier，PR 号、分支
//   它本来就有；验收不分档，不带派工档。
// - 按族选路时给这一次验收预占池的名额（#757，pickRoute 的 reserve）：开跑那一行写进去时换掉；挑中了又没用上的（选路交回的
//   族对不上；两家都验只挑到一家、另一家在等，#1697）、没开跑就收场的，收场时一个个放掉，放不掉只记日志（到点自己过期）。开跑时名额已经没了抛 VERIFY_NO_SLOT，
//   可以重试。

import { randomUUID } from 'node:crypto';
import { COLD_VERIFY_CONTEXT } from '@fleet-dao/conventions';
import type { GitHub, RepoRef } from '@fleet-dao/github';
import { errMessage } from '@fleet-dao/shared/util';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import type { EngineTasks } from '../activities.ts';
import { familyPickerFrom } from '../cold-verify-pick.ts';
import { runColdVerifyForPr } from '../cold-verify-run.ts';
import { createStatusMemo } from '../cold-verify-status.ts';
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
import { type AssignedProber, createProbeBudget } from './pick-then-probe.ts';
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
/** PR 的头对不上要验的那个时最多读几次（含第一次）：GitHub 推完到 PR 换头一般一两秒，读 5 次、隔 2 秒，最多多等 8 秒。 */
export const HEAD_SETTLE_READS = 5;
/** 两次读之间隔多久。 */
export const HEAD_SETTLE_WAIT_MS = 2_000;
/** 内存放不下新会话时，隔多久再来（秒）。 */
export const VERIFY_ADMISSION_RETRY_SECONDS = 60;
/** 切号停下了这一次验收（#59），隔多久再验（秒）：切号停派十几秒、切完下一轮探针探过才派得到切过去的池。 */
export const VERIFY_ORG_SWITCH_RETRY_SECONDS = 30;
/**
 * 同一个 PR 因同一个原因（总开关关着 / 选路在等 / 内存放不下）连续等待时，重试间隔每次翻倍，封顶这么多秒（#2007）。
 * 为什么要涨：总开关关着一关几小时，固定 30 秒一圈就是一小时 120 次；每圈都动工作流、读 GitHub、占选路，白耗。
 * 为什么封在 300：开关一开、路由一通最多再等 5 分钟就接上，不让人等太久。
 * 原因变了、真派上了、或超过 VERIFY_BACKOFF_FORGET_MS 没再来（说明中间已经另走了路）就从头涨。
 */
export const VERIFY_RETRY_CAP_SECONDS = 300;
/** 每次连续等待，间隔乘几。 */
export const VERIFY_RETRY_FACTOR = 2;
/** 这么久没再等过同一个 PR，连续次数作废（上限是封顶间隔的两倍，正常的重来早到了）。 */
export const VERIFY_BACKOFF_FORGET_MS = VERIFY_RETRY_CAP_SECONDS * 2 * 1000;
/** 退避记账最多记多少个 PR（防泄漏）。 */
const VERIFY_BACKOFF_MAX_PRS = 500;

/** 第 n 次（从 1 起）连续等待该隔几秒：base 按倍数涨，封顶 VERIFY_RETRY_CAP_SECONDS（base 本身已超封顶就不动它）。 */
export function backedOffSeconds(base: number, n: number): number {
  const cap = Math.max(base, VERIFY_RETRY_CAP_SECONDS);
  return Math.min(cap, base * VERIFY_RETRY_FACTOR ** Math.max(0, n - 1));
}

export interface ColdVerifyActivityDeps {
  /**
   * 读 PR、读改到的文件、贴提交状态（引擎机器人）。commentIssue：验收回了「不归我验」时留言到单上转给人（决定 0093）；
   * 不给 = 留不了言，只写进结论的 notes。
   */
  gh: Pick<EngineGitHub, 'pullFiles' | 'claims'> & Partial<Pick<GitHub, 'commentIssue'>>;
  /** 选路（store-ports 的 pickRoute）：按族问「这一族此刻有没有能派的路由」。 */
  pickRoute: (input: PickRouteInput, ctx: PortContext) => Promise<PickRouteResult>;
  /** 生产 Spawner 要的东西（路由查询、各家执行方式的驱动、会话临时目录、资源上限）；会话用户的空目录也经它的 trees 备。 */
  spawner: SegmentSpawnerDeps;
  runs: RunsWriter;
  /** 选路时预占的名额（#757）：没开跑就收场的、挑中了没用上的，收场时放掉（runs-writer.ts 的 realReservations）。 */
  reservations: SegmentReservations;
  /**
   * 派前探测（#1798 片 4）：给了就选到一条验收路由先探一次（活动 probeAssignedRoute，15 分钟新鲜线），探不通避开它
   * 再选，一轮最多 3 条。生产由 real/index.ts 装配；不给 = 老样子（选到就交回，冷验收的老测试、还没接探针的进程）。
   */
  probe?: AssignedProber;
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
  /** 头对不上时两次读之间怎么等（默认真等 HEAD_SETTLE_WAIT_MS）。 */
  sleep?: (ms: number) => Promise<void>;
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
  /** 这个文件的 diff 读不到、放不下，跳过了：原因。diff 里只写这一句，不给内容。 */
  skipped?: string;
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
 * 生成文件（迁移快照）不读，二进制 / 纯改名（changes 为 0）也不读。读不到不抛：这个文件标「跳过」并写明是哪一步没成，
 * 验收照常看别的文件（决定 0093：读不到的快照、二进制、超大文件不该让整次验收停下等人）。
 */
export async function fillMissingPatches(
  files: readonly DiffFile[],
  read: ((paths: string[]) => Promise<string>) | undefined,
  beat: () => void = () => undefined,
): Promise<DiffFile[]> {
  const out: DiffFile[] = [];
  for (const f of files) {
    if (
      f.patch !== undefined ||
      f.changes === 0 ||
      f.skipped !== undefined ||
      GENERATED_SNAPSHOT.test(f.filename)
    ) {
      out.push(f);
      continue;
    }
    const gone = `GitHub 没给这个文件的 diff（改了 ${f.changes ?? '不知道多少'} 行，多半是文件太大）`;
    if (read === undefined) {
      out.push({ ...f, skipped: `${gone}，也没有用 git 补读的办法` });
      continue;
    }
    beat();
    let patch: string;
    try {
      patch = await read(f.previous === undefined ? [f.filename] : [f.previous, f.filename]);
    } catch (error) {
      out.push({ ...f, skipped: `${gone}，用 git 补读也失败了（${errMessage(error)}）` });
      continue;
    }
    if (patch.trim() === '') {
      out.push({ ...f, skipped: `${gone}，用 git 补读回来的是空的（和 GitHub 说的改动对不上）` });
      continue;
    }
    out.push({
      ...f,
      patch: patch.split('\n').length > MAX_FILE_DIFF_LINES ? summarizePatch(patch) : patch,
    });
  }
  return out;
}

/** 跳过的文件在 diff 里写的那一句。 */
function skippedNote(why: string): string {
  return `（跳过：${why}。这个文件的内容验收看不到：不凭它挡、也不凭它放；只靠它才判得了的验收条写进「不归我验」。）`;
}

/**
 * PR 改到的文件 → 喂给验收会话的 unified diff 和文件名单。
 * 不截断：GitHub 没给 diff 又没补读成的文件、加上它总长就超过上限的文件，整个跳过并写明原因（skipped 列出来）。
 * 二进制、纯改名、只改权限的文件没有文本改动，注明一句（GitHub 对它们回的 changes 是 0）。迁移快照按生成文件写一段说明。
 * 有文本改动的文件全被跳过（一点内容都看不到）才抛：那样验收什么都判不了。
 */
export function renderDiff(
  files: readonly DiffFile[],
  maxChars: number = MAX_DIFF_CHARS,
): { diffText: string; changedFiles: string[]; skipped: string[] } {
  const parts: string[] = [];
  const skipped: string[] = [];
  let total = 0;
  let textual = 0;
  let shown = 0;
  for (const f of files) {
    const before = f.previous ?? f.filename;
    const head = [
      `diff --git a/${before} b/${f.filename}`,
      ...(f.status === 'renamed' && f.previous !== undefined
        ? [`rename from ${f.previous}`, `rename to ${f.filename}`]
        : []),
      f.status === 'added' ? '--- /dev/null' : `--- a/${before}`,
      f.status === 'removed' ? '+++ /dev/null' : `+++ b/${f.filename}`,
    ].join('\n');
    let body: string;
    let skip: string | undefined;
    if (GENERATED_SNAPSHOT.test(f.filename)) body = generatedSnapshotNote(f, files);
    else if (f.skipped !== undefined) {
      skip = f.skipped;
      body = '';
    } else if (f.patch !== undefined) body = f.patch;
    else if (f.changes === 0) body = '（没有文本改动：二进制文件、纯改名或只改了权限）';
    else {
      skip = `GitHub 没给这个文件的 diff（改了 ${f.changes ?? '不知道多少'} 行，多半是文件太大）`;
      body = '';
    }
    const hasText = !GENERATED_SNAPSHOT.test(f.filename) && f.changes !== 0;
    if (hasText) textual += 1;
    if (skip === undefined && total + head.length + body.length + 2 > maxChars) {
      skip = `diff 太大，放不下这个文件（这个文件 ${body.length} 个字符，一次验收最多 ${maxChars} 个）`;
    }
    if (skip !== undefined) {
      skipped.push(`${f.filename}：${skip}`);
      body = skippedNote(skip);
    } else if (hasText) shown += 1;
    const piece = `${head}\n${body}`;
    total += piece.length + 1;
    parts.push(piece);
  }
  if (textual > 0 && shown === 0) {
    throw new Error(
      `改到的 ${textual} 个文件的 diff 一个都看不到（${skipped.join('；').slice(0, 600)}）：验收什么都判不了，不当成通过`,
    );
  }
  return { diffText: parts.join('\n'), changedFiles: files.map((f) => f.filename), skipped };
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
  /** 一个验收模型都派不出（#1731）：过一会儿重来。 */
  noModel?: boolean;
}

export function createColdVerify(deps: ColdVerifyActivityDeps): NonNullable<EngineTasks['coldVerify']> {
  const now = deps.now ?? (() => new Date());
  const newRunId = deps.newRunId ?? (() => randomUUID());
  const heartbeatEveryMs = deps.heartbeatEveryMs ?? VERIFY_HEARTBEAT_MS;
  const maxDiffChars = deps.maxDiffChars ?? MAX_DIFF_CHARS;
  const log = deps.log ?? (() => undefined);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const spawn = hostSegmentSpawner(deps.spawner);
  // 跨圈的内存记账（#2007，引擎重启丢了无所谓：状态最多多贴一次、间隔从头涨）：
  // 每个 PR 最后贴成功的 cold-verify 状态；每个 PR 同一原因连续等了几次。
  const statusMemo = createStatusMemo();
  const backoff = new Map<string, { reason: string; count: number; at: number }>();
  const nextBackoff = (prKey: string, reason: string, base: number): number => {
    const t = now().getTime();
    const prev = backoff.get(prKey);
    const count =
      prev !== undefined && prev.reason === reason && t - prev.at <= VERIFY_BACKOFF_FORGET_MS
        ? prev.count + 1
        : 1;
    backoff.delete(prKey);
    backoff.set(prKey, { reason, count, at: t });
    while (backoff.size > VERIFY_BACKOFF_MAX_PRS) {
      const oldest = backoff.keys().next();
      if (oldest.done) break;
      backoff.delete(oldest.value);
    }
    return backedOffSeconds(base, count);
  };

  return async (input: ColdVerifyInput, ctx: PortContext): Promise<ColdVerifyResult> => {
    ctx.heartbeat();
    const repo = refOf(input.repo);
    const { prNumber, round } = input;
    const prKey = `${repo.owner}/${repo.name}#${prNumber}`.toLowerCase();

    // 1. 读 GitHub（先于一切、在 runColdVerifyForPr 外面）：不通是 PortError，工作流按失败分流重试。
    // 头对不上先等 GitHub 把刚推的头换上去再读（见文件头）；文件也要在头对上之后读，不然拿到的是推之前的 diff。
    let pull = await mapped(() => deps.gh.claims.readPull(repo, prNumber));
    for (
      let reads = 1;
      reads < HEAD_SETTLE_READS && pull.state === 'open' && pull.headSha !== input.headSha;
      reads++
    ) {
      await sleep(HEAD_SETTLE_WAIT_MS);
      ctx.heartbeat();
      pull = await mapped(() => deps.gh.claims.readPull(repo, prNumber));
    }
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
    // 派前探测（#1798 片 4）：一轮验收最多真探 3 条，跨族共用（探通的也算名额，别每族各探 3 条）。留给探不通
    // 那几条的池名额当场放掉：没进起会话，不能占着池等到过期。
    const probeBudget = createProbeBudget();
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
      deps.probe === undefined
        ? undefined
        : {
            probe: deps.probe,
            budget: probeBudget,
            onUnprobed: async (route) => {
              if (route.reservationId === undefined) return;
              await deps.reservations.release(route.reservationId).catch((error: unknown) => {
                log('派前探测不通：这条路由预占的池名额没放掉（最多占到预占过期）', {
                  routeId: route.routeId,
                  error: errMessage(error),
                });
              });
            },
            // 三条都不通：选路回的 waitFor 是 none（选路自己不说派不出，是候选都在派前探测里被打掉）。
            // 这也要按「过一会儿重来」算（#1731），别当成「一方都派不出」的硬结论、更别报人。写进 waits 让
            // retryFor 有秒数（waitFor 收窄成 slot/quota 是为了 PickWait 的形状，这里其实是在等探针再探通）。
            onProbeFailed: () => {
              waits.push({
                family: 'probe',
                waitFor: 'slot',
                detail: '派前探测把候选都打掉了',
                retryAfterSeconds: ROUTE_RETRY_SECONDS,
              });
            },
          },
    )(input.taskId);
    // 起会话前登记（#59，prepareCwd 里）：切号照它停下这一次验收；收场（下面的 finally）走。
    // 两家并行起会话，各有各的登记：按族记最新一份（同一族换路由重验时，上一份先走），收场时全部走掉
    const tickets = new Map<string, OneShotTicket>();
    // 挑中时定下的编号 → 那条路由的池：登记要知道这一次跑在哪个池上
    const poolOfRun = new Map<string, string>();
    // 每个会话各用一份依赖：切号叫停的信号、起进程前的标记都跟着它自己的登记（挑之前不知道跑在哪个池，登记在 prepareCwd 里）
    const oneShotFor = (ticket?: OneShotTicket): OneShotDeps => ({
      spawn: (cmd) => {
        ticket?.running();
        return spawn({ ...cmd, signal: AbortSignal.any([cmd.signal, ctx.signal]) });
      },
      ...(deps.memoryAdmission ? { memoryAdmission: deps.memoryAdmission } : {}),
      tmpDir: deps.runsDir,
      runs: deps.runs,
      now,
      ...(ticket ? { stop: ticket.signal } : {}),
    });
    const oneShot = oneShotFor();

    const retryFor = (reason: string): NonNullable<ColdVerifyResult['retry']> => {
      // 切号只停十几秒，不涨间隔（也不动连续次数的记账）
      if (seen.orgSwitch) return { wait: 'slot', reason, afterSeconds: VERIFY_ORG_SWITCH_RETRY_SECONDS };
      // 其余几种「没路由 / 内存放不下」：同一原因连续等，间隔按倍数涨（#2007）。原因 = 哪一种 + 选路给的说法（总开关关着、
      // 收尾中、各族在等什么）；这些说法是固定文案，不带会变的数，所以不会每圈都被当成「原因变了」。
      if (seen.admission) {
        const afterSeconds = nextBackoff(prKey, 'admission', VERIFY_ADMISSION_RETRY_SECONDS);
        return { wait: 'slot', reason, afterSeconds };
      }
      // 一个模型都派不出、或候选都在派前探测里被打掉：选路没给过秒数，用默认的那一档
      if (seen.noModel || waits.length === 0) {
        const afterSeconds = nextBackoff(prKey, `no-model|${reason}`, ROUTE_RETRY_SECONDS);
        return { wait: 'slot', reason, afterSeconds };
      }
      const slot = waits.filter((w) => w.waitFor === 'slot');
      const pool = slot.length > 0 ? slot : waits;
      const why = [...new Set(waits.map((w) => w.detail))].sort().join('|');
      const base = Math.min(...pool.map((w) => w.retryAfterSeconds ?? ROUTE_RETRY_SECONDS));
      return {
        wait: slot.length > 0 ? 'slot' : 'quota',
        reason,
        afterSeconds: nextBackoff(prKey, `route|${why}`, base),
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
            return { head: input.headSha, baseSha: input.baseSha, branch: input.branch, body: pull.body };
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
              ...(input.testOutput === undefined ? {} : { testOutput: input.testOutput }),
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
          // 叫停了：验不成的会话不再换下一个候选起新的（#1731 会换候选重试），取消由下面原样抛出去
          if (ctx.signal.aborted) return undefined;
          const before = waits.length;
          const route = await picker.pickRouteForFamily(family);
          if (route === undefined) {
            // 选路说这一族等得来（等空位、等额度）：告诉 invokeVerifier 在等，别家没有结论时它回等待（#1697）
            const waited = waits.slice(before).find((w) => w.family === family);
            return waited === undefined ? undefined : { wait: waited.detail };
          }
          // 这一次的编号挑中时就定下，起会话前（prepareCwd）照它登记切号
          const runId = randomUUID();
          poolOfRun.set(runId, route.poolId);
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
          // 起会话前登记（#59）：两家都验时两家先挑齐再起会话，登记要跟着这一次起的那一家，不能在挑的那一下。
          // 备目录那一下被切号停下，操作记录 stopped 里写的就是随后记成 org_switch 的那一行
          const poolId = picked.runId === undefined ? undefined : poolOfRun.get(picked.runId);
          let ticket: OneShotTicket | undefined;
          if (deps.sessions && picked.runId !== undefined && poolId !== undefined) {
            tickets.get(picked.family)?.leave();
            ticket = deps.sessions.enter({ poolId, stage: SEGMENT_STAGE.verify, taskId: input.taskId });
            ticket.attempt(picked.runId);
            tickets.set(picked.family, ticket);
          }
          const { user } = await resolveSegmentRoute(deps.spawner, picked.routeId);
          const dir = deps.spawner.trees.tmpFor(`verify-${newRunId()}`);
          await deps.spawner.trees.adopt(dir, user);
          return {
            cwd: dir,
            ...(ticket ? { oneShot: oneShotFor(ticket) } : {}),
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
        statusMemo: statusMemo.scoped(prKey),
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
          if (verdict.upstreamRetry) return verdict.upstreamRetry.reason;
          // 一个模型都派不出（#1731，routeWait 里没有在等的族）：没起会话，这会儿验不了、过一会儿重来，不停下等人
          if (verdict.session === undefined && verdict.routeWait?.families.length === 0) {
            seen.noModel = true;
            return `这会儿验不了：${verdict.routeWait.reason}`;
          }
          // 要派的族在等选路（#1697）：没起会话，过一会儿重来
          if (verdict.session === undefined && verdict.routeWait !== undefined) {
            return `这会儿没有能派的验收路由：${verdict.routeWait.reason}`;
          }
          return undefined;
        },
      });
    } finally {
      clearInterval(beat);
      for (const t of tickets.values()) t.leave();
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
    // 记账收口（#2007）：PR 关了、合了，状态记忆丢掉；这一圈没在等（真派上了、或出了结论）连续等待的次数归零
    if (pull.state !== 'open') statusMemo.forget(prKey);
    if (run.wait === undefined || run.verdict?.upstreamRetry !== undefined) backoff.delete(prKey);

    // 2. 把结局整理成工作流要的形状
    if (run.sourceProblem !== undefined) {
      if (seen.headMoved !== undefined)
        return { pass: false, problems: [], round, headMoved: seen.headMoved };
      return withUiNote({ pass: false, problems: [], round, unavailable: run.sourceProblem });
    }
    if (run.wait !== undefined) {
      const again = run.verdict?.upstreamRetry;
      // 上游临时故障的等待秒数在分流表上，不走选路那一档（那一档这时是空的，算出来是无穷）。
      if (again) {
        return {
          pass: false,
          problems: [],
          round,
          retry: { wait: 'slot', reason: again.reason, afterSeconds: again.afterSeconds },
        };
      }
      return withUiNote({ pass: false, problems: [], round, retry: retryFor(run.wait) });
    }
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
    const outOfScope = verdict.outOfScope ?? [];
    const handoff =
      outOfScope.length > 0 ? await handOff(input, outOfScope, verdict.suggestions ?? []) : undefined;
    const notes = [verdict.notes, handoff].filter((n): n is string => n !== undefined && n !== '').join('；');
    return withUiNote({
      pass: verdict.pass,
      problems: verdict.problems,
      round: verdict.round,
      ...(notes === '' ? {} : { notes }),
      ...(outOfScope.length > 0 ? { outOfScope } : {}),
    });
  };

  /**
   * 「不归我验」的验收条留言到单上，转给人（指挥官）验：不回炉、不挡合并闸（决定 0093）。同一个头只留一次（幂等键带头）。
   * 留不成不改结论（验收本身已经做完），写进 notes 和日志，人在驾驶舱的结论里也看得到。
   */
  async function handOff(
    input: ColdVerifyInput,
    items: readonly string[],
    suggestions: readonly string[],
  ): Promise<string> {
    const commentIssue = deps.gh.commentIssue;
    if (commentIssue === undefined) return `不归我验的 ${items.length} 条没处留言（没接留言口），要人看结论`;
    const body = handoffBody(input, items, suggestions);
    try {
      await commentIssue({
        repo: refOf(input.repo),
        issueNumber: input.issueNumber,
        key: `cold-verify-out-of-scope:${input.prNumber}:${input.headSha}`,
        body,
      });
      return `不归我验的 ${items.length} 条已留言到单 #${input.issueNumber}，转给人验`;
    } catch (error) {
      log('验收「不归我验」的条目没留成言（结论不改）', {
        issueNumber: input.issueNumber,
        prNumber: input.prNumber,
        error: errMessage(error),
      });
      return `不归我验的 ${items.length} 条没留成言（${errMessage(error).slice(0, 200)}），要人看结论`;
    }
  }
}

/** 转给人验的留言正文：哪个 PR、哪个头、哪几条、为什么验收方验不了；建议附在后面（不挡）。 */
export function handoffBody(
  input: Pick<ColdVerifyInput, 'prNumber' | 'headSha'>,
  items: readonly string[],
  suggestions: readonly string[] = [],
): string {
  return [
    `冷验收转人验：PR #${input.prNumber}（头 ${short(input.headSha)}）有 ${items.length} 条验收条要 diff 以外的证据（截图、现场、线上数据、审计结果），验收方判不了，不算没过、不回炉，请人验：`,
    '',
    ...items.map((item) => `- ${item}`),
    ...(suggestions.length > 0
      ? ['', '验收方另外的建议（不挡）：', ...suggestions.map((x) => `- ${x}`)]
      : []),
  ].join('\n');
}
