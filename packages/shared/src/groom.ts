// 临时指挥官整理待办（母单 #1335 第 3 片，#1338；创始人 2026-10-08「能不能临时调用指挥官」「按推荐」）：引擎里一个短命、无状态的会话，
// 没单可挑、待办还有很多时，叫它补写老单、拆大单、开新单、建议关闭过期的单。
// 三条路叫它（引擎拉单一轮的结尾、驾驶舱按钮、命令行 fleet-api groom）走同一个入口：记一条「点了」(groom.request)，引擎每几秒看一眼，
// 接手记 groom.start、整理完记 groom.done，三种都在 audit_log，target 一律 groom。一次整理走到哪不另存，读的时候从记录现算：
// 后端给页面看、引擎找没人接的、三个入口判能不能叫，都用这里同一份，不会各算各的。
// 改这里之前必须知道：
// - 同一时刻只一个（全局，不分仓：会话占机器内存，一个够）；每个仓滚动 24 小时最多 GROOM_MAX_PER_DAY 次，数「接手了」的，没接手就作废的不算。
// - 自动叫（引擎拉单一轮发现没活可挑）另要求距这个仓上次接手超过 GROOM_AUTO_GAP_MS；人点的、命令行叫的不受这条管，但受次数和锁管。
// - 引擎总开关关着一律拒（关着的引擎不起会话，点了也没人接）。
// - 点了太久没人接手就作废，引擎也不再接：免得引擎停了一夜、一起来把隔夜点的全做一遍。接手了太久没回结果当没做成：引擎多半中途重启了，
//   同时把锁放开，不让一个死掉的整理一直占着。
// - 认不出的记录（字段对不上）不当没有：数进 unreadable，调用方写日志、页面写明有几条没读懂。

import { z } from 'zod';

export const GROOM_TARGET = 'groom';
export const GROOM_ACTION = {
  request: 'groom.request',
  start: 'groom.start',
  done: 'groom.done',
} as const;
/** 引擎记接手、整理完时写的「谁」。 */
export const GROOM_ENGINE_ACTOR = 'engine:groom';
/** 拉单一轮发现没活可挑、自己叫的那条点击记的「谁」。 */
export const GROOM_AUTO_ACTOR = 'engine:intake';

/** 每次整理最多开几张新单、补写几张老单。 */
export const GROOM_MAX_NEW_ISSUES = 5;
export const GROOM_MAX_AMENDS = 10;
/** 每次整理最多对几张单下「仍成立 / 过期 / 要人拍」的判断（贴标签、留言）。 */
export const GROOM_MAX_REVIEWS = 40;
/** 每个仓滚动 24 小时最多整理几次。 */
export const GROOM_MAX_PER_DAY = 3;
export const GROOM_WINDOW_MS = 24 * 60 * 60_000;
/** 自动叫：距这个仓上次接手超过这么久才叫（6 小时）。 */
export const GROOM_AUTO_GAP_MS = 6 * 60 * 60_000;
/** 引擎多久看一眼有没有人点（毫秒）。 */
export const GROOM_POLL_MS = 5_000;
/** 点了这么久引擎还没接手：作废，引擎也不再接。 */
export const GROOM_REQUEST_TTL_MS = 15 * 60_000;
/** 引擎接手这么久还没回结果：当没做成，锁放开。会话时限 40 分钟，加上读单、开单的时间。 */
export const GROOM_RUNNING_LIMIT_MS = 90 * 60_000;
/** 页面上列最近多久的。 */
export const GROOM_LIST_WINDOW_MS = GROOM_WINDOW_MS;

export type GroomSource = 'auto' | 'http' | 'cli';

/** 操作记录里的一行，只取用得上的几样。 */
export interface GroomAuditRow {
  at: Date;
  action: string;
  actorId: string;
  after: unknown;
  ok: boolean;
  error: string | null;
}

const Repo = z.string().regex(/^[^/\s]+\/[^/\s]+$/, '仓要写成 owner/name');

