// 调驾驶舱后端：经隧道走驾驶舱同一套接口（/api），带网关通行证；代表某位创始人做事时注明是谁（飞书 open_id）。
// 返回一律按 shared 里的约定校验：形状不对当场报错，不把坏数据往卡片上放。
import {
  AnswerAskRequest,
  AnswerAskResponse,
  ApiErrorBody,
  FEISHU_UNDERSTAND_MS,
  FeishuBoardSnapshotSchema,
  FeishuCardRecordSchema,
  FeishuCardsResponse,
  FeishuConfirmDraftRequest,
  FeishuConfirmDraftResponse,
  type FeishuDraftSchema,
  FeishuFollowRequest,
  FeishuFollowResponse,
  FeishuMessageRequest,
  FeishuMessageResponse,
  FeishuOkResponse,
  FeishuOutboxAckRequest,
  FeishuOutboxResponse,
  FeishuPutCardRequest,
  FeishuReviseDraftRequest,
  FeishuReviseDraftResponse,
  FeishuRoutes,
  FeishuTaskLookupResponse,
  TaskActionRequest,
  TaskActionResponse,
  TaskDetailResponse,
  WEB_API_PREFIX,
  WebRoutes,
} from '@fleet-dao/shared';
import type { z } from 'zod';

/**
 * 代表哪位创始人（飞书 open_id）。后端那边的同名常量是 shared/web-api.ts 的 FEISHU_ACTING_HEADER（后端的 PR 在加）；
 * test/static.test.ts 核对两边一致。
 */
export const ACTING_HEADER = 'X-Fleet-Acting-Feishu';

export type Draft = z.output<typeof FeishuDraftSchema>;
export type Understood = z.output<typeof FeishuMessageResponse>;
export type ConfirmResult = z.output<typeof FeishuConfirmDraftResponse>;
export type TaskLookup = z.output<typeof FeishuTaskLookupResponse>;
export type TaskDetail = z.output<typeof TaskDetailResponse>;
export type BoardSnapshot = z.output<typeof FeishuBoardSnapshotSchema>;
export type OutboxBatch = z.output<typeof FeishuOutboxResponse>;
export type OutboxItem = OutboxBatch['items'][number];
export type OutboxAck = z.input<typeof FeishuOutboxAckRequest>['acks'][number];
export type CardRecord = z.output<typeof FeishuCardRecordSchema>;
export type CardKind = CardRecord['kind'];
export type ReplyContext = NonNullable<z.input<typeof FeishuMessageRequest>['replyTo']>;

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
  understand(as: Acting, body: z.input<typeof FeishuMessageRequest>, opts?: CallOptions): Promise<Understood>;
  reviseDraft(
    as: Acting,
    draftId: string,
    body: z.input<typeof FeishuReviseDraftRequest>,
    opts?: CallOptions,
  ): Promise<Draft>;
  confirmDraft(
    as: Acting,
    draftId: string,
    body: z.input<typeof FeishuConfirmDraftRequest>,
    opts?: CallOptions,
  ): Promise<ConfirmResult>;
  findTasks(as: Acting, issue: number, opts?: CallOptions): Promise<TaskLookup>;
  task(as: Acting, taskId: string, opts?: CallOptions): Promise<TaskDetail>;
  stopTask(as: Acting, taskId: string, reason: string): Promise<void>;
  answerAsk(as: Acting, askId: string, answer: string): Promise<void>;
  follow(as: Acting, taskId: string, follow: boolean): Promise<boolean>;
  board(opts?: CallOptions): Promise<BoardSnapshot>;
  outbox(waitSeconds: number, signal?: AbortSignal): Promise<OutboxBatch>;
  ackOutbox(acks: OutboxAck[]): Promise<void>;
  putCard(record: CardRecord): Promise<void>;
  /** 没登记过返回 null。 */
  getCard(messageId: string, opts?: CallOptions): Promise<CardRecord | null>;
  listCards(query: { kind: CardKind; chatId?: string; limit?: number }): Promise<CardRecord[]>;
}

export interface BackendOptions {
  baseUrl: string;
  gatewayToken: string;
  fetch?: typeof fetch;
  /** 单次请求默认超时。 */
  timeoutMs?: number;
}

/** 理解一句话：后端答应 FEISHU_UNDERSTAND_MS 内回，网关多给 1 秒（隧道、排队）。 */
export const UNDERSTAND_WAIT_MS = FEISHU_UNDERSTAND_MS + 1_000;

interface Request {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
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

  async function call<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
    const url = new URL(`${base}${WEB_API_PREFIX}${req.path}`);
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
    const where = `${req.method} ${req.path}`;

