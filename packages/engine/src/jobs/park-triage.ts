// 法国指挥官会话（#3294 第 2 片）：停下等人的单，停了超过 15 分钟、第 1 片规则（jobs/parked-retry.ts）没解开的，
// 以及「已继续满三次、交指挥官」的，交给用途 commander 选出来的模型看一眼，让它对每张单交一个裁决加理由。
//
// 改这里之前必须知道：
// - 会话只交裁决，不动手、没有 GitHub 令牌（和整理待办同一条一次性会话的路，real/groom.ts 的 readOnlySessionRunner）。
//   引擎拿裁决先过纯函数白名单（decisions/park-triage.ts；额度超预算另按 decisions/spin.ts 判空转），放行的才执行，
//   没放行的、会话没给裁决的、交了白名单外动作的，一律退成「留给人」：只把诊断写进提醒，任务不动。
// - 每张单每次停下最多处理一次：处理前先记一条 commander.claim（键 = 工作流编号 + 第几次停下），之后就算会话没跑成也不再来第二次，
//   交人（提醒里写明）。每天处理的张数有上限（PARK_TRIAGE_DAILY_CAP，数 24 小时内的 claim）。设置 engine.commander 能关，关着不看。
// - 用途 commander 没配模型（路由页清空了）：明说「没配模型」并报警，不悄悄不跑。
// - 执行的操作都记在 engine:commander 名下（操作记录 target=commander），诊断文字（理由、白名单核对结果、空转判断）带进发出的提醒。
// - 额度超预算不再是人闸，判的是空转不是钱：没空转 → 允许继续并把额度预算放宽一档；判成空转 → 不许原样继续。回合没读到的不拿来当「没空转」。

import type { ScheduleResult } from '@fleet-dao/db';
import { errMessage } from '@fleet-dao/shared/util';
import { z } from 'zod';
import { COMMANDER_ACTOR, ROUNDS_HANDOFF_TITLE } from '../commander-contract.ts';
import {
  allowedActions,
  COMMANDER_ACTION_WORDS,
  type CommanderAction,
  checkVerdict,
  PARK_KIND_WORDS,
  type ParkFacts,
} from '../decisions/park-triage.ts';
import { judgeSpin, type SpinJudgement, type SpinRound } from '../decisions/spin.ts';
import type { ContinueCommand, TaskParkInfo } from '../task-contract.ts';
import type { ScheduleRunLog } from './github-reconcile.ts';
import type { GroomSessionInput, GroomSessionOutcome } from './groom.ts';
import { extractJson, renderNewIssueBody } from './groom-plan.ts';
import type { IntakeRepo } from './intake.ts';
import type { ParkedRetryRow, ParkedSnapshot } from './parked-retry.ts';
import { stamp } from './reconcile-common.ts';
import type { RedoOutcome } from './redo.ts';

export const PARK_TRIAGE_EVERY_MINUTES = 10;
/** 和每 10 分钟的引擎续停（4 分起）错开。 */
export const PARK_TRIAGE_OFFSET_MINUTES = 7;
/** 停下超过这么久、规则没解开，才交指挥官（引擎续停每 10 分钟看一遍，这里等它至少看过一次）。 */
export const PARK_TRIAGE_AFTER_MINUTES = 15;
/** 每天最多处理几张（数 24 小时内的 commander.claim）。 */
export const PARK_TRIAGE_DAILY_CAP = 20;
/** 一个会话一次最多看几张（同一个仓的）；一轮最多起几个会话。 */
export const PARK_TRIAGE_BATCH = 5;
export const PARK_TRIAGE_MAX_SESSIONS = 2;
/** 会话最长几分钟。 */
export const PARK_TRIAGE_SESSION_MINUTES = 20;
export const PARK_TRIAGE_JOB = {
  id: 'park-triage',
  name: '停下的单交指挥官会话看',
  schedule: '每 10 分钟（7 分起）',
  expectEveryMinutes: 60,
} as const;

/** 操作记录的 action：先记「认领」，执行了再记「执行」。 */
export const COMMANDER_AUDIT_CLAIM = 'commander.claim';
export const COMMANDER_AUDIT_ACT = 'commander.act';

export type CommanderSwitch = { on: true } | { on: false; why: string };

export interface CommanderAuditView {
  at: Date;
  action: string;
  after: unknown;
}

