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
// - 验收会话的目录尽量放进 PR 头的完整检出（镜像里 git archive，放不进去就仍是空目录，不因此让验收失败）。
//   _tmp 是 root:root 755 时先经 fleet-agent-scope ensure-tmp 把这一层改回引擎用户再试一次；仍放不进就记日志，
//   并写一条驾驶舱报警（正文里有目录路径）。
//   提示词允许在这个检出里读文件。diff 仍在提示词里。第 2 轮只把证得了是本单返工的改动算新增，同步进来的主线留在材料里作上下文，不是整张 PR。
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
// - 发版重启引擎（#2848，和动手段 #2238、#2815 同一套，session-handoff.ts）：装了收发目录，一家验的会话交 detach 给 one-shot，
//   执行方式支持的（命令行那几家、Mirasim）引擎要走时放手（Mirasim 只断 ws、不发 stop），这里交回 detached（贴「在等」不贴 failure、
//   runs 那一行不收、空目录留着）；工作流带 attach 再调，接回原来那一次、读它的结论照常贴，结局记回原来那一行，空目录这时才删。
//   接回时引擎又在走：不读 GitHub，当场再交回。接回没给出结论、或没脱开的会话（两家都验）在引擎要走时被停了：不是没过、
//   不换候选，回 retry 重验一次（VERIFY_RELEASE_RETRY_SECONDS），不算一轮。放手 HANDOFF_TTL_MS 没人接回的照孤儿收（orphan-reap.ts）。
// - runs 里这一次验收记到这张单名下（#216）：tasks.id、单号、工作流编号经单子那一样（spec）交给 invokeVerifier，PR 号、分支
//   它本来就有；验收不分档，不带派工档。
// - 按族选路时给这一次验收预占池的名额（#757，pickRoute 的 reserve）：开跑那一行写进去时换掉；挑中了又没用上的（选路交回的
//   族对不上；两家都验只挑到一家、另一家在等，#1697）、没开跑就收场的，收场时一个个放掉，放不掉只记日志（到点自己过期）。开跑时名额已经没了抛 VERIFY_NO_SLOT，
//   可以重试。

