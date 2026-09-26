// 真后端（packages/api）的实现：请求体和返回都按 shared/web-api.ts 校验；写操作带 X-CSRF-Token；推送走 SSE。
// 路径和形状全部取自 WebRoutes / AuthRoutes，不在这里另写。
import {
  AnswerAskRequest,
  ApiErrorBody,
  AUTH_PREFIX,
  AuthRoutes,
  ChangeEventSchema,
  CreateDemoLinkRequest,
  CSRF_HEADER,
  DevLoginRequest,
  FeishuAccessRequest,
  PasswordLoginRequest,
  SSE_EVENTS,
  TaskActionRequest,
  UpdateChannelRequest,
  UpdateDemoDefaultRequest,
  UpdateSettingRequest,
  UpdateStagePolicyRequest,
  WEB_API_PREFIX,
  WebRoutes,
} from '@fleet-dao/shared';
import type { z } from 'zod';
import { ApiError, type FleetApi, type LiveStatus } from './client';
import type { LiveEvent } from './types';

type Query = Record<string, string | number | undefined>;

/** EventSource.readyState 的 CLOSED（测试环境里可能没有 EventSource 这个全局）。 */
const ES_CLOSED = 2;

/** 推送被后端关掉后第 n 次重连前等多久：1、2、4、8、16 秒，之后每 30 秒一次。 */
export function sseRetryDelay(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt);
}

function fill(path: string, params: Record<string, string> = {}): string {
  return path.replace(/:(\w+)/g, (_, name: string) => {
    const v = params[name];
    if (v === undefined) throw new Error(`路径 ${path} 缺参数 ${name}`);
    return encodeURIComponent(v);
  });
}

export interface HttpApiOptions {
  /** 后端地址；默认同源（生产上香港门面把 /api、/auth 转给法国后端，开发时 Vite 代理）。 */
  origin?: string;
  fetch?: typeof fetch;
  /** 返回 401（没登录或登录过期）时调用，一般是跳登录页。 */
  onUnauthorized?: () => void;
  /** 测试里替换 EventSource。 */
  eventSource?: (url: string) => EventSource;
}

interface SendOptions {
  body?: unknown;
  /** 写操作默认带 CSRF 令牌；登录前的免登请求（dev-login、飞书免登）没有会话，不带。 */
  csrf?: boolean;
}