export interface CommanderNotice {
  level: 'daily' | 'alert';
  key: string;
  title: string;
  body: string;
  taskId: string | null;
}

export interface ParkTriageItem {
  row: ParkedRetryRow;
  workflowId: string;
  park: TaskParkInfo;
  /** 已继续满三次、交指挥官的那一停。 */
  handoff: boolean;
  /** 这一次停下的提醒正文（原因原文）；没读到是 null。 */
  detail: string | null;
  /** 这张单已有的回合（旧的在前）；没读到是 null。 */
  rounds: SpinRound[] | null;
  /** 只有额度停法算；回合没读到也是 null（allowedActions 当「没法判」）。 */
  spin: SpinJudgement | null;
}

export interface CommanderActEntry {
  item: ParkTriageItem;
  action: CommanderAction | 'reject';
  reason: string;
  ok: boolean;
  error?: string;
  detail?: Record<string, unknown>;
}

export interface ParkTriageDeps {
  /** 设置 engine.commander：没设过算开；读不到、认不出按关（回原因）。 */
  enabled(): Promise<CommanderSwitch>;
  /** 用途 commander 下有没有模型。 */
  purposeConfigured(): Promise<boolean>;
  /** state=stalled、executor=engine 的任务。读不到照抛。 */
  tasks(): Promise<ParkedRetryRow[]>;
  /** 现问工作流；已经没了回 gone。 */
  status(workflowId: string): Promise<ParkedSnapshot | 'gone'>;
  /** since 之后 target=commander 的操作记录。读不到照抛。 */
  audits(since: Date): Promise<CommanderAuditView[]>;
  /** 认领这一次停下（写 commander.claim）。写不进照抛：这一张这一轮不处理。 */
  claim(entry: {
    row: ParkedRetryRow;
    workflowId: string;
    park: TaskParkInfo;
    requestId: string;
  }): Promise<void>;
  /** 这一次停下的提醒正文。 */
  detail(workflowId: string, parkSeq: number): Promise<string | null>;
  /** 这张单已有的回合。读不到回 null，不抛：回合没读到就当没法判空转。 */
  rounds(taskId: string): Promise<SpinRound[] | null>;
  findRepo(owner: string, name: string): Promise<IntakeRepo | null>;
  /** 主线头（完整提交号）：只读检出钉在它上面。读不到照抛。 */
  mainHead(repo: IntakeRepo): Promise<string>;
  /** 起会话（选路按用途 commander、只读检出、不带令牌）。 */
  runSession(input: GroomSessionInput): Promise<GroomSessionOutcome>;
  continueTask(workflowId: string, command: ContinueCommand): Promise<'sent' | 'gone'>;
  /** 收尾放弃这一代（拆单、停掉用）。 */
  abandonTask(workflowId: string, reason: string): Promise<'sent' | 'gone'>;
  /** 叫停停着的这一代、另起下一代（换路由、换模型重来）。 */
  redoTask(row: ParkedRetryRow, workflowId: string): Promise<RedoOutcome>;
  /** 开子单（只有这一种写操作，没有关单）。 */
  openIssue(
    repo: IntakeRepo,
    input: { key: string; title: string; body: string; labels: string[] },
  ): Promise<{ number: number }>;
  /** 记一条执行（commander.act，actor = engine:commander）。执行之前写；写不进照抛，这一张不执行。 */
  audit(entry: CommanderActEntry): Promise<void>;
  notify(notice: CommanderNotice): Promise<void>;
  /** 继续发出去之后撤这一次停下的提醒。 */
  resolveAlert(entry: { workflowId: string; park: TaskParkInfo; why: string }): Promise<void>;
  runs: ScheduleRunLog;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

export interface ParkTriageResult {
  /** 开关关着、用途没配模型、今天次数用完：这一轮没看，原因在这。 */
  skipped?: string;
  noModel?: boolean;
  listed: number;
  /** 正停着、够条件交指挥官的张数。 */
  candidates: number;
  claimed: number;
  acted: { ref: string; action: CommanderAction }[];
  left: { ref: string; why: string }[];
  problems: string[];
}

const refOf = (row: ParkedRetryRow) => `${row.owner}/${row.name}#${row.issueNumber}`;
const claimKey = (workflowId: string, seq: number) => `${workflowId}#${seq}`;
const noticeKey = (item: ParkTriageItem) => `commander:${item.workflowId}:park:${item.park.seq}`;

// —— 会话的回答 ——

const Text = (max: number) => z.string().trim().min(1).max(max);
const Subtask = z.object({
  title: Text(100),
  scene: Text(3000),
  modules: Text(2000).optional(),
  done: z.array(Text(500)).min(1).max(12),
});
type Subtask = z.infer<typeof Subtask>;
const Verdict = z.object({
  issue: z.number().int().positive(),
  parkSeq: z.number().int().positive(),
  action: Text(40),
  reason: Text(1200),
  subtasks: z.array(z.unknown()).max(10).optional(),
});

export interface ParsedVerdict {
  issue: number;
  parkSeq: number;
  action: string;
  reason: string;
  subtasks: Subtask[];
  /** 拆单里格式不对的子单数。 */
  badSubtasks: number;
}

export interface ParsedCommanderAnswer {
  summary: string;
  verdicts: ParsedVerdict[];
  /** 格式不对的条目：没有执行。 */
  rejected: string[];
}

/** 会话的回答 → 裁决清单。整份认不出回 ok:false；单条认不出进 rejected，别的条照办。 */
export function parseCommanderAnswer(
  answer: string,
): ({ ok: true } & ParsedCommanderAnswer) | { ok: false; why: string } {
  const raw = extractJson(answer);
  if (raw === undefined) {
    return { ok: false, why: '会话的回答里找不到裁决清单（要有一段 ```json 围栏，里面是一个对象）' };
  }
  const obj = raw as Record<string, unknown>;
  const rejected: string[] = [];
  const list = Array.isArray(obj.verdicts) ? obj.verdicts : [];
  if (obj.verdicts !== undefined && !Array.isArray(obj.verdicts))
    rejected.push('「verdicts」不是列表：没有执行');
  const verdicts: ParsedVerdict[] = [];
  list.forEach((entry, index) => {
    const parsed = Verdict.safeParse(entry);
    if (!parsed.success) {
      rejected.push(
        `verdicts[${index}]：${parsed.error.issues.map((i) => `${i.path.join('.') || '整条'}：${i.message}`).join('；')}`,
      );
      return;
    }
    const subs = (parsed.data.subtasks ?? []).map((s) => Subtask.safeParse(s));
    verdicts.push({
      issue: parsed.data.issue,
      parkSeq: parsed.data.parkSeq,
      action: parsed.data.action,
      reason: parsed.data.reason,
      subtasks: subs.flatMap((s) => (s.success ? [s.data] : [])),
      badSubtasks: subs.filter((s) => !s.success).length,
    });
  });
  const summary = typeof obj.summary === 'string' ? obj.summary.trim().slice(0, 600) : '';
  return { ok: true, summary, verdicts, rejected };
}

// —— 提示词 ——

const parkFactsOf = (item: ParkTriageItem): ParkFacts => ({ kind: item.park.kind, handoff: item.handoff });

function allowedLines(item: ParkTriageItem): string[] {
  const table = allowedActions(parkFactsOf(item), item.spin);
  return (Object.keys(table) as CommanderAction[]).map((a) => {
    const v = table[a];
    return v === true
      ? `  - ${a}（${COMMANDER_ACTION_WORDS[a]}）：放行`
      : `  - ${a}（${COMMANDER_ACTION_WORDS[a]}）：不放行，${v}`;
  });
}

export function renderParkTriagePrompt(input: {
  repo: string;
  items: readonly ParkTriageItem[];
  mainHead: string;
  now: Date;
}): string {
  const blocks = input.items.map((item) => {
    const park = item.park;
    const lines = [
      `### #${item.row.issueNumber}（parkSeq ${park.seq}）`,
      `- 停法：${PARK_KIND_WORDS[park.kind]}${item.handoff ? '（已继续满三次仍没过，交指挥官）' : ''}`,
      `- 停下的标题：${park.title}`,
      `- 停下的时刻：${stamp(new Date(park.at))}（北京时间）${park.head ? `，PR 头 ${park.head.slice(0, 12)}` : ''}`,
      `- 原因原文：${item.detail ?? '没读到'}`,
    ];
    if (item.rounds === null) lines.push('- 回合记录：没读到');
    else if (item.rounds.length === 0) lines.push('- 回合记录：还没有收场的回合');
    else {
      lines.push('- 最近回合（旧的在前）：');
      for (const r of item.rounds.slice(-6))
        lines.push(
          `  - ${r.outcome}，改动行数 ${r.addedLines ?? '没量成'}，返工意见：${(r.reworkSummary ?? '无').replace(/\s+/g, ' ').slice(0, 200)}`,
        );
    }
    if (park.kind === 'quota') {
      lines.push(`- 引擎对空转的判断：${item.spin === null ? '没法判（回合没读到）' : item.spin.summary}`);
    }
    lines.push('- 引擎白名单：', ...allowedLines(item));
    return lines.join('\n');
  });
  return [
    `你是法国引擎的临时指挥官。仓 ${input.repo}（主线 ${input.mainHead.slice(0, 12)}，工作目录是它的只读检出）里有下面这些任务停下等人了。`,
    '你的活：对每张单读懂为什么停、该怎么办，交一个裁决加理由。你没有 GitHub 令牌，不要改文件、不要推代码、不要执行任何写操作；',
    '你交的裁决由引擎按白名单核过才执行，白名单没放行的动作交了也不会执行（只会把你的理由写给人看）。',
    '',
    '可选的裁决（action）：',
    '- continue：继续（接着做）。',
    '- redo：重做（叫停这一代、换路由或换模型另起一代；新一代自己重新选路）。',
    '- split：拆单（体量太大或反复空转时拆成 2~5 张互相独立的子单，每张写 title、scene、done；原单随后收尾）。',
    '- stop：停掉并报原因（只有额度超预算且引擎判成空转时才放行）。',
    '- leave：留给人（改标准、没权限等人闸，或你拿不准）：只把诊断建议写给人，任务不动。',
    '额度超预算不是看花了多少钱，而是看有没有空转：回合有新提交、失败原因在变就是有进展，可以继续；同一个原因连着失败、没有新提交、命令反复失败就是空转，不许原样继续。',
    '',
    '要处理的单：',
    '',
    ...blocks,
    '',
    '最后只回一段 ```json 围栏，里面是一个对象，每张单最多一条裁决，别的话不用写：',
    '```json',
    '{"summary":"一句话总结","verdicts":[{"issue":123,"parkSeq":1,"action":"continue","reason":"为什么这么判（给人看的诊断）"},' +
      '{"issue":124,"parkSeq":2,"action":"split","reason":"…","subtasks":[{"title":"…","scene":"…","done":["…"]}]}]}',
    '```',
  ].join('\n');
}

// —— 执行 ——

function spinOf(park: TaskParkInfo, rounds: SpinRound[] | null): SpinJudgement | null {
  return park.kind === 'quota' && rounds !== null ? judgeSpin(rounds) : null;
}

interface Outcome {
  acted: CommanderAction | null;
  /** 没动手（留给人、被挡、失败）时给人的原因。 */
  left?: string;
  text: string;
}

function diagnosisText(
  item: ParkTriageItem,
  model: string,
  verdict: { action: string; reason: string } | null,
  parts: string[],
): string {
  const lines = [
    `指挥官（${model}）看了 ${refOf(item.row)}：停法「${PARK_KIND_WORDS[item.park.kind]}」，停下「${item.park.title}」。`,
  ];
  if (verdict) lines.push(`裁决：${verdict.action}。理由：${verdict.reason}`);
  if (item.spin) lines.push(`空转判断：${item.spin.summary}`);
  else if (item.park.kind === 'quota') lines.push('空转判断：回合没读到，判不了。');
  lines.push(...parts);
  return lines.join('\n');
}

async function perform(
  deps: ParkTriageDeps,
  repo: IntakeRepo,
  item: ParkTriageItem,
  verdict: ParsedVerdict,
  model: string,
): Promise<Outcome> {
  const word = (a: CommanderAction) => COMMANDER_ACTION_WORDS[a];
  const check = checkVerdict(parkFactsOf(item), item.spin, {
    action: verdict.action,
    subtaskCount: verdict.subtasks.length + verdict.badSubtasks,
  });
  if (!check.ok) {
    return {
      acted: null,
      left: check.why,
      text: diagnosisText(item, model, verdict, [`引擎核对：${check.why}。没有执行，留给人处理。`]),
    };
  }
  const action = check.action;
  if (action === 'leave') {
    return {
      acted: null,
      left: '指挥官判留给人',
      text: diagnosisText(item, model, verdict, ['引擎核对：放行「留给人」，任务没动，请人看一眼。']),
    };
  }
  if (action === 'split' && verdict.badSubtasks > 0) {
    const why = `拆单里有 ${verdict.badSubtasks} 张子单格式不对（要 title、scene、done）`;
    return {
      acted: null,
      left: why,
      text: diagnosisText(item, model, verdict, [`引擎核对：${why}。没有执行。`]),
    };
  }
  const why = `${verdict.reason}（引擎核对放行「${word(action)}」）`;
  // 先记操作记录、再动手：记录写不进就不动，这一张交人
  try {
    await deps.audit({ item, action, reason: why, ok: true });
  } catch (err) {
    const msg = `操作记录没写进，没有执行：${errMessage(err)}`;
    return { acted: null, left: msg, text: diagnosisText(item, model, verdict, [msg]) };
  }
  const failed = async (error: string): Promise<Outcome> => {
    await deps
      .audit({ item, action, reason: why, ok: false, error })
      .catch((e: unknown) => deps.log('error', '指挥官：失败的执行没记进操作记录', { error: errMessage(e) }));
    return {
      acted: null,
      left: error,
      text: diagnosisText(item, model, verdict, [
        `执行「${word(action)}」没成：${error}。任务没动，请人看一眼。`,
      ]),
    };
  };
  try {
    if (action === 'continue') {
      const note = `指挥官判继续${check.widenBudget ? '，额度预算放宽一档' : ''}：${verdict.reason}`.slice(
        0,
        500,
      );
      const sent = await deps.continueTask(item.workflowId, {
        by: COMMANDER_ACTOR,
        note,
        parkSeq: item.park.seq,
        ...(check.widenBudget ? { widenBudget: true } : {}),
      });
      if (sent === 'gone') return await failed('工作流已经没了，没发出继续');
      await deps
        .resolveAlert({ workflowId: item.workflowId, park: item.park, why: note })
        .catch((e: unknown) =>
          deps.log('warn', '指挥官：继续发出去了，但这一次停下的提醒没撤掉', { error: errMessage(e) }),
        );
      return {
        acted: action,
        text: diagnosisText(item, model, verdict, [
          `已执行：继续${check.widenBudget ? '，并把这张单的额度预算放宽一档（没有空转）' : ''}。`,
        ]),
      };
    }
    if (action === 'redo') {
      const redone = await deps.redoTask(item.row, item.workflowId);
      if (!redone.ok) return await failed(redone.why);
      return {
        acted: action,
        text: diagnosisText(item, model, verdict, [
          `已执行：重做，新一代 ${redone.workflowId}（第 ${redone.generation} 代，重新选路，不带原来的避让）。`,
        ]),
      };
    }
    if (action === 'split') {
      const opened: number[] = [];
      for (const [i, sub] of verdict.subtasks.entries()) {
        const body = renderNewIssueBody({
          title: sub.title,
          kind: '需求',
          scene: sub.scene,
          ...(sub.modules === undefined ? {} : { modules: sub.modules }),
          done: sub.done,
          splitFrom: item.row.issueNumber,
        });
        const got = await deps.openIssue(repo, {
          key: `commander:${item.workflowId}:${item.park.seq}:${i}`,
          title: sub.title,
          body,
          labels: ['需求'],
        });
        opened.push(got.number);
      }
      const list = opened.map((n) => `#${n}`).join('、');
      const gone = await deps.abandonTask(
        item.workflowId,
        `指挥官拆单：已拆成 ${list}，这一代收尾（分支存档，原单由人处理）`,
      );
      return {
        acted: action,
        text: diagnosisText(item, model, verdict, [
          `已执行：拆单，开了 ${list}${gone === 'gone' ? '（原工作流已经没了）' : '，原来这一代收尾（分支存档，原单还开着，请人决定是否关）'}。`,
        ]),
      };
    }
    // stop
    const sent = await deps.abandonTask(
      item.workflowId,
      `指挥官判空转，停掉：${verdict.reason}`.slice(0, 500),
    );
    if (sent === 'gone') return await failed('工作流已经没了，没发出放弃');
    return {
      acted: action,
      text: diagnosisText(item, model, verdict, [
        '已执行：停掉这一代（工作树存档后删，PR 和单子不动，由人处理）。',
      ]),
    };
  } catch (err) {
    return await failed(errMessage(err));
  }
}

/** 一个仓的一批：起会话、核裁决、逐张执行。会话没跑成、回答认不出，这一批都留给人（认领已记，不再来第二次）。 */
async function triageRepo(
  deps: ParkTriageDeps,
  repo: IntakeRepo,
  items: ParkTriageItem[],
  requestId: string,
  result: ParkTriageResult,
): Promise<void> {
  const slug = `${repo.owner}/${repo.name}`;
  const leaveAll = async (why: string) => {
    for (const item of items) {
      result.left.push({ ref: refOf(item.row), why });
      await deps
        .notify({
          level: 'alert',
          key: noticeKey(item),
          title: `指挥官没能处理 ${refOf(item.row)}（停下「${item.park.title}」）`,
          body: `${why}\n\n这一次停下已经算处理过，不会再自动来第二次，请人看一眼。`,
          taskId: item.row.taskId,
        })
        .catch((e: unknown) => deps.log('error', '指挥官：提醒没推出去', { error: errMessage(e) }));
    }
  };
  let mainHead: string;
  try {
    mainHead = await deps.mainHead(repo);
  } catch (err) {
    await leaveAll(`没读到主线头，会话没起：${errMessage(err)}`);
    return;
  }
  const prompt = renderParkTriagePrompt({ repo: slug, items, mainHead, now: deps.now() });
  const session = await deps.runSession({
    repo,
    requestId,
    prompt,
    mainHead,
    timeoutMinutes: PARK_TRIAGE_SESSION_MINUTES,
  });
  if (!session.ok) {
    await leaveAll(`指挥官会话没跑成：${session.why}`);
    return;
  }
  const model = session.model ?? session.routeId ?? '会话没报模型';
  const parsed = parseCommanderAnswer(session.answer);
  if (!parsed.ok) {
    await leaveAll(`${parsed.why}（模型 ${model}）`);
    return;
  }
  for (const why of parsed.rejected) deps.log('warn', '指挥官：裁决格式不对，没有执行', { repo: slug, why });
  const seen = new Set<number>();
  const duplicated = new Set<number>();
  for (const v of parsed.verdicts) {
    if (seen.has(v.issue)) duplicated.add(v.issue);
    seen.add(v.issue);
  }
  for (const item of items) {
    const issue = item.row.issueNumber;
    const mine = parsed.verdicts.filter((v) => v.issue === issue);
    const ref = refOf(item.row);
    let outcome: Outcome;
    if (mine.length === 0) {
      outcome = {
        acted: null,
        left: '会话没给这张单裁决',
        text: diagnosisText(item, model, null, [
          `会话没给裁决（${parsed.rejected.length > 0 ? `有 ${parsed.rejected.length} 条格式不对被挡下` : '清单里没有这张单'}）。任务没动，请人看一眼。`,
        ]),
      };
    } else if (duplicated.has(issue)) {
      outcome = {
        acted: null,
        left: '会话对这张单交了不止一个裁决',
        text: diagnosisText(item, model, null, [
          '每张单只许交一个裁决，会话交了多个，一个都没执行。任务没动，请人看一眼。',
        ]),
      };
    } else if (mine[0] === undefined || mine[0].parkSeq !== item.park.seq) {
      outcome = {
        acted: null,
        left: '裁决里的停下编号对不上',
        text: diagnosisText(item, model, mine[0] ?? null, [
          `裁决带的 parkSeq ${mine[0]?.parkSeq} 和这一次停下（${item.park.seq}）对不上，没有执行。`,
        ]),
      };
    } else {
      // 执行前再问一次：这一次停下还停着、编号没变（会话跑了一阵，人可能已经点了继续）
      let still = false;
      try {
        const snap = await deps.status(item.workflowId);
        still = snap !== 'gone' && snap.phase === 'parked' && snap.park?.seq === item.park.seq;
      } catch (err) {
        result.problems.push(`${ref} 执行前没问到工作流：${errMessage(err)}`);
        continue;
      }
      if (!still) {
        deps.log('info', '指挥官：这一次停下已经解开，不执行', { ref });
        continue;
      }
      outcome = await perform(deps, repo, item, mine[0], model);
    }
    if (outcome.acted) {
      result.acted.push({ ref, action: outcome.acted });
      deps.log('info', '指挥官：已执行', { ref, action: outcome.acted });
    } else {
      result.left.push({ ref, why: outcome.left ?? '留给人' });
    }
    await deps
      .notify({
        level: outcome.acted ? 'daily' : 'alert',
        key: noticeKey(item),
        title: outcome.acted
          ? `指挥官处理了 ${ref}：${COMMANDER_ACTION_WORDS[outcome.acted]}`
          : `指挥官看了 ${ref}，留给人处理`,
        body: outcome.text,
        taskId: item.row.taskId,
      })
      .catch((e: unknown) => {
        result.problems.push(`${ref} 的提醒没推出去：${errMessage(e)}`);
      });
  }
}

/** 过一遍停着的引擎任务，够条件的交指挥官。列不出、读不到操作记录照抛。 */
export async function triageParkedTasks(deps: ParkTriageDeps): Promise<ParkTriageResult> {
  const result: ParkTriageResult = {
    listed: 0,
    candidates: 0,
    claimed: 0,
    acted: [],
    left: [],
    problems: [],
  };
  const sw = await deps.enabled();
  if (!sw.on) {
    result.skipped = `开关关着：${sw.why}`;
    return result;
  }
  const now = deps.now();
  if (!(await deps.purposeConfigured())) {
    result.noModel = true;
    result.skipped = '路由用途「指挥官」没配模型，停下的任务没有人看';
    await deps
      .notify({
        level: 'alert',
        key: 'commander:no-model',
        title: '指挥官没配模型：用途「指挥官」下没有模型，停下的任务没人看',
        body: '路由页的「指挥官」一栏是空的（默认顺序 grok-4.7 → sonnet-5.5 → opus-5.5）。给它配上模型，指挥官会话才会去看停下超过 15 分钟的任务；配好之前这些任务只靠引擎续停和人处理。',
        taskId: null,
      })
      .catch((e: unknown) => deps.log('error', '指挥官：没配模型的警报没推出去', { error: errMessage(e) }));
    return result;
  }
  // 认领记录不能只看最近几天：一个停点可以挂很久，过了窗口再认领就违反「每次停下最多处理一次」。
  // 每日上限仍只按下面的 24 小时窗口计算；这里读的是 commander 自己的审计记录，不把历史操作混进来。
  const audits = await deps.audits(new Date(0));
  const handled = new Set<string>();
  let claimsToday = 0;
  for (const a of audits) {
    if (a.action !== COMMANDER_AUDIT_CLAIM) continue;
    const after = (a.after ?? {}) as { workflowId?: unknown; parkSeq?: unknown };
    if (typeof after.workflowId === 'string' && typeof after.parkSeq === 'number')
      handled.add(claimKey(after.workflowId, after.parkSeq));
    if (a.at.getTime() >= now.getTime() - 24 * 3_600_000) claimsToday += 1;
  }
  let remaining = PARK_TRIAGE_DAILY_CAP - claimsToday;
  const rows = await deps.tasks();
  result.listed = rows.length;
  const waiting: { row: ParkedRetryRow; workflowId: string; park: TaskParkInfo; at: number }[] = [];
  for (const row of rows) {
    if (!row.workflowId) continue;
    try {
      const snap = await deps.status(row.workflowId);
      if (snap === 'gone' || snap.phase !== 'parked' || !snap.park) continue;
      const park = snap.park;
      if (handled.has(claimKey(row.workflowId, park.seq))) continue;
      const at = Date.parse(park.at);
      const handoff = park.title === ROUNDS_HANDOFF_TITLE;
      if (!handoff && !(Number.isFinite(at) && now.getTime() - at >= PARK_TRIAGE_AFTER_MINUTES * 60_000))
        continue;
      waiting.push({ row, workflowId: row.workflowId, park, at: Number.isFinite(at) ? at : 0 });
    } catch (err) {
      result.problems.push(`${refOf(row)} 没问到工作流：${errMessage(err)}`);
    }
  }
  result.candidates = waiting.length;
  if (waiting.length > 0 && remaining <= 0) {
    result.skipped = `今天已处理 ${claimsToday} 张，到上限 ${PARK_TRIAGE_DAILY_CAP}，还有 ${waiting.length} 张等着`;
    return result;
  }
  waiting.sort((a, b) => a.at - b.at);
  const byRepo = new Map<string, typeof waiting>();
  for (const w of waiting) {
    const key = `${w.row.owner}/${w.row.name}`.toLowerCase();
    byRepo.set(key, [...(byRepo.get(key) ?? []), w]);
  }
  let sessions = 0;
  for (const group of byRepo.values()) {
    if (sessions >= PARK_TRIAGE_MAX_SESSIONS || remaining <= 0) break;
    const first = group[0];
    if (!first) continue;
    let repo: IntakeRepo | null;
    try {
      repo = await deps.findRepo(first.row.owner, first.row.name);
    } catch (err) {
      result.problems.push(`${first.row.owner}/${first.row.name} 没查到受管的仓：${errMessage(err)}`);
      continue;
    }
    if (repo === null) {
      result.problems.push(`${first.row.owner}/${first.row.name} 不是受管的仓，不交指挥官`);
      continue;
    }
    const requestId = `park-triage:${repo.owner}/${repo.name}:${now.getTime()}`;
    const items: ParkTriageItem[] = [];
    for (const w of group.slice(0, Math.min(PARK_TRIAGE_BATCH, remaining))) {
      try {
        await deps.claim({ row: w.row, workflowId: w.workflowId, park: w.park, requestId });
      } catch (err) {
        result.problems.push(`${refOf(w.row)} 认领没记进操作记录，这一轮不处理：${errMessage(err)}`);
        continue;
      }
      remaining -= 1;
      result.claimed += 1;
      const [detail, rounds] = await Promise.all([
        deps.detail(w.workflowId, w.park.seq).catch(() => null),
        deps.rounds(w.row.taskId).catch(() => null),
      ]);
      items.push({
        row: w.row,
        workflowId: w.workflowId,
        park: w.park,
        handoff: w.park.title === ROUNDS_HANDOFF_TITLE,
        detail,
        rounds,
        spin: spinOf(w.park, rounds),
      });
    }
    if (items.length === 0) continue;
    sessions += 1;
    try {
      await triageRepo(deps, repo, items, requestId, result);
    } catch (err) {
      result.problems.push(`${repo.owner}/${repo.name} 这一批没处理完：${errMessage(err)}`);
    }
  }
  return result;
}

export class ParkTriageFailedError extends Error {
  readonly runId: number;
  constructor(runId: number, message: string) {
    super(message);
    this.name = 'ParkTriageFailedError';
    this.runId = runId;
  }
}

/** 跑一轮。记开始就失败（库连不上）原样抛；没跑成记 failed 再抛 ParkTriageFailedError。 */
export async function runParkTriageJob(deps: ParkTriageDeps): Promise<ScheduleResult> {
  const runId = await deps.runs.start(PARK_TRIAGE_JOB.id, deps.now());
  let result: ScheduleResult;
  let got: ParkTriageResult | undefined;
  try {
    got = await triageParkedTasks(deps);
    const line = `停着的引擎任务 ${got.listed} 张，够条件交指挥官的 ${got.candidates} 张，认领 ${got.claimed} 张，执行 ${got.acted.length} 张，留给人 ${got.left.length} 张`;
    if (got.noModel) result = { outcome: 'partial', why: `${got.skipped ?? '没配模型'}；${line}` };
    else if (got.problems.length > 0)
      result = { outcome: 'partial', why: `${line}；${got.problems.slice(0, 3).join('；')}` };
    else
      result = {
        outcome: 'ok',
        scanned: Math.max(1, got.listed),
        found: got.acted.length + got.left.length,
        why: got.skipped ? `${got.skipped}；${line}` : line,
      };
  } catch (err) {
    result = { outcome: 'failed', why: `指挥官会话没跑成：${errMessage(err)}` };
  }
  await deps.runs.finish(runId, result, deps.now());
  if (result.outcome === 'failed') {
    deps.log('error', '指挥官这一轮没跑成', { runId, why: result.why });
    throw new ParkTriageFailedError(runId, result.why);
  }
  deps.log('info', '指挥官这一轮跑完', { runId, acted: got?.acted ?? [], left: got?.left ?? [] });
  return result;
}