import { randomUUID } from 'node:crypto';
import { COLD_VERIFY_CONTEXT, LOCAL_LABEL } from '@fleet-dao/conventions';
import type { ClaimsGitHub, GitHub, RepoRef } from '@fleet-dao/github';
import { errMessage } from '@fleet-dao/shared/util';
import { taskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import { type GithubWhitelist, isTrusted } from '@fleet-dao/store';
import type { EngineTasks } from '../activities.ts';
import { familyPickerFrom } from '../cold-verify-pick.ts';
import {
  type CheckoutBlockedAlert,
  type CheckoutReceipt,
  type CheckoutRecovered,
  incrementalDiffAtHead,
  placeVerifyCheckout,
  runColdVerifyForPr,
} from '../cold-verify-run.ts';
import { createStatusMemo } from '../cold-verify-status.ts';
import { type PickRouteInput, type PickRouteResult, type PortContext, PortError } from '../ports.ts';
import { outstandingChangeRequests } from '../review-feedback.ts';
import type { RunsWriter } from '../runner/not-wired.ts';
import { type OneShotDeps, OneShotError, SESSION_ARTIFACT_TTL_MS } from '../runner/one-shot.ts';
import { requirementContract } from '../runner/task-brief.ts';
import {
  type ColdVerifyAttach,
  type ColdVerifyInput,
  type ColdVerifyResult,
  type ReviewChange,
  ROUTE_RETRY_SECONDS,
  SEGMENT_STAGE,
} from '../task-contract.ts';
import { judgeUiWork, UI_UNRECOGNIZED_NOTE } from '../ui-work.ts';
import {
  attachVerifier,
  FAMILY_ORDER,
  invokeVerifier,
  type VerifierInvokeOutput,
} from '../verifier-invoke.ts';
import type { EngineGitHub } from './github-ports.ts';
import type { MemoryAdmissionDeps } from './memory-admission.ts';
import { mapped } from './mirror.ts';
import type { OneShotSessions, OneShotTicket } from './one-shot-sessions.ts';
import { type AssignedProber, createProbeBudget } from './pick-then-probe.ts';
import type { SegmentReservations } from './runs-writer.ts';
import { hostSegmentSpawner, resolveSegmentRoute, type SegmentSpawnerDeps } from './segment-spawner.ts';
import { guardRequirementContract } from './task-contract-guard.ts';
import { sweepRunDirs } from './task-segment.ts';

/** 一次验收会话最长几分钟：验收只读 diff，比动手会话短得多。 */
export const VERIFY_MINUTES = 30;
/** 起下一家验收会话前，活动剩下的时间除了一家的限时，还要留这么久收尾（写状态、记账）。 */
const VERIFY_WRAP_UP_MS = 2 * 60_000;

/**
 * 活动剩下的时间够不够再起一家验收会话（#3281）：换家族链一家最多 VERIFY_MINUTES，链比活动限时长，换到后面整个活动会超时、
 * 被挂起等人。不够就不再起，回等待交工作流过一会儿重验。没有截止（不经 Temporal 的调用）一直够。
 */
export function roomForAnother(deadlineMs: number | undefined, minutes: number, now = Date.now()): boolean {
  if (deadlineMs === undefined) return true;
  return deadlineMs - now > minutes * 60_000 + VERIFY_WRAP_UP_MS;
}
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
 * 发版叫停了这一次验收、又没接回（#2848），隔多久重验（秒）：新引擎起来、老引擎排空走掉一般一两分钟，
 * 早来了选路会回「在停机」再等，不白起会话。
 */
export const VERIFY_RELEASE_RETRY_SECONDS = 60;
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
   * 不给 = 留不了言，只写进结论的 notes。fetchCommitHead：生产在检出前补齐既定头；测试未接仍核原镜像。
   */
  gh: Pick<EngineGitHub, 'pullFiles' | 'claims'> &
    Partial<
      Pick<
        GitHub,
        'commentIssue' | 'addIssueLabel' | 'fetchCommitHead' | 'fetchMainline' | 'readIssue' | 'readSpecDoc'
      >
    >;
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
  /**
   * 读 PR 上还没解决的正式「要求改」评审（#2991，reviewChangesReader）：验收有结论时现读，带进结论的 reviewChanges，
   * 工作流交给下一轮动手会话。读不成抛错（这一次验收按失败分流重试），不回空。不给 = 不读（结论里没有这个字段）。
   */
  reviewChanges?: (repo: RepoRef, prNumber: number) => Promise<ReviewChange[]>;
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
  /**
   * 第 2 轮的增量 diff。不给就现读可信主线，再用镜像里的 incrementalDiffAtHead 拆归属。
   * 读不到抛错，这一轮验收失败，不退回整张 PR 的 diff，也不回空 diff。
   * 注入的实现可以不读主线（测试）；生产这条不注入。
   */
  rangeDiff?: (args: {
    sinceSha: string;
    headSha: string;
    workflowId: string | undefined;
    prNumber: number;
    issueNumber: number;
    baseSha: string;
    repo: RepoRef;
    mainlineSha?: string;
  }) => Promise<{ diffText: string; changedFiles: string[] }>;
  now?: () => Date;
  /** 以下测试用。 */
  /** 头对不上时两次读之间怎么等（默认真等 HEAD_SETTLE_WAIT_MS）。 */
  sleep?: (ms: number) => Promise<void>;
  newRunId?: () => string;
  heartbeatEveryMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /**
   * _tmp 不可写时先修再检出（生产：sudo fleet-agent-scope ensure-tmp）。
   * 不给 = 建不了就直接退路，不试第二次。
   */
  repairWorkTmp?: (dir: string) => Promise<void>;
  /** 退路时写驾驶舱报警（正文含目录）。不给 = 只记日志。写不进不让验收停。 */
  onCheckoutBlocked?: (alert: CheckoutBlockedAlert) => Promise<void>;
  /** 这个目标真放进了完整检出：撤它开跑之前报的检出报警（#3036）。不给 = 不撤。撤不成不让验收停。 */
  onCheckoutRecovered?: (recovered: CheckoutRecovered) => Promise<void>;
  /** 成功完整检出的独立持久回执，不依赖旧卡是否存在。 */
  onCheckoutCompleted?: (receipt: CheckoutReceipt) => Promise<void>;
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
  /** 引擎要走了，验收会话脱开接着跑（#2848）：接回要的东西。 */
  detached?: NonNullable<VerifierInvokeOutput['detached']>;
  /** 发版叫停了这一次验收、又没接回（#2848）：原因。重验一次，不算没过。 */
  lost?: string;
}