    let res: Response;
    try {
      res = await doFetch(url, {
        method: req.method,
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
      if (!res.ok)
        throw new BackendError(res.status >= 500 ? 'server' : 'rejected', `${where}：HTTP ${res.status}`, {
          status: res.status,
        });
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
    understand: (as, body, opts) =>
      call(
        {
          method: 'POST',
          path: FeishuRoutes.message.path,
          acting: as,
          body: FeishuMessageRequest.parse(body),
          timeoutMs: opts?.timeoutMs ?? UNDERSTAND_WAIT_MS,
          signal: opts?.signal,
        },
        FeishuMessageResponse,
      ),

    reviseDraft: async (as, draftId, body, opts) =>
      (
        await call(
          {
            method: 'POST',
            path: fill(FeishuRoutes.reviseDraft.path, { draftId }),
            acting: as,
            body: FeishuReviseDraftRequest.parse(body),
            timeoutMs: opts?.timeoutMs ?? UNDERSTAND_WAIT_MS,
            signal: opts?.signal,
          },
          FeishuReviseDraftResponse,
        )
      ).draft,

    confirmDraft: (as, draftId, body, opts) =>
      call(
        {
          method: 'POST',
          path: fill(FeishuRoutes.confirmDraft.path, { draftId }),
          acting: as,
          body: FeishuConfirmDraftRequest.parse(body),
          timeoutMs: opts?.timeoutMs ?? 15_000,
          signal: opts?.signal,
        },
        FeishuConfirmDraftResponse,
      ),

    findTasks: (as, issue, opts) =>
      call(
        {
          method: 'GET',
          path: FeishuRoutes.findTasks.path,
          acting: as,
          query: { issue },
          timeoutMs: opts?.timeoutMs,
          signal: opts?.signal,
        },
        FeishuTaskLookupResponse,
      ),

    task: (as, taskId, opts) =>
      call(
        {
          method: 'GET',
          path: fill(WebRoutes.task.path, { taskId }),
          acting: as,
          timeoutMs: opts?.timeoutMs,
          signal: opts?.signal,
        },
        TaskDetailResponse,
      ),

    stopTask: async (as, taskId, reason) => {
      await call(
        {
          method: 'POST',
          path: fill(WebRoutes.taskAction.path, { taskId }),
          acting: as,
          body: TaskActionRequest.parse({ action: 'stop', reason }),
        },
        TaskActionResponse,
      );
    },

    answerAsk: async (as, askId, answer) => {
      await call(
        {
          method: 'POST',
          path: fill(WebRoutes.answerAsk.path, { askId }),
          acting: as,
          body: AnswerAskRequest.parse({ answer }),
        },
        AnswerAskResponse,
      );
    },

    follow: async (as, taskId, follow) =>
      (
        await call(
          {
            method: 'POST',
            path: FeishuRoutes.follow.path,
            acting: as,
            body: FeishuFollowRequest.parse({ taskId, follow }),
          },
          FeishuFollowResponse,
        )
      ).following,

    board: (opts) =>
      call(
        { method: 'GET', path: FeishuRoutes.board.path, timeoutMs: opts?.timeoutMs, signal: opts?.signal },
        FeishuBoardSnapshotSchema,
      ),

    outbox: (waitSeconds, signal) =>
      call(
        {
          method: 'GET',
          path: FeishuRoutes.outbox.path,
          query: { waitSeconds },
          timeoutMs: waitSeconds * 1000 + 10_000,
          signal,
        },
        FeishuOutboxResponse,
      ),

    ackOutbox: async (acks) => {
      await call(
        { method: 'POST', path: FeishuRoutes.ackOutbox.path, body: FeishuOutboxAckRequest.parse({ acks }) },
        FeishuOkResponse,
      );
    },

    putCard: async ({ messageId, ...rest }) => {
      await call(
        {
          method: 'PUT',
          path: fill(FeishuRoutes.putCard.path, { messageId }),
          body: FeishuPutCardRequest.parse(rest),
        },
        FeishuOkResponse,
      );
    },

    getCard: async (messageId, opts) => {
      try {
        return await call(
          {
            method: 'GET',
            path: fill(FeishuRoutes.getCard.path, { messageId }),
            timeoutMs: opts?.timeoutMs,
            signal: opts?.signal,
          },
          FeishuCardRecordSchema,
        );
      } catch (err) {
        if (err instanceof BackendError && err.status === 404) return null;
        throw err;
      }
    },

    listCards: async (query) =>
      (
        await call(
          {
            method: 'GET',
            path: FeishuRoutes.listCards.path,
            query: { kind: query.kind, chatId: query.chatId, limit: query.limit },
          },
          FeishuCardsResponse,
        )
      ).items,
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
  return cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
}
