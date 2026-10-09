// 临时指挥官整理待办（母单 #1335 第 3 片，#1338；创始人 2026-10-08「能不能临时调用指挥官……是管理分配任务的」「按推荐」；
// 指挥官 2026-10-08 补：#1342 发到法国后引擎拉了两张前提已过期的老单，所以「单还成不成立」交给这个会话判，判完贴「整理过」才进候选）。
// 引擎里一个短命、无状态的会话，不是常驻席位。三条路叫它（拉单一轮的结尾、驾驶舱按钮、fleet-api groom）都只记一条 groom.request
// （jobs/groom-request.ts），这里每几秒看一眼，有排队的就接手：记 groom.start → 读仓里的单 → 起会话 → 解析清单 → 引擎执行 → 记 groom.done 并推通知。
//
// 改这里之前必须知道：
// - 会话手上没有 GitHub 令牌，也不执行任何写操作：它交一份清单，执行在 groom-plan.ts（先校验限额和禁止项再动手）。这是「会话的提示词 +
//   引擎侧校验」两道保险，会话绕不过。
// - 同一时刻只一个：判法是 shared 的 judgeGroomRequest（接手时再判一遍：叫的时候和接手的时候之间状态可能变了）；总开关关着或别的在做的，
//   这一条留在队里等（最多等到作废）；每日次数用完、自动叫的间隔没到的，当场记一条没整理成。
// - 没整理成要明确报失败，不当成「没事」：模型起不来、超时、回答里没有清单、GitHub 全写不进，都记 groom.done ok=false 并推一条「alert」通知；
//   整理成了（哪怕一条判断都没下）推一条总结。
// - 记「接手」写不进就不整理（不然页面一直看到没人接手、下一眼又接一次）。记「整理完」写不进只记日志：驾驶舱 90 分钟后会把它标成没整理成。
// - 在跑的那一次不等：停机时会话由停机收尾一起收（登记进一次性会话的清单，排空和切号都能停下它）。