export function createHttpApi(opts: HttpApiOptions = {}): FleetApi {
  const origin = opts.origin ?? '';
  const doFetch = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  let csrf: string | undefined;

  async function send<S extends z.ZodType>(
    method: string,
    url: string,
    schema: S | null,
    { body, csrf: withCsrf = method !== 'GET' }: SendOptions = {},
  ): Promise<z.output<S>> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (withCsrf) {
      csrf ??= (await api.me()).csrfToken;
      headers[CSRF_HEADER] = csrf;
    }
    const init: RequestInit = { method, headers, credentials: 'same-origin' };
    if (body !== undefined) init.body = JSON.stringify(body);
    let res: Response;
    try {
      res = await doFetch(url, init);
    } catch (err) {
      throw new ApiError(
        0,
        'network',
        `连不上驾驶舱后端：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const raw: unknown = await res.json().catch(() => undefined);
      const parsed = ApiErrorBody.safeParse(raw);
      const err = parsed.success
        ? new ApiError(
            res.status,
            parsed.data.error.code,
            parsed.data.error.message,
            parsed.data.error.details,
          )
        : new ApiError(res.status, `http_${res.status}`, `后端返回 ${res.status}`);
      if (res.status === 401) opts.onUnauthorized?.();
      if (err.code === 'csrf_token') csrf = undefined;
      throw err;
    }
    if (!schema) return undefined as z.output<S>;
    const json: unknown = await res.json();
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(
        res.status,
        'bad_response_shape',
        '后端返回的数据不符合约定（shared/web-api.ts）',
        parsed.error.issues,
      );
    }
    return parsed.data;
  }

  function apiUrl(path: string, params?: Record<string, string>, query?: Query): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
    const s = qs.toString();
    return `${origin}${WEB_API_PREFIX}${fill(path, params)}${s ? `?${s}` : ''}`;
  }

  const authUrl = (path: string) => `${origin}${AUTH_PREFIX}${path}`;
  const R = WebRoutes;

  const api: FleetApi = {
    source: 'http',
    authConfig: () => send('GET', authUrl(AuthRoutes.config.path), AuthRoutes.config.response),
    async devLogin(userId) {
      const me = await send('POST', authUrl(AuthRoutes.devLogin.path), AuthRoutes.devLogin.response, {
        body: DevLoginRequest.parse({ userId }),
        csrf: false,
      });
      csrf = me.csrfToken;
      return me;
    },
    async feishuAccess(code) {
      const me = await send('POST', authUrl(AuthRoutes.feishuAccess.path), AuthRoutes.feishuAccess.response, {
        body: FeishuAccessRequest.parse({ code }),
        csrf: false,
      });
      csrf = me.csrfToken;
      return me;
    },
    async passwordLogin(username, password) {
      // 成功是 204 + 会话 Cookie，没有响应体；再读一次 /api/me 拿登录的人和 CSRF 令牌。
      await send('POST', authUrl(AuthRoutes.passwordLogin.path), null, {
        body: PasswordLoginRequest.parse({ username, password }),
        csrf: false,
      });
      return api.me();
    },
    async logout() {
      await send('POST', authUrl(AuthRoutes.logout.path), null);
      csrf = undefined;
    },
    async me() {
      const me = await send('GET', apiUrl(R.me.path), R.me.response);
      csrf = me.csrfToken;
      return me;
    },
    repos: () => send('GET', apiUrl(R.repos.path), R.repos.response),
    board: (repoId) => send('GET', apiUrl(R.board.path, { repoId }), R.board.response),
    task: (taskId) => send('GET', apiUrl(R.task.path, { taskId }), R.task.response),
    timeline: (taskId, page) =>
      send(
        'GET',
        apiUrl(R.timeline.path, { taskId }, { cursor: page?.cursor, limit: page?.limit }),
        R.timeline.response,
      ),
    runSteps: (runId) => send('GET', apiUrl(R.runSteps.path, { runId }), R.runSteps.response),
    async taskAction(taskId, body) {
      await send('POST', apiUrl(R.taskAction.path, { taskId }), R.taskAction.response, {
        body: TaskActionRequest.parse(body),
      });
    },
    async answerAsk(askId, answer) {
      await send('POST', apiUrl(R.answerAsk.path, { askId }), R.answerAsk.response, {
        body: AnswerAskRequest.parse({ answer }),
      });
    },
    routing: () => send('GET', apiUrl(R.routing.path), R.routing.response),
    async updateStagePolicy(stage, body) {
      const res = await send(
        'PUT',
        apiUrl(R.updateStagePolicy.path, { stage }),
        R.updateStagePolicy.response,
        {
          body: UpdateStagePolicyRequest.parse(body),
        },
      );
      return res.stage;
    },
    async updateChannel(channelId, body) {
      await send('PATCH', apiUrl(R.updateChannel.path, { channelId }), R.updateChannel.response, {
        body: UpdateChannelRequest.parse(body),
      });
    },
    pools: () => send('GET', apiUrl(R.pools.path), R.pools.response),
    jobs: () => send('GET', apiUrl(R.jobs.path), R.jobs.response),
    notifications: (query) =>
      send(
        'GET',
        apiUrl(
          R.notifications.path,
          {},
          { status: query?.status, cursor: query?.cursor, limit: query?.limit },
        ),
        R.notifications.response,
      ),
    async resolveNotification(id) {
      await send(
        'POST',
        apiUrl(R.resolveNotification.path, { notificationId: id }),
        R.resolveNotification.response,
      );
    },
    audit: (query) =>
      send(
        'GET',
        apiUrl(R.audit.path, {}, { target: query?.target, cursor: query?.cursor, limit: query?.limit }),
        R.audit.response,
      ),
    settings: () => send('GET', apiUrl(R.settings.path), R.settings.response),
    async updateSetting(key, body) {
      const res = await send('PUT', apiUrl(R.updateSetting.path, { key }), R.updateSetting.response, {
        body: UpdateSettingRequest.parse(body),
      });
      return res.setting;
    },
    demoLinks: () => send('GET', apiUrl(R.demoLinks.path), R.demoLinks.response),
    createDemoLink: (body) =>
      send('POST', apiUrl(R.createDemoLink.path), R.createDemoLink.response, {
        body: CreateDemoLinkRequest.parse(body),
      }),
    async revokeDemoLink(linkId) {
      await send('DELETE', apiUrl(R.revokeDemoLink.path, { linkId }), R.revokeDemoLink.response);
    },
    async updateDemoDefault(body) {
      const res = await send('PUT', apiUrl(R.updateDemoDefault.path), R.updateDemoDefault.response, {
        body: UpdateDemoDefaultRequest.parse(body),
      });
      return res.defaultScope;
    },
    subscribe(listener, onStatus) {
      const make = opts.eventSource ?? ((url: string) => new EventSource(url, { withCredentials: true }));
      const url = apiUrl(R.events.path);
      const status = (s: LiveStatus) => onStatus?.(s);
      let es: EventSource | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let attempt = 0;
      let stopped = false;

      const connect = () => {
        if (stopped) return;
        status('connecting');
        const src = make(url);
        es = src;
        src.addEventListener(SSE_EVENTS.ready, () => {
          attempt = 0;
          status('open');
          // 每次（重新）连上都全量重拉：断开期间漏掉的变化靠这一下补上。
          listener({ type: 'ready' });
        });
        src.addEventListener(SSE_EVENTS.resync, () => listener({ type: 'resync' }));
        src.addEventListener(SSE_EVENTS.change, (ev) => {
          let raw: unknown;
          try {
            raw = JSON.parse((ev as MessageEvent<string>).data);
          } catch {
            raw = undefined;
          }
          const parsed = ChangeEventSchema.safeParse(raw);
          // 看不懂的变化也要重拉：当成 resync，不能当没发生。
          const event: LiveEvent = parsed.success ? { type: 'change', ...parsed.data } : { type: 'resync' };
          listener(event);
        });
        src.onerror = () => {
          if (src !== es) return;
          // 网络断了浏览器会自己重连（readyState 回到 CONNECTING）。
          if (src.readyState !== ES_CLOSED) {
            status('connecting');
            return;
          }
          // 后端回了 401、502 之类，浏览器就此放弃、不再重连：我们自己退避重连，不然后端一重启页面就悄悄停更。
          src.close();
          es = undefined;
          status('down');
          schedule();
        };
      };

      const schedule = () => {
        timer = setTimeout(() => void retry(), sseRetryDelay(attempt));
        attempt += 1;
      };

      // 先探一下 /api/me：是登录过期（401）就跳登录页（send 里的 onUnauthorized），不再空转重连；
      // 后端还没起来就接着退避；探通了再连推送。
      const retry = async () => {
        timer = undefined;
        if (stopped) return;
        try {
          await api.me();
        } catch (err) {
          if (stopped) return;
          if (err instanceof ApiError && err.status === 401) return;
          schedule();
          return;
        }
        connect();
      };

      connect();
      return () => {
        stopped = true;
        clearTimeout(timer);
        es?.close();
        es = undefined;
      };
    },
  };
  return api;
}
