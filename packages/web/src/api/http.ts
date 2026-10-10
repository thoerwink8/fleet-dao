// 真后端（packages/api）的实现：请求体和返回都按 shared/web-api.ts 校验；写操作带 X-CSRF-Token；推送走 SSE。
// 路径和形状全部取自 WebRoutes / AuthRoutes，不在这里另写。

import {
  AddPurposeModelRequest,
  ApiErrorBody,
  AUTH_PREFIX,
  AuthRoutes,
  ChangeEventSchema,
  CSRF_HEADER,
  DevLoginRequest,
  FeishuAccessRequest,
  GroomNowRequest,
  ManualModelRequest,
  MovePurposeModelRequest,
  PasswordLoginRequest,
  RemovePurposeModelRequest,
  RouteProbeNowRequest,
  SetChannelEnabledRequest,
  SetModelEnabledRequest,
  SetPurposeModelEffortRequest,
  SSE_EVENTS,
  TaskActionRequest,
  UpdateCredentialsRequest,
  UpdateModelRouteRequest,
  UpdateRepoDispatchRequest,
  UpdateRouteEffortRequest,
  UpdateSettingRequest,
  UpdateTaskRoutePinRequest,
  WEB_API_PREFIX,
  WebRoutes,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { z } from 'zod';
import { PASSWORD_MAX, USERNAME_MAX } from '../lib/credentials';
import { ApiError, type FleetApi, type LiveStatus } from './client';
import type { LiveEvent } from './types';

type Query = Record<string, string | number | undefined>;

/** EventSource.readyState 的 CLOSED（测试环境里可能没有 EventSource 这个全局）。 */
const ES_CLOSED = 2;

/** 推送被后端关掉后第 n 次重连前等多久：1、2、4、8、16 秒，之后每 30 秒一次。 */
export function sseRetryDelay(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt);
}

/** 401 里不代表「没登录或登录过期」的 code（shared/web-api/auth.ts：PasswordLoginRequest、UpdateCredentialsRequest 的注释）。 */
const PASSWORD_CHECK_CODES: ReadonlySet<string> = new Set(['bad_credentials', 'bad_current_password']);

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
  /** 改密码的那一下 PUT：它在路上时别的请求先等它落地（拿到新 Cookie）再发。 */
  rotatesSession?: boolean;
}