/** 工作流交来的接回单 → verifier-invoke 认的形状（族认不出就抛：交回时就是从那里来的，对不上是状态乱了）。 */
function verifierAttachOf(a: ColdVerifyAttach): NonNullable<VerifierInvokeOutput['detached']> {
  const family = FAMILY_ORDER.find((f) => f === a.family);
  if (family === undefined) throw new Error(`接回的验收会话的族认不出：${a.family}`);
  return {
    runId: a.runId,
    startedAt: a.startedAt,
    family,
    modelId: a.modelId,
    routeId: a.routeId,
    channel: a.poolId,
    ...(a.routeWhy !== undefined ? { routeWhy: a.routeWhy } : {}),
    cwd: a.cwd,
  };
}

/** verifier-invoke 交回的放手 → 交给工作流的接回单（这里的 channel 就是池，见 chooseModelForFamily）。路由、池没有就接不回。 */
function coldVerifyAttachOf(d: NonNullable<VerifierInvokeOutput['detached']>): ColdVerifyAttach | undefined {
  if (d.routeId === undefined || d.channel === undefined) return undefined;
  return {
    runId: d.runId,
    startedAt: d.startedAt,
    family: d.family,
    modelId: d.modelId,
    routeId: d.routeId,
    poolId: d.channel,
    ...(d.routeWhy !== undefined ? { routeWhy: d.routeWhy } : {}),
    cwd: d.cwd,
  };
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
    const sessionIo = deps.spawner.handoff;
    // 接回时引擎又在走（发版连着发）：不碰会话、不读 GitHub，当场再交回，等下一个引擎（#2848，和动手段一样）
    if (input.attach && sessionIo?.signal.aborted) {
      return { pass: false, problems: [], round, detached: input.attach };
    }
    // 旧活动缺版本时，用它实际携带的正文构造旧合同，不能把刚读的新正文伪装成原会话合同。
    // 未装读口的旧测试保留旧行为；新版输入即使缺端口也必须明确失败。
    const publicationContract =
      input.contract ?? (deps.gh.readIssue ? requirementContract(input.what) : undefined);
    let contractExpired = false;
    if (
      !input.attach &&
      publicationContract &&
      !(await guardRequirementContract(deps.gh, repo, prNumber, input.issueNumber, publicationContract, ctx))
    ) {
      return { pass: false, problems: [], round, contractChanged: true };
    }
    // 引擎要走了（收到停机信号）：这时没跑完的验收会话是发版叫停的，不是没验成（#2848）
    const released = (): string | undefined =>
      sessionIo?.signal.aborted ? '发版叫停了这一次验收（引擎要走了）' : undefined;

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
        return spawn({
          ...cmd,
          signal: AbortSignal.any([cmd.signal, ctx.signal]),
          // 脱开引擎跑的（#2848）：交给驱动之前从发布排空的在途清单里撤掉，到截止也不停它（引擎走时放手）
          ...(cmd.detach ? { detach: { ...cmd.detach, detachable: () => ticket?.detachable() } } : {}),
        });
      },
      ...(deps.memoryAdmission ? { memoryAdmission: deps.memoryAdmission } : {}),
      tmpDir: deps.runsDir,
      runs: deps.runs,
      now,
      ...(ticket ? { stop: ticket.signal } : {}),
    });
    const oneShot = oneShotFor();
    // 接回（#2848）：登记照原来那一次的池（切号照样停得下它），带 attach（排空、总开关关着都不预先叫停，会话早就在跑）
    const attach = input.attach;
    let attachTicket: OneShotTicket | undefined;
    if (attach && deps.sessions) {
      attachTicket = deps.sessions.enter({
        poolId: attach.poolId,
        stage: SEGMENT_STAGE.verify,
        taskId: input.taskId,
        attach: true,
      });
      attachTicket.attempt(attach.runId);
      tickets.set(attach.family, attachTicket);
    }

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
    // 第 2 轮在起验收之前现读主线尖，并把旧验收头、当前头、记录的基线补进镜像。
    // 这一步的 GitHub 故障是 PortError，按失败分流重试，不写成「读不到 diff」去停给人。
    // 注入了 rangeDiff 的测试不读主线。读到的尖对不对、能不能拆，交给镜像里的增量读取，拆不开就失败，不回空 diff。
    // 主线读完后 sources.pr 再读一次当前 PR 头，不用读主线之前捕获的那份。头变了回 headMoved，不按旧头验收、不贴状态。
    let recheckMainline: string | undefined;
    const fetchMainline = deps.gh.fetchMainline;
    try {
      if (input.recheck && deps.rangeDiff === undefined && fetchMainline) {
        const main = await mapped(() => fetchMainline({ repo, signal: ctx.signal }));
        const tip = main.head.trim();
        if (!/^[0-9a-f]{40}$/i.test(tip)) throw new Error('现读的可信主线不是完整提交号');
        recheckMainline = tip;
        const fetchCommit = deps.gh.fetchCommitHead;
        if (fetchCommit) {
          for (const sha of [input.headSha, input.recheck.sinceSha, input.baseSha]) {
            await mapped(() => fetchCommit({ repo, headSha: sha, signal: ctx.signal }));
          }
        }
      }
      run = await runColdVerifyForPr(prNumber, {
        sources: {
          pr: async () => {
            // 第 2 轮现读主线、补对象之后头可能已经变了。再读一次，不沿用上面捕获的 pull。
            // 读失败经 mapped 成 PortError，由 runColdVerifyForPr 原样抛出（失败分流重试）。
            const current =
              input.recheck && deps.rangeDiff === undefined && fetchMainline
                ? await mapped(() => deps.gh.claims.readPull(repo, prNumber))
                : pull;
            if (current.state !== 'open') {
              throw new Error(`PR #${prNumber} ${current.merged ? '已经合并' : '已经关闭'}了，没有要验的头`);
            }
            if (current.headSha !== input.headSha) {
              seen.headMoved = current.headSha;
              throw new Error(
                `PR #${prNumber} 的头是 ${short(current.headSha)}，不是要验的 ${short(input.headSha)}（有人推过新提交）`,
              );
            }
            return {
              head: input.headSha,
              baseSha: input.baseSha,
              branch: input.branch,
              body: current.body,
            };
          },
          diff: async () => {
            if (input.recheck) {
              const workflowId = ctx.workflowId ?? taskWorkflowId(input.repo, input.issueNumber);
              const identity = {
                sinceSha: input.recheck.sinceSha,
                headSha: input.headSha,
                workflowId,
                prNumber,
                issueNumber: input.issueNumber,
                baseSha: input.baseSha,
                repo,
              };
              if (deps.rangeDiff) return deps.rangeDiff(identity);
              if (recheckMainline === undefined) {
                throw new Error('没有可信主线来源（主线没现读），不能把主线同步算进本单返工，也不回空 diff');
              }
              return incrementalDiffAtHead({ ...identity, mainlineSha: recheckMainline });
            }
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
              ...(input.recheck === undefined
                ? {}
                : {
                    recheck: {
                      failedCriteria: input.recheck.failedCriteria,
                      priorProblems: input.recheck.priorProblems,
                    },
                  }),
            };
          },
          authorFamilies: async () => input.authorFamilies,
        },
        invoke: async (verifierInput, verifierDeps) => {
          try {
            if (attach) {
              // 接回（#2848）：不拉 diff、不选路、不起会话，接回原来那一次、读它的结论
              return await attachVerifier(
                {
                  attach: verifierAttachOf(attach),
                  round,
                  taskId: verifierInput.taskId,
                  issueNumber: verifierInput.issueNumber,
                  ...(verifierInput.workflowId !== undefined ? { workflowId: verifierInput.workflowId } : {}),
                  ...(input.roundSeq !== undefined ? { roundSeq: input.roundSeq } : {}),
                  prNumber,
                  branch: input.branch,
                  headSha: input.headSha,
                },
                {
                  oneShot: oneShotFor(attachTicket),
                  log,
                  ...(verifierDeps.timeoutMinutes !== undefined
                    ? { timeoutMinutes: verifierDeps.timeoutMinutes }
                    : {}),
                  released,
                },
              );
            }
            // 装了收发目录（生产）：一家验的会话脱开引擎跑，执行方式支持的发版时放手、新引擎接回（#2848）
            return await invokeVerifier(
              input.roundSeq === undefined ? verifierInput : { ...verifierInput, roundSeq: input.roundSeq },
              {
                ...verifierDeps,
                log,
                ...(sessionIo ? { detach: true } : {}),
                released,
                roomForAnother: () =>
                  roomForAnother(ctx.attemptDeadlineMs, verifierDeps.timeoutMinutes ?? VERIFY_MINUTES),
              },
            );
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
            ...(route.why?.trim() ? { routeWhy: route.why.trim() } : {}),
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
          // 放得进 PR 头的完整检出就放；镜像没有、提交不在、目录仍建不出，会话仍起，提示词里的材料还在。
          const fetchHead = deps.gh.fetchCommitHead;
          await placeVerifyCheckout({
            taskId: input.taskId,
            runId: picked.runId,
            ...(deps.now ? { now: deps.now } : {}),
            ...(deps.onCheckoutCompleted ? { onCompleted: deps.onCheckoutCompleted } : {}),
            signal: ctx.signal,
            ...(fetchHead
              ? { ensureHead: () => fetchHead({ repo, headSha: input.headSha, signal: ctx.signal }) }
              : {}),
            dir,
            head: input.headSha,
            workflowId: ctx.workflowId ?? taskWorkflowId(input.repo, input.issueNumber),
            ...(deps.repairWorkTmp ? { repair: deps.repairWorkTmp } : {}),
            log,
            ...(deps.onCheckoutBlocked ? { onBlocked: deps.onCheckoutBlocked } : {}),
            ...(deps.onCheckoutRecovered ? { onRecovered: deps.onCheckoutRecovered } : {}),
          });
          const identity = await deps.spawner.trees.adoptTemporary(dir, user);
          return {
            cwd: dir,
            ...(ticket ? { oneShot: oneShotFor(ticket) } : {}),
            release: async () => {
              await deps.spawner.trees.removeTemporary(dir, identity).catch((error: unknown) => {
                log('验收会话的空目录没删掉（引擎下次起来时的清理会收）', { dir, error: errMessage(error) });
              });
            },
          };
        },
        writeStatus: async ({ head, status }) => {
          if (status.state !== 'pending' && publicationContract) {
            if (
              !(await guardRequirementContract(
                deps.gh,
                repo,
                prNumber,
                input.issueNumber,
                publicationContract,
                ctx,
              ))
            ) {
              contractExpired = true;
              return; // guard 已撤自动合并并写明确 failure；不发布旧结论。
            }
          }
          await mapped(() =>
            deps.gh.claims.setStatus(repo, head, {
              context: COLD_VERIFY_CONTEXT,
              state: status.state,
              description: status.description,
            }),
          );
        },
        statusMemo: statusMemo.scoped(`${prKey}:${publicationContract?.sha256 ?? 'legacy'}`),
        round,
        timeoutMinutes: deps.timeoutMinutes ?? VERIFY_MINUTES,
        waitReason: (verdict) => {
          // 脱开引擎跑着（#2848）：没有结论，贴「在等」不贴 failure，交回工作流带 attach 再来
          if (verdict.detached) {
            seen.detached = verdict.detached;
            return '引擎在换版本：验收会话脱开引擎接着跑，等新引擎接回';
          }
          // 发版叫停了、又没接回（#2848）：不是没过，重验一次
          if (verdict.lostOnRelease) {
            seen.lost = verdict.lostOnRelease;
            return `${verdict.lostOnRelease.slice(0, 200)}；没接回，重验一次`;
          }
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
      // 接回的会话收场了（没再放手）：它的空目录这时才删（放手时留给接回的那个引擎）
      if (attach && !seen.detached) {
        log('接回验收没有原始目录身份，保留给任务/TTL门后的孤儿清理', { dir: attach.cwd });
      }
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
    if (contractExpired) return { pass: false, problems: [], round, contractChanged: true };
    // 记账收口（#2007）：PR 关了、合了，状态记忆丢掉；这一圈没在等（真派上了、或出了结论）连续等待的次数归零
    if (pull.state !== 'open') statusMemo.forget(prKey);
    if (run.wait === undefined || run.verdict?.upstreamRetry !== undefined) backoff.delete(prKey);

    // 2. 把结局整理成工作流要的形状
    // 脱开引擎跑着（#2848）：交回接回要的东西；路由、池记不全的接不回，按「发版叫停又没接回」重验一次
    if (seen.detached) {
      const back = coldVerifyAttachOf(seen.detached);
      if (back) return { pass: false, problems: [], round, detached: back };
      seen.lost = '验收会话脱开了，可路由或池没记下、接不回';
    }
    if (seen.lost !== undefined) {
      return {
        pass: false,
        problems: [],
        round,
        retry: {
          wait: 'slot',
          reason: run.wait ?? `${seen.lost}；没接回，重验一次`,
          afterSeconds: VERIFY_RELEASE_RETRY_SECONDS,
        },
      };
    }
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
    const suggestions = verdict.suggestions ?? [];
    // 不归我验的转人；只有建议的（验收条以外的意见，决定 0094）也留言到单上，不挡合并
    const handoff =
      outOfScope.length > 0
        ? await handOff(input, outOfScope, suggestions)
        : suggestions.length > 0
          ? await commentSuggestions(input, suggestions)
          : undefined;
    const notes = [verdict.notes, handoff].filter((n): n is string => n !== undefined && n !== '').join('；');
    // 有结论了才读正式评审（#2991）：读在会话之后，会话跑着时新交的评审也赶得上这一次
    return withReviewChanges(
      withUiNote({
        pass: verdict.pass,
        problems: verdict.problems,
        round: verdict.round,
        ...(notes === '' ? {} : { notes }),
        ...(outOfScope.length > 0 ? { outOfScope } : {}),
      }),
      deps.reviewChanges,
      repo,
      prNumber,
    );
  };

  /**
   * 「不归我验」的验收条留言到单上，转给人（指挥官）验：不回炉、不挡合并闸（决定 0093）。同一个头只留一次（幂等键带头）。
   * 不再记库（#3591，决定 0113）：工作流收尾凭结论里的 outOfScope 留着原单、不关。留不成不改结论，写进 notes 和日志。
   */
  async function handOff(
    input: ColdVerifyInput,
    items: readonly string[],
    suggestions: readonly string[],
  ): Promise<string> {
    return commentHandoff(input, items, suggestions);
  }

  /** 验收条以外的建议（不挡合并）留言到单上；同一个头只留一次。留不成不改结论。 */
  async function commentSuggestions(input: ColdVerifyInput, suggestions: readonly string[]): Promise<string> {
    const commentIssue = deps.gh.commentIssue;
    if (commentIssue === undefined) return `验收方的 ${suggestions.length} 条建议没处留言（没接留言口）`;
    try {
      await commentIssue({
        repo: refOf(input.repo),
        issueNumber: input.issueNumber,
        key: `cold-verify-suggestions:${input.prNumber}:${input.headSha}`,
        body: suggestionsBody(input, suggestions),
      });
      return `验收方的 ${suggestions.length} 条建议已留言到单 #${input.issueNumber}（不挡合并）`;
    } catch (error) {
      log('验收建议没留成言（结论不改）', {
        issueNumber: input.issueNumber,
        prNumber: input.prNumber,
        error: errMessage(error),
      });
      return `验收方的 ${suggestions.length} 条建议没留成言（${errMessage(error).slice(0, 200)}）`;
    }
  }

  async function commentHandoff(
    input: ColdVerifyInput,
    items: readonly string[],
    suggestions: readonly string[],
  ): Promise<string> {
    const commentIssue = deps.gh.commentIssue;
    let said: string;
    if (commentIssue === undefined) {
      said = `不归我验的 ${items.length} 条没处留言（没接留言口），要人看结论`;
    } else {
      try {
        await commentIssue({
          repo: refOf(input.repo),
          issueNumber: input.issueNumber,
          key: `cold-verify-out-of-scope:${input.prNumber}:${input.headSha}`,
          body: handoffBody(input, items, suggestions),
        });
        said = `不归我验的 ${items.length} 条已留言到单 #${input.issueNumber}，转给人验`;
      } catch (error) {
        log('验收「不归我验」的条目没留成言（结论不改）', {
          issueNumber: input.issueNumber,
          prNumber: input.prNumber,
          error: errMessage(error),
        });
        said = `不归我验的 ${items.length} 条没留成言（${errMessage(error).slice(0, 200)}），要人看结论`;
      }
    }
    // #3601：#3591 起不再记库，单上的「本机做」是转人之后唯一让队列看得到这张单的东西。
    // 在活动内部、和留言同一次写 GitHub 里贴，工作流步序不变；贴不成照实抛（可重试，留言有幂等键），不吞。
    const addIssueLabel = deps.gh.addIssueLabel;
    if (addIssueLabel === undefined) return `${said}；没接贴标签口，单上没贴「${LOCAL_LABEL}」`;
    try {
      await addIssueLabel({ repo: refOf(input.repo), issueNumber: input.issueNumber, label: LOCAL_LABEL });
    } catch (error) {
      log('验收转人后给单贴「本机做」没贴成', {
        issueNumber: input.issueNumber,
        prNumber: input.prNumber,
        error: errMessage(error),
      });
      throw new PortError(
        'COLD_VERIFY_HANDOFF_LABEL_FAILED',
        `验收转人后给单 #${input.issueNumber} 贴「${LOCAL_LABEL}」没贴成：${errMessage(error)}`,
        { retryable: true },
      );
    }
    return `${said}；已贴「${LOCAL_LABEL}」`;
  }
}

/**
 * 验收结论带上 PR 上还没解决的正式「要求改」评审（#2991）。没装读评审的口子就原样回（结论里没有 reviewChanges，工作流当没读）。
 * 读不成抛 PortError（可重试）：这一次验收按失败分流重来，不回空数组冒充「没有评审」。
 */
export async function withReviewChanges(
  result: ColdVerifyResult,
  read: ((repo: RepoRef, prNumber: number) => Promise<ReviewChange[]>) | undefined,
  repo: RepoRef,
  prNumber: number,
): Promise<ColdVerifyResult> {
  if (read === undefined) return result;
  let reviewChanges: ReviewChange[];
  try {
    reviewChanges = await read(repo, prNumber);
  } catch (error) {
    if (error instanceof PortError) throw error;
    throw new PortError('REVIEW_READ_FAILED', `读 PR #${prNumber} 的正式评审没读成：${errMessage(error)}`, {
      retryable: true,
    });
  }
  return { ...result, reviewChanges };
}

/**
 * 生产读评审（#2991）：引擎机器人列 PR 上全部评审（翻完页）；认可的审查者照开单白名单（成员表拼的 GithubWhitelist、
 * isTrusted：人按编号认、自家机器人按编号且 type 是 Bot），挑出还没解决的要求改。两样哪样读不成都抛，不当成没有。
 */
export function reviewChangesReader(w: {
  listReviews: ClaimsGitHub['listReviews'];
  listReviewComments: ClaimsGitHub['listReviewComments'];
  whitelist: () => Promise<GithubWhitelist>;
}): (repo: RepoRef, prNumber: number) => Promise<ReviewChange[]> {
  if (typeof w.listReviewComments !== 'function') {
    throw new PortError('REVIEW_INLINE_UNWIRED', '正式评审行内读取端口未装配，不能当作空意见', {
      retryable: false,
    });
  }
  return async (repo, prNumber) => {
    const reviews = await mapped(() => w.listReviews(repo, prNumber));
    let list: GithubWhitelist;
    try {
      list = await w.whitelist();
    } catch (error) {
      throw new PortError(
        'REVIEW_TRUST_UNREADABLE',
        `读认可的审查者（成员白名单）没读成：${errMessage(error)}`,
        {
          retryable: true,
        },
      );
    }
    const selected = outstandingChangeRequests(reviews, (author) => isTrusted(author, list));
    const out: ReviewChange[] = [];
    for (const review of selected) {
      const parents = reviews.filter((r) => r.id === review.reviewId);
      const author = parents.length === 1 ? parents[0]?.author : null;
      if (!author)
        throw new PortError('REVIEW_BINDING_FAILED', `review ${review.reviewId} 的原审查者不唯一，未核实`, {
          retryable: true,
        });
      const inlineComments = await mapped(() => w.listReviewComments(repo, prNumber, review.reviewId));
      for (const c of inlineComments) {
        if (
          c.reviewId !== review.reviewId ||
          c.author.id !== author.id ||
          c.author.type !== author.type ||
          !isTrusted(c.author, list)
        ) {
          throw new PortError(
            'REVIEW_INLINE_UNTRUSTED',
            `review ${review.reviewId} comment ${c.id} 的作者/父评审未核实，未送达`,
            { retryable: true },
          );
        }
      }
      out.push({ ...review, inlineComments });
    }
    return out;
  };
}

/** 只有建议时的留言正文：验收条都过了，下面是验收条以外的意见，不挡合并（决定 0094）。 */
export function suggestionsBody(
  input: Pick<ColdVerifyInput, 'prNumber' | 'headSha'>,
  suggestions: readonly string[],
): string {
  return [
    `冷验收建议：PR #${input.prNumber}（头 ${short(input.headSha)}）验收条都没有看得到没做到的，通过。验收方另有 ${suggestions.length} 条验收条以外的意见，只当建议、不挡合并：`,
    '',
    ...suggestions.map((x) => `- ${x}`),
  ].join('\n');
}

/**
 * 转给人验的留言正文：哪个 PR、哪个头、哪几条、为什么验收方验不了；建议附在后面（不挡）。
 * 写明代码照合、单子留着（#3037）：合并不等于验完，有人贴上验收证据才关单（#3591 起不再记库）。
 */
export function handoffBody(
  input: Pick<ColdVerifyInput, 'prNumber' | 'headSha'>,
  items: readonly string[],
  suggestions: readonly string[] = [],
): string {
  return [
    `冷验收转人验：PR #${input.prNumber}（头 ${short(input.headSha)}）有 ${items.length} 条验收条要 diff 以外的证据（截图、现场、线上数据、审计结果），验收方判不了，不算没过、不回炉，请人验：`,
    '',
    ...items.map((item) => `- ${item}`),
    '',
    `已转人验（头 ${input.headSha}）：代码照常合并，这张单留着不关，有人贴上验收证据再关。`,
    ...(suggestions.length > 0
      ? ['', '验收方另外的建议（不挡）：', ...suggestions.map((x) => `- ${x}`)]
      : []),
  ].join('\n');
}
