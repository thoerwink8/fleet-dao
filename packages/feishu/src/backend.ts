// 调驾驶舱后端：经隧道走驾驶舱同一套接口（/api），一律带网关通行证；路由表标 acting=required 的才注明代表哪位创始人。
// 返回一律按 shared 里的约定校验：形状不对当场报错，不把坏数据往卡片上放。
// 只调 IntentRoutes（shared 的 intent-api.ts）：旧的九条飞书接口随 #1022 在后端删了，这边调它们的方法也一起删了。

import {
  ApiErrorBody,
  type FeishuActing,
  FeishuJoinRequest,
  FeishuJoinResponse,
  FeishuRejectionRequest,
  FeishuRejectionResponse,
  FeishuUsageReportRequest,
  FeishuUsageSnapshot,
  IntentCardAckRequest,
  IntentCardAckResponse,
  type IntentCardAckSchema,
  IntentCardsResponse,
  IntentCursorsResponse,
  IntentIntakeMessageRequest,
  IntentIntakeMessageResponse,
  IntentIntakeRecallRequest,
  IntentIntakeRecallResponse,
  IntentRoutes,
  WEB_API_PREFIX,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { z } from 'zod';

/**
 * 代表哪位创始人（飞书 open_id）。后端那边的同名常量是 shared/web-api.ts 的 FEISHU_ACTING_HEADER（后端的 PR #9 在加）；
 * test/static.test.ts 核对两边一致。
 */
export const ACTING_HEADER = 'X-Fleet-Acting-Feishu';

/** 意图（#553 第 4 条）：收原话、撤回、补漏游标、意图卡和回执，约定在 shared 的 intent-api.ts。 */
export type IntakeMessage = z.input<typeof IntentIntakeMessageRequest>;
export type IntakeResult = z.output<typeof IntentIntakeMessageResponse>;
export type IntakeRecall = z.input<typeof IntentIntakeRecallRequest>;
export type IntakeRecallResult = z.output<typeof IntentIntakeRecallResponse>;
export type IntakeCursors = z.output<typeof IntentCursorsResponse>;
export type IntentCardBatch = z.output<typeof IntentCardsResponse>;
export type IntentCard = IntentCardBatch['items'][number];
export type IntentCardAck = z.input<typeof IntentCardAckSchema>;
export type IntentCardAckReport = z.output<typeof IntentCardAckResponse>;
export type FeishuRejection = z.input<typeof FeishuRejectionRequest>;
export type FeishuJoin = z.input<typeof FeishuJoinRequest>;
export type FeishuUsageReport = z.input<typeof FeishuUsageReportRequest>;
export type FeishuUsage = z.output<typeof FeishuUsageSnapshot>;

/**
 * unreachable = 连不上；timeout = 超时；aborted = 网关自己叫停（停机）；rejected = 4xx（带 code）；
 * server = 5xx；bad_response = 返回的形状不对。
 */
export type BackendErrorKind = 'unreachable' | 'timeout' | 'aborted' | 'rejected' | 'server' | 'bad_response';

export class BackendError extends Error {
  readonly kind: BackendErrorKind;
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly details: unknown;
  /** 后端自己说的白话（ApiErrorBody.error.message），能直接给人看；没有就是 undefined。 */
  readonly said: string | undefined;
  constructor(
    kind: BackendErrorKind,
    message: string,
    opts: {
      status?: number;
      code?: string | undefined;
      details?: unknown;
      said?: string | undefined;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'BackendError';
    this.kind = kind;
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
    this.said = opts.said;
  }
}

/** 给人看的一句：后端说了白话就用它，否则按种类说。 */
export function describe(err: unknown): string {
  if (!(err instanceof BackendError)) return '网关这边出错了（已记日志）';
  if (err.said) return err.said;
  switch (err.kind) {
    case 'timeout':
      return '后端没及时回应';
    case 'unreachable':
      return '后端现在连不上';
    case 'server':
      return '后端出错了';
    case 'bad_response':
      return '后端回的内容看不懂（已记日志）';
    case 'aborted':
      return '网关正在重启';
    case 'rejected':
      return `后端拒收（HTTP ${err.status}）`;
  }
}

/** 这类错误多半是暂时的：重试或稍后再来。 */
export function isTransient(err: unknown): boolean {
  return (
    err instanceof BackendError &&
    (err.kind === 'unreachable' || err.kind === 'timeout' || err.kind === 'server')
  );
}

export interface Acting {
  openId: string;
}

export interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
}

export interface Backend {
  /** 收原话：代表说这句话的那位创始人。没存成（连不上、超时、5xx、被拒）一律抛：调用方据此标「没记成」、标补漏。 */
  intake(as: Acting, body: IntakeMessage, opts?: CallOptions): Promise<IntakeResult>;
  /** 收撤回（飞书的撤回事件不带是谁撤的）。 */
  intakeRecall(body: IntakeRecall, opts?: CallOptions): Promise<IntakeRecallResult>;
  /** 补漏前问每个会话存到哪了；带 chatId 只问一个（没见过的回 known=false）。 */
  intakeCursors(chatId?: string, opts?: CallOptions): Promise<IntakeCursors>;
  /** 长轮询要发、要改的意图卡。读不了库后端回 503，这里抛，不当成「没有要发的」。 */
  intentCards(waitSeconds: number, signal?: AbortSignal): Promise<IntentCardBatch>;
  /** 意图卡的回执：按条处理，后端认不出的跳过（回 skipped 数）。 */
  ackIntentCards(acks: IntentCardAck[]): Promise<IntentCardAckReport>;
  /** 白名单群里不是创始人说的：只有群、open_id 末 4 位、时刻、原因。 */
  recordRejection(body: FeishuRejection, opts?: CallOptions): Promise<{ recorded: true }>;
  /** 白名单外的人进了群。 */
  recordJoin(body: FeishuJoin, opts?: CallOptions): Promise<{ recorded: number }>;
  /** 上次报到之后新打出去的次数。回这个月的累计。 */
  reportUsage(body: FeishuUsageReport, opts?: CallOptions): Promise<FeishuUsage>;
}

export interface BackendOptions {
  baseUrl: string;
  gatewayToken: string;
  fetch?: typeof fetch;
  /** 单次请求默认超时。 */
  timeoutMs?: number;
}

interface Route {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  acting: FeishuActing;
}

interface Call {
  params?: Record<string, string>;
  /** acting=required 的路由必须给，none 的不许给。 */
  acting?: Acting | undefined;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export function createBackend(options: BackendOptions): Backend {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const defaultTimeout = options.timeoutMs ?? 5_000;
  const base = options.baseUrl.replace(/\/+$/, '');

  async function call<S extends z.ZodType>(route: Route, req: Call, schema: S): Promise<z.output<S>> {
    // 代表谁跟着路由表走：该带的没带、不该带的带了，都是网关自己的错，当场报出来。
    if ((route.acting === 'required') !== (req.acting !== undefined)) {
      throw new Error(
        `${route.method} ${route.path} 的 acting 是 ${route.acting}，调用时却${req.acting ? '带了' : '没带'}代表人`,
      );
    }
    const path = fill(route.path, req.params ?? {});
    const url = new URL(`${base}${WEB_API_PREFIX}${path}`);
    for (const [k, v] of Object.entries(req.query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    const timeoutMs = req.timeoutMs ?? defaultTimeout;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = req.signal ? AbortSignal.any([timeout, req.signal]) : timeout;
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.gatewayToken}`,
      accept: 'application/json',
      'user-agent': 'fleet-feishu',
    };
    if (req.acting) headers[ACTING_HEADER.toLowerCase()] = req.acting.openId;
    if (req.body !== undefined) headers['content-type'] = 'application/json';
    const where = `${route.method} ${route.path}`;

    let res: Response;
    try {
      res = await doFetch(url, {
        method: route.method,
        headers,
        ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
        signal,
      });
    } catch (err) {
      if (req.signal?.aborted)
        throw new BackendError('aborted', `${where}：网关在停机，请求已撤回`, { cause: err });
      if (timeout.aborted)
        throw new BackendError('timeout', `${where}：${timeoutMs} 毫秒没回应`, { cause: err });
      throw new BackendError('unreachable', `${where}：连不上后端（${reasonOf(err)}）`, { cause: err });
    }

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (timeout.aborted)
        throw new BackendError('timeout', `${where}：${timeoutMs} 毫秒没读完回应`, { cause: err });
      throw new BackendError('unreachable', `${where}：读回应时断了（${reasonOf(err)}）`, { cause: err });
    }
    let json: unknown;
    try {
      json = text.trim() ? JSON.parse(text) : {};
    } catch {
      if (!res.ok) {
        throw new BackendError(res.status >= 500 ? 'server' : 'rejected', `${where}：HTTP ${res.status}`, {
          status: res.status,
        });
      }
      throw new BackendError('bad_response', `${where}：回的不是 JSON`, { status: res.status });
    }

    if (!res.ok) {
      const body = ApiErrorBody.safeParse(json);
      const code = body.success ? body.data.error.code : undefined;
      const message = body.success ? body.data.error.message : `HTTP ${res.status}`;
      const details = body.success ? body.data.error.details : undefined;
      throw new BackendError(res.status >= 500 ? 'server' : 'rejected', `${where}：${message}`, {
        status: res.status,
        code,
        details,
        said: body.success ? message : undefined,
      });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new BackendError('bad_response', `${where}：返回的形状和约定对不上`, {
        status: res.status,
        details: parsed.error.issues.slice(0, 5),
      });
    }
    return parsed.data;
  }

  return {
    intake: (as, body, opts) =>
      call(
        IntentRoutes.intakeMessage,
        {
          acting: as,
          body: IntentIntakeMessageRequest.parse(body),
          timeoutMs: opts?.timeoutMs,
          signal: opts?.signal,
        },
        IntentIntakeMessageResponse,
      ),

    intakeRecall: (body, opts) =>
      call(
        IntentRoutes.intakeRecall,
        { body: IntentIntakeRecallRequest.parse(body), timeoutMs: opts?.timeoutMs, signal: opts?.signal },
        IntentIntakeRecallResponse,
      ),

    intakeCursors: (chatId, opts) =>
      call(
        IntentRoutes.cursors,
        { query: { chatId }, timeoutMs: opts?.timeoutMs, signal: opts?.signal },
        IntentCursorsResponse,
      ),

    intentCards: (waitSeconds, signal) =>
      call(
        IntentRoutes.cards,
        { query: { waitSeconds }, timeoutMs: waitSeconds * 1000 + 10_000, signal },
        IntentCardsResponse,
      ),

    ackIntentCards: (acks) =>
      call(IntentRoutes.ackCards, { body: IntentCardAckRequest.parse({ acks }) }, IntentCardAckResponse),

    recordRejection: (body, opts) =>
      call(
        IntentRoutes.intakeRejection,
        { body: FeishuRejectionRequest.parse(body), timeoutMs: opts?.timeoutMs, signal: opts?.signal },
        FeishuRejectionResponse,
      ),

    recordJoin: (body, opts) =>
      call(
        IntentRoutes.intakeJoin,
        { body: FeishuJoinRequest.parse(body), timeoutMs: opts?.timeoutMs, signal: opts?.signal },
        FeishuJoinResponse,
      ),

    reportUsage: (body, opts) =>
      call(
        IntentRoutes.usage,
        { body: FeishuUsageReportRequest.parse(body), timeoutMs: opts?.timeoutMs, signal: opts?.signal },
        FeishuUsageSnapshot,
      ),
  };
}

function fill(path: string, params: Record<string, string>): string {
  return path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`路径 ${path} 缺参数 ${name}`);
    return encodeURIComponent(value);
  });
}

function reasonOf(err: unknown): string {
  const cause =
    err instanceof Error ? (err.cause as { code?: string; message?: string } | undefined) : undefined;
  return cause?.code ?? cause?.message ?? errMessage(err);
}