export function createHttpApi(opts: HttpApiOptions = {}): FleetApi {
  const origin = opts.origin ?? '';
  const doFetch = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  let csrf: string | undefined;
  // 改密码会让后端把这个人所有旧会话作废、只在 PUT 的响应里给这一处换新 Cookie（api/src/credentials.ts）。
  // 改的这一下正在路上、或刚改完时，页面上别的在途请求（刷新、推送触发的重拉）带着旧 Cookie，回来就是 401：
  // 那不是「登录过期」，不能因此把人踢去登录页（页面上的提示和刚填的东西全丢）。passwordChanges = 正在改的个数，
  // sessionEpoch = 已经改成功几次；请求开始时任一不是零 / 之后变了，它回来的 401 就当作旧 Cookie 的尾巴。
  let passwordChanges = 0;
  let sessionEpoch = 0;
  // 改密码的 PUT 已经发出、还没回来时是它。这期间新发的请求先等它：不等就带着马上作废的旧 Cookie 出门，
  // 回来是 401，浏览器控制台记一条「Failed to load resource」（e2e 10-credentials 偶发红：推送攒的那次全量重拉
  // 正好落在 PUT 路上，run 37257542728）。上面的 401 放行只兜 PUT 发出之前就在路上的那些。
  let rotation: Promise<unknown> | undefined;

  async function send<S extends z.ZodType>(
    method: string,
    url: string,
    schema: S | null,
    { body, csrf: withCsrf = method !== 'GET', rotatesSession = false }: SendOptions = {},
  ): Promise<z.output<S>> {
    while (rotation) await rotation.catch(() => undefined);
    const epochAtStart = sessionEpoch;
    const changingAtStart = passwordChanges > 0;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (withCsrf) {
      csrf ??= (await api.me()).csrfToken;
      headers[CSRF_HEADER] = csrf;
    }
    const init: RequestInit = { method, headers, credentials: 'same-origin' };
    if (body !== undefined) init.body = JSON.stringify(body);
    let res: Response;
    let pending: Promise<Response> | undefined;
    try {
      pending = doFetch(url, init);
      if (rotatesSession) rotation = pending;
      res = await pending;
    } catch (err) {
      throw new ApiError(0, 'network', `连不上驾驶舱后端：${errMessage(err)}`);
    } finally {
      if (rotation === pending) rotation = undefined;
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
      // 401 + 这两个 code 是「会话好好的，只是密码输错了」（登录页的账密、设置页的当前密码）：不是登录过期，
      // 不能触发跳登录页——否则设置页输错当前密码会整页跳走，错误提示根本看不到。
      const oldCookieTail = changingAtStart || passwordChanges > 0 || epochAtStart !== sessionEpoch;
      if (res.status === 401 && !PASSWORD_CHECK_CODES.has(err.code) && !oldCookieTail)
        opts.onUnauthorized?.();
      if (err.code === 'csrf_token') csrf = undefined;
      throw err;
    }
    if (!schema) {
      // 204 这类没有响应体的成功也把（空的）响应体读完：不读的话，浏览器在页面随后的重拉里会把这一条标成「请求中断」（ERR_ABORTED）
      await res.text().catch(() => undefined);
      return undefined as z.output<S>;
    }
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
      const body = PasswordLoginRequest.safeParse({ username, password });
      if (!body.success) {
        // 密码不进错误信息、不进日志：只说哪一栏长度不合
        throw new ApiError(
          400,
          'invalid_request',
          `用户名最多 ${USERNAME_MAX} 个字符、密码最多 ${PASSWORD_MAX} 个字符，且都不能为空`,
        );
      }
      // 成功是 204 + 会话 Cookie、没有响应体；CSRF 令牌要再读一次 /api/me（me() 里存下）
      await send('POST', authUrl(AuthRoutes.passwordLogin.path), null, { body: body.data, csrf: false });
      csrf = undefined;
      return api.me();
    },
    credentials: () => send('GET', apiUrl(R.credentials.path), R.credentials.response),
    async updateCredentials(body) {
      const parsed = UpdateCredentialsRequest.parse(body);
      const changesPassword = parsed.newPassword !== undefined;
      if (changesPassword) passwordChanges += 1;
      try {
        await send('PUT', apiUrl(R.updateCredentials.path), null, {
          body: parsed,
          rotatesSession: changesPassword,
        });
        if (changesPassword) sessionEpoch += 1;
      } finally {
        if (changesPassword) passwordChanges -= 1;
      }
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
    repoDispatch: () => send('GET', apiUrl(R.repoDispatch.path), R.repoDispatch.response),
    async updateRepoDispatch(repoId, body) {
      return send('PUT', apiUrl(R.updateRepoDispatch.path, { repoId }), R.updateRepoDispatch.response, {
        body: UpdateRepoDispatchRequest.parse(body),
      });
    },
    groomStatus: (repoId) => send('GET', apiUrl(R.groomStatus.path, { repoId }), R.groomStatus.response),
    async groomNow(repoId, body) {
      return send('POST', apiUrl(R.groomNow.path, { repoId }), R.groomNow.response, {
        body: GroomNowRequest.parse(body),
      });
    },
    home: () => send('GET', apiUrl(R.home.path), R.home.response),
    env: () => send('GET', apiUrl(R.env.path), R.env.response),
    nodes: () => send('GET', apiUrl(R.nodes.path), R.nodes.response),
    node: (nodeId) => send('GET', apiUrl(R.node.path, { nodeId }), R.node.response),
    board: (repoId) => send('GET', apiUrl(R.board.path, { repoId }), R.board.response),
    tasks: (query) =>
      send(
        'GET',
        apiUrl(
          R.tasks.path,
          {},
          {
            status: query?.status,
            repoId: query?.repoId,
            q: query?.q,
            cursor: query?.cursor,
            limit: query?.limit,
          },
        ),
        R.tasks.response,
      ),
    task: (taskId) => send('GET', apiUrl(R.task.path, { taskId }), R.task.response),
    async taskAction(taskId, body) {
      await send('POST', apiUrl(R.taskAction.path, { taskId }), R.taskAction.response, {
        body: TaskActionRequest.parse(body),
      });
    },
    async updateTaskRoutePin(taskId, body) {
      return send('PUT', apiUrl(R.updateTaskRoutePin.path, { taskId }), R.updateTaskRoutePin.response, {
        body: UpdateTaskRoutePinRequest.parse(body),
      });
    },
    routing: () => send('GET', apiUrl(R.routing.path), R.routing.response),
    routingLayers: () => send('GET', apiUrl(R.routingLayers.path), R.routingLayers.response),
    routingEfforts: () => send('GET', apiUrl(R.routingEfforts.path), R.routingEfforts.response),
    routeProbeStatus: () => send('GET', apiUrl(R.routeProbeStatus.path), R.routeProbeStatus.response),
    routeProbeHistory: () => send('GET', apiUrl(R.routeProbeHistory.path), R.routeProbeHistory.response),
    async routeProbeNow(body) {
      return send('POST', apiUrl(R.routeProbeNow.path), R.routeProbeNow.response, {
        body: RouteProbeNowRequest.parse(body),
      });
    },
    // 写方法一律 async：请求体校验（.parse）不合约定时要变成被拒的 Promise，不能在返回 Promise 之前同步抛，
    // 否则调用方的 .catch 接不到（#857；http-writes.test.ts 的「不是同步抛」那条钉着）。
    async updateRouteEffort(modelId, routeId, body) {
      return send(
        'PUT',
        apiUrl(R.updateRouteEffort.path, { modelId, routeId }),
        R.updateRouteEffort.response,
        {
          body: UpdateRouteEffortRequest.parse(body),
        },
      );
    },
    async movePurposeModel(purpose, modelId, body) {
      return send('PUT', apiUrl(R.movePurposeModel.path, { purpose, modelId }), R.movePurposeModel.response, {
        body: MovePurposeModelRequest.parse(body),
      });
    },
    async addPurposeModel(purpose, body) {
      return send('POST', apiUrl(R.addPurposeModel.path, { purpose }), R.addPurposeModel.response, {
        body: AddPurposeModelRequest.parse(body),
      });
    },
    async removePurposeModel(purpose, modelId, body) {
      return send(
        'DELETE',
        apiUrl(R.removePurposeModel.path, { purpose, modelId }),
        R.removePurposeModel.response,
        { body: RemovePurposeModelRequest.parse(body) },
      );
    },
    async setPurposeModelEffort(purpose, modelId, body) {
      return send(
        'PUT',
        apiUrl(R.setPurposeModelEffort.path, { purpose, modelId }),
        R.setPurposeModelEffort.response,
        { body: SetPurposeModelEffortRequest.parse(body) },
      );
    },
    async updateModelRoute(modelId, routeId, body) {
      return send('PUT', apiUrl(R.updateModelRoute.path, { modelId, routeId }), R.updateModelRoute.response, {
        body: UpdateModelRouteRequest.parse(body),
      });
    },
    async setModelEnabled(modelId, body) {
      return send('PUT', apiUrl(R.setModelEnabled.path, { modelId }), R.setModelEnabled.response, {
        body: SetModelEnabledRequest.parse(body),
      });
    },
    async setChannelEnabled(channelId, body) {
      return send('PUT', apiUrl(R.setChannelEnabled.path, { channelId }), R.setChannelEnabled.response, {
        body: SetChannelEnabledRequest.parse(body),
      });
    },
    async registerChannelModel(channelId, body) {
      return send(
        'POST',
        apiUrl(R.registerChannelModel.path, { channelId }),
        R.registerChannelModel.response,
        {
          body: ManualModelRequest.parse(body),
        },
      );
    },
    async revokeChannelModel(channelId, body) {
      return send('DELETE', apiUrl(R.revokeChannelModel.path, { channelId }), R.revokeChannelModel.response, {
        body: ManualModelRequest.parse(body),
      });
    },
    pools: () => send('GET', apiUrl(R.pools.path), R.pools.response),
    poolHolds: () => send('GET', apiUrl(R.poolHolds.path), R.poolHolds.response),
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
    franceReleaseState: () => send('GET', apiUrl(R.franceReleaseState.path), R.franceReleaseState.response),
    franceReleaseCard: () => send('GET', apiUrl(R.franceReleaseCard.path), R.franceReleaseCard.response),
    franceReleasedCommits: () =>
      send('GET', apiUrl(R.franceReleasedCommits.path), R.franceReleasedCommits.response),
    franceRelease: (sha) =>
      send('POST', apiUrl(R.franceRelease.path), R.franceRelease.response, {
        body: R.franceRelease.request.parse({ sha }),
      }),
    francePreflight: () => send('POST', apiUrl(R.francePreflight.path), R.francePreflight.response),
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