/** 一次整理做成了什么：写进 groom.done 的记录，也给页面看。 */
export const GroomResultSchema = z.object({
  /** 开了哪几张新单（号、标题、从哪张大单拆出来的）。 */
  opened: z.array(
    z.object({
      number: z.number().int().positive(),
      title: z.string(),
      splitFrom: z.number().int().positive().optional(),
    }),
  ),
  /** 补写了哪几张老单（号）。 */
  amended: z.array(z.number().int().positive()),
  /** 判为「仍成立、适合引擎」、贴了「整理过」的单（补写过的也算）。 */
  groomed: z.array(z.number().int().positive()),
  /** 建议关闭的单（只留言、贴「待补」，没关）。 */
  suggestedClose: z.array(z.number().int().positive()),
  /** 贴了「要人拍」的单。 */
  flagged: z.array(z.number().int().positive()),
  /** 被引擎侧校验挡下的条目：哪一条、为什么（会话越权、超限、重复、格式不对都在这里）。 */
  rejected: z.array(z.object({ what: z.string(), why: z.string() })),
  /** 实际回话的模型（会话报的）；没报不给。 */
  model: z.string().optional(),
  /** 选路挑中的模型和路由；会话没起来时没有。 */
  routeId: z.string().optional(),
  usage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      cacheReadTokens: z.number().optional(),
      cacheWriteTokens: z.number().optional(),
    })
    .optional(),
  costUsd: z.number().optional(),
  /** 会话自己写的一段总结（给人看，被截断到几百字）。 */
  summary: z.string(),
});
export type GroomResult = z.infer<typeof GroomResultSchema>;

/** 记录里 after 的三种形状。 */
export const GroomRequestRecord = z.object({
  requestId: z.string().min(1),
  repo: Repo,
  source: z.enum(['auto', 'http', 'cli']),
});
export const GroomStartRecord = z.object({ requestId: z.string().min(1), repo: Repo.optional() });
export const GroomDoneRecord = z.object({
  requestId: z.string().min(1),
  repo: Repo.optional(),
  result: GroomResultSchema.optional(),
});

export interface GroomRequestView {
  requestId: string;
  repo: string;
  source: GroomSource;
  requestedAt: string;
  by: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'expired';
  startedAt?: string;
  finishedAt?: string;
  /** 没做成 / 作废的原因。 */
  why?: string;
  /** 做成了什么；没做成但已经做了一部分也给。 */
  result?: GroomResult;
}

function minutes(ms: number): number {
  return Math.round(ms / 60_000);
}

/**
 * 把 target=groom 的操作记录并成一次一次的整理，新的在前。rows 不要求有序。
 * 认不出的记录（after 对不上形状、接手 / 结束找不到对应的点击）数进 unreadable，不丢也不瞎拼。
 */
export function foldGroomRequests(
  rows: readonly GroomAuditRow[],
  now: Date,
): { requests: GroomRequestView[]; unreadable: number } {
  let unreadable = 0;
  const rank = (action: string) => (action === GROOM_ACTION.request ? 0 : 1);
  const sorted = [...rows].sort((a, b) => rank(a.action) - rank(b.action) || a.at.getTime() - b.at.getTime());
  const byId = new Map<
    string,
    {
      repo: string;
      source: GroomSource;
      requestedAt: Date;
      by: string;
      startedAt?: Date;
      done?: { at: Date; ok: boolean; error: string | null; result?: GroomResult };
    }
  >();
  for (const row of sorted) {
    if (row.action === GROOM_ACTION.request) {
      const parsed = GroomRequestRecord.safeParse(row.after);
      if (!parsed.success || byId.has(parsed.data.requestId)) {
        unreadable += 1;
        continue;
      }
      byId.set(parsed.data.requestId, {
        repo: parsed.data.repo,
        source: parsed.data.source,
        requestedAt: row.at,
        by: row.actorId,
      });
    } else if (row.action === GROOM_ACTION.start) {
      const parsed = GroomStartRecord.safeParse(row.after);
      const req = parsed.success ? byId.get(parsed.data.requestId) : undefined;
      if (!req) {
        unreadable += 1;
        continue;
      }
      req.startedAt ??= row.at;
    } else if (row.action === GROOM_ACTION.done) {
      const parsed = GroomDoneRecord.safeParse(row.after);
      const id = parsed.success
        ? parsed.data.requestId
        : GroomStartRecord.safeParse(row.after).data?.requestId;
      const req = id === undefined ? undefined : byId.get(id);
      // 没跑成的那一条可以不带 result；跑成的必须认得出，认不出不当成做成了
      if (!req || (row.ok && !parsed.success)) {
        unreadable += 1;
        continue;
      }
      req.done = {
        at: row.at,
        ok: row.ok,
        error: row.error,
        ...(parsed.success && parsed.data.result ? { result: parsed.data.result } : {}),
      };
    } else {
      unreadable += 1;
    }
  }

  const t = now.getTime();
  const requests = [...byId.entries()].map(([requestId, r]): GroomRequestView => {
    const base = {
      requestId,
      repo: r.repo,
      source: r.source,
      requestedAt: r.requestedAt.toISOString(),
      by: r.by,
      ...(r.startedAt ? { startedAt: r.startedAt.toISOString() } : {}),
    };
    if (r.done) {
      return {
        ...base,
        state: r.done.ok ? 'done' : 'failed',
        finishedAt: r.done.at.toISOString(),
        ...(r.done.ok ? {} : { why: r.done.error ?? '引擎说没整理成，没写原因' }),
        ...(r.done.result ? { result: r.done.result } : {}),
      };
    }
    if (r.startedAt) {
      const age = t - r.startedAt.getTime();
      if (age > GROOM_RUNNING_LIMIT_MS) {
        return {
          ...base,
          state: 'failed',
          why: `引擎 ${minutes(age)} 分钟前接手，到现在没回结果（多半中途重启了）：这一次没整理成`,
        };
      }
      return { ...base, state: 'running' };
    }
    const waited = t - r.requestedAt.getTime();
    if (waited > GROOM_REQUEST_TTL_MS) {
      return {
        ...base,
        state: 'expired',
        why: `点了 ${minutes(waited)} 分钟引擎都没接手，作废了：引擎没在跑，或总开关一直关着`,
      };
    }
    return { ...base, state: 'queued' };
  });
  requests.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  return { requests, unreadable };
}

