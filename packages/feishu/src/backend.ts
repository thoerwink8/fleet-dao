// 调驾驶舱后端：经隧道走驾驶舱同一套接口（/api），一律带网关通行证。
// 返回一律按 shared 里的约定校验：形状不对当场报错，不把坏数据往卡片上放。
// 飞书收缩后（#2047 提需求 F1）网关只调 IntentRoutes（shared 的 intent-api.ts）里的两条：进群记录、飞书接口用量。

import {
  ApiErrorBody,
  FeishuJoinRequest,
  FeishuJoinResponse,
  type FeishuRoute,
  FeishuUsageReportRequest,
  FeishuUsageSnapshot,
  IntentRoutes,
  WEB_API_PREFIX,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { z } from 'zod';

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

export interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
}

export interface Backend {
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

interface Call {
  body?: unknown;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export function createBackend(options: BackendOptions): Backend {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const defaultTimeout = options.timeoutMs ?? 5_000;
  const base = options.baseUrl.replace(/\/+$/, '');

  async function call<S extends z.ZodType>(route: FeishuRoute, req: Call, schema: S): Promise<z.output<S>> {
    const url = new URL(`${base}${WEB_API_PREFIX}${route.path}`);
    const timeoutMs = req.timeoutMs ?? defaultTimeout;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = req.signal ? AbortSignal.any([timeout, req.signal]) : timeout;
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.gatewayToken}`,
      accept: 'application/json',
      'user-agent': 'fleet-feishu',
    };
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

function reasonOf(err: unknown): string {
  const cause =
    err instanceof Error ? (err.cause as { code?: string; message?: string } | undefined) : undefined;
  return cause?.code ?? cause?.message ?? errMessage(err);
}