import { ENGINE_LABEL, GROOMED_LABEL, issueColumnRefs, type StandardPath } from '@fleet-dao/conventions';
import type { ClosedIssueRow } from '@fleet-dao/github';
import {
  foldGroomRequests,
  GROOM_POLL_MS,
  GROOM_WINDOW_MS,
  type GroomAuditRow,
  type GroomRequestView,
  type GroomResult,
  judgeGroomRequest,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { type GithubWhitelist, isTrusted } from '@fleet-dao/store';
import { executeGroomPlan, type GroomWrites, parseGroomPlan } from './groom-plan.ts';
import { renderGroomPrompt } from './groom-prompt.ts';
import type { IntakeIssue, IntakeMilestone, IntakeRepo } from './intake.ts';

/** 会话最长几分钟（读单、读检出、写清单）。 */
export const GROOM_SESSION_MINUTES = 40;
/** 查重时往回看多少天关掉的单。 */
export const GROOM_CLOSED_DAYS = 30;

/** 这一次整理要用到的 GitHub 现状。 */
export interface GroomFacts {
  issues: IntakeIssue[];
  openMilestones: IntakeMilestone[];
  closed: ClosedIssueRow[];
  pulls: { number: number; title: string; body: string }[];
  /** 主线头（完整提交号）：只读检出钉在它上面。 */
  mainHead: string;
}

export interface GroomSessionInput {
  repo: IntakeRepo;
  requestId: string;
  prompt: string;
  mainHead: string;
  timeoutMinutes: number;
}

export type GroomSessionOutcome =
  | {
      ok: true;
      answer: string;
      model?: string | undefined;
      routeId?: string | undefined;
      usage?: GroomResult['usage'];
      costUsd?: number | undefined;
    }
  | { ok: false; why: string; routeId?: string | undefined };

export interface GroomNotice {
  level: 'daily' | 'alert';
  key: string;
  title: string;
  body: string;
}

export interface GroomRunDeps {
  rows(since: Date): Promise<GroomAuditRow[]>;
  engineMaster(): Promise<{ on: true } | { on: false; why: string }>;
  recordStart(input: { requestId: string; repo: string; at: Date }): Promise<void>;
  recordDone(
    input: { requestId: string; repo: string; at: Date } & (
      | { ok: true; result: GroomResult }
      | { ok: false; error: string; result?: GroomResult }
    ),
  ): Promise<void>;
  /** 受管的仓里按 owner/name 找（不分大小写）；没有回 null。 */
  findRepo(slug: string): Promise<IntakeRepo | null>;
  whitelist(): Promise<GithubWhitelist>;
  readFacts(repo: IntakeRepo): Promise<GroomFacts>;
  /** 改标准的路径清单（standard-paths.json）。读不到、认不出照抛：不当成「没有标准路径」。 */
  standardPaths(): Promise<readonly StandardPath[]>;
  /**
   * 最近一段里合并了的 PR（带正文，用来认需求栏 Refs）。
   * 抛错 = 没读到分片关系：整理照常跑，摘要里写明，不当成「一个都没有」。
   */
  readMergedPulls(repo: IntakeRepo): Promise<{ number: number; title: string; body: string }[]>;
  /** 起会话（选路按用途 groom、只读检出、不带令牌）。 */
  runSession(input: GroomSessionInput): Promise<GroomSessionOutcome>;
  /** 这个仓上的写操作（只有四种，没有关单）。 */
  writes(repo: IntakeRepo): GroomWrites;
  /** 推一条通知（提醒中心 + 飞书）。 */
  notify(notice: GroomNotice): Promise<void>;
  now(): Date;
  log(level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void;
}

/** 整理没成：带上已经做了的部分（失败也要让人看到开了什么）。 */
export class GroomFailedError extends Error {
  readonly result: GroomResult | undefined;
  constructor(message: string, result?: GroomResult) {
    super(message);
    this.name = 'GroomFailedError';
    this.result = result;
  }
}

/** 一次整理：读 → 会话 → 清单 → 执行。成了回结果；没成抛 GroomFailedError。 */
export async function groomRepo(deps: GroomRunDeps, req: GroomRequestView): Promise<GroomResult> {
  const repo = await deps.findRepo(req.repo);
  if (repo === null) throw new GroomFailedError(`库里没有受管的仓 ${req.repo}`);
  const [whitelist, facts, standardPaths] = await Promise.all([
    deps.whitelist(),
    deps.readFacts(repo),
    deps.standardPaths(),
  ]);
  // 合并了的分片 PR 不在开着的 PR 里。这一次读失败不能拖垮整理，也不能当成「没有」
  let mergedPulls: { number: number; title: string; refs: number[] }[] | null;
  try {
    const rows = await deps.readMergedPulls(repo);
    mergedPulls = rows.map((p) => ({
      number: p.number,
      title: p.title,
      refs: issueColumnRefs(p.body).refs,
    }));
  } catch (err) {
    mergedPulls = null;
    deps.log('warn', '整理待办：没读到分片关系', { repo: req.repo, error: errMessage(err) });
  }
  const noteUnread = (text: string) => (mergedPulls === null ? `${text}\n没读到分片关系` : text);
  // 会话只看得到、也只能点到作者在白名单里的单（陌生人的正文不进提示词）
  const trusted = new Map(
    facts.issues.filter((i) => isTrusted(i.author, whitelist)).map((i) => [i.number, i]),
  );
  const now = deps.now();
  const prompt = renderGroomPrompt({
    repo: req.repo,
    issues: [...trusted.values()],
    // 「让 AI 接活」打开的时刻；关着的仓（命令行 / 按钮叫的）没有，所有单都当老单
    autoDispatchSince: repo.autoDispatchSince ?? new Date(0).toISOString(),
    alreadyGroomed: new Set(
      [...trusted.values()]
        .filter((i) => i.labels.includes(GROOMED_LABEL) || i.labels.includes(ENGINE_LABEL))
        .map((i) => i.number),
    ),
    recentClosed: facts.closed,
    openPulls: facts.pulls.map((p) => ({
      number: p.number,
      title: p.title,
      refs: issueColumnRefs(p.body).refs,
    })),
    mergedPulls,
    mainHead: facts.mainHead,
    now,
  });
  const session = await deps.runSession({
    repo,
    requestId: req.requestId,
    prompt,
    mainHead: facts.mainHead,
    timeoutMinutes: GROOM_SESSION_MINUTES,
  });
  if (!session.ok) throw new GroomFailedError(noteUnread(`会话没跑成：${session.why}`));
  const parsed = parseGroomPlan(session.answer);
  if (!parsed.ok) throw new GroomFailedError(noteUnread(parsed.why));
  const executed = await executeGroomPlan(
    parsed.plan,
    {
      requestId: req.requestId,
      now,
      trusted,
      similar: [
        ...facts.issues.map((i) => ({
          number: i.number,
          title: i.title,
          body: i.body,
          kind: 'issue' as const,
        })),
        ...facts.closed.map((c) => ({
          number: c.number,
          title: c.title,
          body: c.body,
          kind: 'issue' as const,
        })),
        ...facts.pulls.map((p) => ({
          number: p.number,
          title: p.title,
          body: p.body,
          kind: 'pull' as const,
        })),
      ],
      standardPaths,
      // 含陌生人开的：他们的正文不进提示词，但「上一片还开着」仍要认
      openIssues: facts.issues.map((i) => ({ number: i.number, title: i.title, body: i.body })),
      // 会话说「已经合过」不算。null 是没读到，空数组是读到了、没有。
      mergedPulls,
    },
    deps.writes(repo),
  );
  const result: GroomResult = {
    ...executed.result,
    summary: noteUnread(parsed.plan.summary || '会话没写总结'),
    ...(session.model === undefined ? {} : { model: session.model }),
    ...(session.routeId === undefined ? {} : { routeId: session.routeId }),
    ...(session.usage === undefined ? {} : { usage: session.usage }),
    ...(session.costUsd === undefined ? {} : { costUsd: session.costUsd }),
  };
  if (executed.attempted > 0 && executed.failed === executed.attempted) {
    throw new GroomFailedError(
      `清单里的 ${executed.attempted} 个写动作全都没写进 GitHub（${executed.result.rejected.at(-1)?.why ?? '原因不明'}）`,
      result,
    );
  }
  return result;
}

const list = (nums: readonly number[]) => (nums.length === 0 ? '无' : nums.map((n) => `#${n}`).join('、'));

/** 给人看的总结（通知正文）。 */
export function describeGroomResult(repo: string, r: GroomResult): string {
  const lines = [
    `${repo}：开了 ${r.opened.length} 张新单（${list(r.opened.map((o) => o.number))}），补写 ${r.amended.length} 张老单（${list(r.amended)}），` +
      `判为仍成立并贴「${GROOMED_LABEL}」${r.groomed.length} 张，建议关闭 ${r.suggestedClose.length} 张（${list(r.suggestedClose)}，只留言贴「待补」，没关），` +
      `贴「要人拍」${r.flagged.length} 张（${list(r.flagged)}）。`,
    `用的模型：${r.model ?? r.routeId ?? '会话没报'}${r.costUsd === undefined ? '' : `，花费约 ${r.costUsd} 美元`}${
      r.usage ? `，输入 ${r.usage.inputTokens ?? '?'} / 输出 ${r.usage.outputTokens ?? '?'} token` : ''
    }。`,
    `会话总结：${r.summary}`,
  ];
  if (r.rejected.length > 0) {
    lines.push(
      `引擎挡下 ${r.rejected.length} 条：${r.rejected
        .slice(0, 5)
        .map((x) => `${x.what}（${x.why}）`)
        .join('；')}${r.rejected.length > 5 ? '……' : ''}`,
    );
  }
  return lines.join('\n');
}

async function runOne(deps: GroomRunDeps, req: GroomRequestView): Promise<void> {
  // 记「接手」写不进就不整理
  await deps.recordStart({ requestId: req.requestId, repo: req.repo, at: deps.now() });
  deps.log('info', '整理待办：接手', { requestId: req.requestId, repo: req.repo, source: req.source });
  try {
    const result = await groomRepo(deps, req);
    await deps
      .recordDone({ requestId: req.requestId, repo: req.repo, at: deps.now(), ok: true, result })
      .catch((err: unknown) =>
        deps.log('error', '整理待办：整理完的回执没记进操作记录（驾驶舱会在接手 90 分钟后标成没整理成）', {
          requestId: req.requestId,
          error: errMessage(err),
        }),
      );
    await deps
      .notify({
        level: 'daily',
        key: `groom:done:${req.requestId}`,
        title: `临时指挥官整理了 ${req.repo} 的待办：开 ${result.opened.length}、补 ${result.amended.length}、建议关 ${result.suggestedClose.length}`,
        body: describeGroomResult(req.repo, result),
      })
      .catch((err: unknown) => deps.log('error', '整理待办：总结通知没推出去', { error: errMessage(err) }));
  } catch (err) {
    const why = errMessage(err);
    const partial = err instanceof GroomFailedError ? err.result : undefined;
    await deps
      .recordDone({
        requestId: req.requestId,
        repo: req.repo,
        at: deps.now(),
        ok: false,
        error: why,
        ...(partial ? { result: partial } : {}),
      })
      .catch((e: unknown) =>
        deps.log('error', '整理待办：失败的回执没记进操作记录', {
          requestId: req.requestId,
          error: errMessage(e),
        }),
      );
    deps.log('error', '整理待办没成', { requestId: req.requestId, repo: req.repo, error: why });
    await deps
      .notify({
        level: 'alert',
        key: `groom:failed:${req.requestId}`,
        title: `临时指挥官整理 ${req.repo} 的待办没成`,
        body: `${why}\n\n这一次算进今天的次数。${partial ? `\n失败前已经做了的：\n${describeGroomResult(req.repo, partial)}` : ''}`,
      })
      .catch((e: unknown) => deps.log('error', '整理待办：失败通知没推出去', { error: errMessage(e) }));
  }
}

/**
 * 看一眼：有排队的整理就接手（一次只接一个）。返回这一眼接手了几次（0 或 1）。
 * 读操作记录读不到原样抛（调用方记日志，下一眼再看）。
 */
export async function runGroomRequests(deps: GroomRunDeps): Promise<number> {
  const now = deps.now();
  const { requests, unreadable } = foldGroomRequests(
    await deps.rows(new Date(now.getTime() - GROOM_WINDOW_MS)),
    now,
  );
  if (unreadable > 0) deps.log('warn', '整理待办：有操作记录认不出', { unreadable });
  // 先点的先接
  const req = requests.filter((r) => r.state === 'queued').at(-1);
  if (!req) return 0;
  const verdict = judgeGroomRequest({
    repo: req.repo,
    source: req.source,
    now,
    requests,
    engine: await deps.engineMaster(),
    ignoreRequestId: req.requestId,
  });
  if (!verdict.ok) {
    // 总开关关着、别的正在做：留在队里等（最多等到作废）；次数用完、间隔没到：当场记一条没整理成
    if (verdict.reason === 'engine_off' || verdict.reason === 'busy') {
      deps.log('info', '整理待办：先不接手', {
        requestId: req.requestId,
        reason: verdict.reason,
        why: verdict.why,
      });
      return 0;
    }
    await deps.recordDone({
      requestId: req.requestId,
      repo: req.repo,
      at: now,
      ok: false,
      error: verdict.why,
    });
    deps.log('warn', '整理待办：拒了', {
      requestId: req.requestId,
      reason: verdict.reason,
      why: verdict.why,
    });
    return 0;
  }
  await runOne(deps, req);
  return 1;
}

export interface GroomPoller {
  /** 不再看新的；在做的那一次不等。 */
  stop(): void;
}

/** 每 everyMs 看一眼（上一眼还没完就跳过：同一时刻只做一个）。出错只记日志，下一眼照看。 */
export function startGroomRequests(
  deps: () => GroomRunDeps,
  options: { everyMs?: number } = {},
): GroomPoller {
  let running: Promise<void> | null = null;
  let stopped = false;
  const tick = () => {
    if (stopped || running) return;
    const d = deps();
    running = runGroomRequests(d)
      .then(() => undefined)
      .catch((err: unknown) => d.log('error', '整理待办：这一眼没看成', { error: errMessage(err) }))
      .finally(() => {
        running = null;
      });
  };
  const handle = setInterval(tick, options.everyMs ?? GROOM_POLL_MS);
  return {
    stop() {
      stopped = true;
      clearInterval(handle);
    },
  };
}

// —— 命令行：fleet-api groom <owner/仓名> [--note "<为什么>"] ——

export const GROOM_USAGE =
  '用法：fleet-api groom <owner/仓名> [--note "<为什么>"]（叫一次临时指挥官整理待办：补写老单、拆大单、开新单、判老单还成不成立；' +
  '只是排队，法国引擎几秒内接手，结果看驾驶舱或操作记录。引擎总开关关着、已经有一次在做、这个仓 24 小时内用完 3 次，都会拒。' +
  '退出码：0 排上队了；1 拒了或没查成；2 参数不对）';

const REPO_ARG = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/;

export class GroomUsageError extends Error {
  constructor(message: string) {
    super(`${message}。${GROOM_USAGE}`);
    this.name = 'GroomUsageError';
  }
}

export function parseGroomArgs(argv: readonly string[]): { repo: string; note?: string } {
  const positionals: string[] = [];
  let note: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--note') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new GroomUsageError('--note 后面要跟理由');
      note = value.trim().slice(0, 300);
    } else if (arg.startsWith('-')) {
      throw new GroomUsageError(`认不出参数 ${arg.split('=')[0]}`);
    } else positionals.push(arg);
  }
  if (positionals.length !== 1) throw new GroomUsageError('要一个参数：仓');
  const repo = positionals[0] ?? '';
  if (!REPO_ARG.test(repo)) throw new GroomUsageError(`认不出仓「${repo}」：要写成 owner/仓名`);
  return { repo, ...(note ? { note } : {}) };
}