/** 这个仓滚动 24 小时里接手了几次、还剩几次、上次什么时候接手的。 */
export function groomQuota(
  requests: readonly GroomRequestView[],
  repo: string,
  now: Date,
): { used: number; remaining: number; max: number; lastStartedAt: string | null } {
  const since = now.getTime() - GROOM_WINDOW_MS;
  const started = requests
    .filter((r) => r.repo.toLowerCase() === repo.toLowerCase() && r.startedAt !== undefined)
    .map((r) => r.startedAt as string)
    .filter((at) => Date.parse(at) >= since)
    .sort();
  const used = started.length;
  return {
    used,
    remaining: Math.max(0, GROOM_MAX_PER_DAY - used),
    max: GROOM_MAX_PER_DAY,
    lastStartedAt: started.at(-1) ?? null,
  };
}

export type GroomRefusalReason = 'engine_off' | 'busy' | 'daily_cap' | 'too_soon';

export type GroomJudgement =
  | { ok: true; used: number; remainingAfter: number }
  | { ok: false; reason: GroomRefusalReason; why: string };

/**
 * 能不能叫一次整理（三个入口和引擎接手时都用这一份）。顺序：总开关 → 锁 → 每日次数 → 自动叫的间隔。
 * engine：引擎总开关此刻的样子（on=false 带原因）；读不到的调用方自己报没查成，不要拿 on 顶。
 */
export function judgeGroomRequest(input: {
  repo: string;
  source: GroomSource;
  now: Date;
  requests: readonly GroomRequestView[];
  engine: { on: true } | { on: false; why: string };
  /** 接手时判：这一条自己已经在 requests 里排队，不算「别人占着锁」。 */
  ignoreRequestId?: string;
}): GroomJudgement {
  if (!input.engine.on) {
    return { ok: false, reason: 'engine_off', why: `引擎总开关关着，不整理：${input.engine.why}` };
  }
  // 接手时（给了 ignoreRequestId）只有「正在做」的占着锁：别的排着队的是后来的，轮到它们时再判
  const busy = input.requests.find(
    (r) =>
      r.requestId !== input.ignoreRequestId &&
      (r.state === 'running' || (r.state === 'queued' && input.ignoreRequestId === undefined)),
  );
  if (busy) {
    return {
      ok: false,
      reason: 'busy',
      why: `已经有一次整理在${busy.state === 'running' ? '做' : '排队'}（${busy.repo}，${busy.requestedAt}）：同一时刻只做一个，等它做完`,
    };
  }
  const quota = groomQuota(
    input.requests.filter((r) => r.requestId !== input.ignoreRequestId),
    input.repo,
    input.now,
  );
  if (quota.remaining <= 0) {
    return {
      ok: false,
      reason: 'daily_cap',
      why: `${input.repo} 最近 24 小时已经整理了 ${quota.used} 次（每天最多 ${quota.max} 次）：等最早那次滚出 24 小时`,
    };
  }
  if (
    input.source === 'auto' &&
    quota.lastStartedAt !== null &&
    input.now.getTime() - Date.parse(quota.lastStartedAt) < GROOM_AUTO_GAP_MS
  ) {
    return {
      ok: false,
      reason: 'too_soon',
      why: `${input.repo} 上次整理在 ${quota.lastStartedAt}，不到 ${GROOM_AUTO_GAP_MS / 3_600_000} 小时，不自动再叫`,
    };
  }
  return { ok: true, used: quota.used, remainingAfter: quota.remaining - 1 };
}
