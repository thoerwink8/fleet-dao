// 测试用的装配：Store（内存版，或 PGlite 上的 Postgres 版）+ 假飞书 + 记录信号的假工作流 + 变化源。
// 每个测试自己起一份，互不干扰。
import { createHmac } from 'node:crypto';
import type { TestDb } from '@fleet-dao/db/testing';
import { resetTestDb } from '@fleet-dao/db/testing';
import { FLEET_CHANGES_CHANNEL } from '@fleet-dao/shared';
import type { Hono } from 'hono';
import { signAgentToken } from '../src/agent-token.ts';
import { buildApps } from '../src/app.ts';
import { type ChangeHub, createChangeHub, type PgChangeFeed, startPgChangeFeed } from '../src/changes.ts';
import type { Config } from '../src/config.ts';
import type { DemoPublisher } from '../src/demo.ts';
import type { Deps } from '../src/deps.ts';
import { DEV_RUN_ID, DEV_USER_ID, devFixtures, IDS } from '../src/dev-fixtures.ts';
import { FeishuRejectedError } from '../src/feishu.ts';
import { createMemoryStore, type MemoryData } from '../src/memory-store.ts';
import { createPgStore } from '../src/pg-store.ts';
import type {
  ChangeFeed,
  FeedEvent,
  FeishuAuth,
  FeishuIdentity,
  HealthCheck,
  IngestedEvent,
  Logger,
  RequirementStart,
  RequirementWorkflows,
  Store,
  TaskSignal,
  WorkflowControl,
} from '../src/ports.ts';
import type { SseRelay } from '../src/sse.ts';
import { seedPg } from './pg-fixtures.ts';

export const T0 = new Date('2026-09-25T08:00:00.000Z');
export const PUBLIC_ORIGIN = 'https://cockpit.example.test';
export const GATEWAY_PASS = 'gateway-pass-for-tests-0123456789abcdef';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    env: 'test',
    publicUrl: new URL(PUBLIC_ORIGIN),
    cockpitListen: { host: '127.0.0.1', port: 0 },
    agentListen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'session-secret-for-tests-0123456789abcdef',
    agentTokenSecret: 'agent-secret-for-tests-0123456789abcdef',
    githubWebhookSecret: WEBHOOK_SECRET,
    feishu: { appId: 'cli_test_app', appSecret: 'feishu-secret-for-tests' },
    databaseUrl: null,
    feishuGatewayToken: GATEWAY_PASS,
    devLogin: false,
    cookieSecure: true,
    askWaitMs: 300,
    quotaStaleAfterMs: 30 * 60_000,
    sseHeartbeatMs: 60_000,
    demoDir: null,
    ...overrides,
  };
}

/** 假飞书：授权码换成对应身份；不认识的授权码被飞书拒。记下每次调用的参数。 */
export function fakeFeishu(identities: Record<string, FeishuIdentity>) {
  const calls: Parameters<FeishuAuth['identify']>[0][] = [];
  const auth: FeishuAuth = {
    authorizeUrl: ({ redirectUri, state, codeChallenge }) =>
      `https://accounts.feishu.test/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&code_challenge=${codeChallenge}`,
    async identify(input) {
      calls.push(input);
      const identity = identities[input.code];
      if (!identity) throw new FeishuRejectedError(20003, 'authorization code not found');
      return identity;
    },
  };
  return { auth, calls };
}

export const FOUNDER_A_CODE = 'code-founder-a';
export const STRANGER_CODE = 'code-stranger';

export interface Harness<S extends Store = Store> {
  cockpit: Hono;
  agent: Hono;
  relay: SseRelay;
  /** 装配好的全部依赖（自己另起 GitHubIntake、对账时用）。 */
  deps: Deps;
  config: Config;
  store: S;
  changes: ChangeFeed;
  signals: { taskId: string; signal: TaskSignal }[];
  /** 真拉起了的需求工作流（假的：同一张 issue 的还在跑、没被叫停，再拉回 already_running，不记在这里）。 */
  starts: RequirementStart[];
  accepted: IngestedEvent[];
  logs: { level: string; message: string; fields?: Record<string, unknown> | undefined }[];
  feishuCalls: Parameters<FeishuAuth['identify']>[0][];
  clock: { now: Date };
  /** 走真登录（飞书客户端内免登接口）拿会话 Cookie 与 CSRF 令牌。 */
  login(code?: string): Promise<{ cookie: string; csrf: string }>;
  agentToken(
    input?: Partial<{ taskId: string; subtaskId: string; runId: string; ttlSeconds: number }>,
  ): string;
}

export interface HarnessOptions {
  config?: Partial<Config>;
  data?: Partial<MemoryData>;
  workflows?: WorkflowControl;
  requirements?: RequirementWorkflows;
  feishu?: 'fake' | null;
  github?: (event: IngestedEvent) => Promise<void>;
  health?: HealthCheck[];
  /** 演示版的发布处；不给就是没配。 */
  demo?: DemoPublisher | null;
}

function wire<S extends Store>(
  store: S,
  changes: ChangeFeed,
  clock: { now: Date },
  options: HarnessOptions,
): Harness<S> {
  const now = () => new Date(clock.now);
  const config = testConfig(options.config);
  const signals: Harness['signals'] = [];
  const starts: RequirementStart[] = [];
  const accepted: IngestedEvent[] = [];
  const logs: Harness['logs'] = [];
  const log: Logger = {
    info: (message, fields) => logs.push({ level: 'info', message, fields }),
    warn: (message, fields) => logs.push({ level: 'warn', message, fields }),
    error: (message, fields) => logs.push({ level: 'error', message, fields }),
  };
  const feishu = fakeFeishu({
    [FOUNDER_A_CODE]: { openId: 'ou_dev_founder_a', name: '创始人甲' },
    [STRANGER_CODE]: { openId: 'ou_stranger', name: '路人' },
  });
  const deps: Deps = {
    config,
    store,
    changes,
    log,
    now,
    health: options.health ?? [],
    demo: options.demo ?? null,
    feishu: options.feishu === null ? null : feishu.auth,
    workflows: options.workflows ?? {
      async signal(taskId, signal) {
        signals.push({ taskId, signal });
      },
    },
    requirements: options.requirements ?? {
      async start(input) {
        // 像 Temporal 按工作流编号去重：同一张 issue 的工作流还在跑（没被叫停）就不起第二条
        const running = starts.some(
          (s) =>
            s.repo.id === input.repo.id &&
            s.issueNumber === input.issueNumber &&
            !signals.some((x) => x.taskId === s.taskId && x.signal.name === 'stop'),
        );
        if (running) return 'already_running';
        starts.push(input);
        return 'started';
      },
    },
    github: {
      accept:
        options.github ??
        (async (event) => {
          accepted.push(event);
        }),
    },
  };
  const { cockpit, agent, relay } = buildApps(deps);

  return {
    cockpit,
    agent,
    relay,
    deps,
    config,
    store,
    changes,
    signals,
    starts,
    accepted,
    logs,
    feishuCalls: feishu.calls,
    clock,
    async login(code = FOUNDER_A_CODE) {
      const res = await cockpit.request('/auth/feishu/access', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: PUBLIC_ORIGIN },
        body: JSON.stringify({ code }),
      });
      if (res.status !== 200) throw new Error(`登录失败：${res.status} ${await res.text()}`);
      const body = (await res.json()) as { csrfToken: string };
      return { cookie: cookieHeader(res), csrf: body.csrfToken };
    },
    agentToken(input = {}) {
      return signAgentToken(config.agentTokenSecret, {
        taskId: input.taskId ?? IDS.task12,
        subtaskId: input.subtaskId ?? IDS.sub12a,
        runId: input.runId ?? DEV_RUN_ID,
        ttlSeconds: input.ttlSeconds ?? 3600,
        now: now(),
      });
    },
  };
}

/** 内存版：数据在 store.data 里，测试可以直接改。变化经 changes（ChangeHub）手动推或由 Store 推。 */
export function harness(
  options: HarnessOptions = {},
): Harness<ReturnType<typeof createMemoryStore>> & { changes: ChangeHub } {
  const clock = { now: new Date(T0) };
  const changes = createChangeHub();
  const store = createMemoryStore(options.data ?? devFixtures(T0), {
    now: () => new Date(clock.now),
    onChange: (table, id) => changes.publish({ type: 'change', table, id }),
  });
  return { ...wire(store, changes, clock, options), changes };
}

/**
 * Postgres 版：PGlite 上跑真迁移，清空后写入同一份样例数据；变化来自真的 LISTEN fleet_changes（库里的触发器发）。
 * 用完调 stop() 退掉 LISTEN。
 */
export async function pgHarness(
  t: TestDb,
  options: HarnessOptions = {},
): Promise<Harness & { feed: PgChangeFeed; stop: () => Promise<void> }> {
  await resetTestDb(t);
  await seedPg(t.db, options.data ?? devFixtures(T0));
  const clock = { now: new Date(T0) };
  const silent: Logger = { info() {}, warn() {}, error() {} };
  const feed = startPgChangeFeed(
    {
      listen: async (channel, onNotify, onListen) => {
        const unlisten = await t.client.listen(channel, onNotify);
        onListen();
        return { unlisten };
      },
      notify: async (channel, payload) => {
        await t.client.query('select pg_notify($1, $2)', [channel, payload]);
      },
    },
    silent,
    // 定时探活不插进测试；要探就调 feed.probe()。
    { probeEveryMs: 60 * 60_000 },
  );
  // 等 LISTEN 真接上，免得测试里的第一次写入赶在它前面。
  for (let i = 0; i < 100 && !feed.status().healthy; i++) await new Promise((r) => setTimeout(r, 5));
  const h = wire(createPgStore(t.db, { now: () => new Date(clock.now) }), feed, clock, options);
  return { ...h, feed, stop: () => feed.stop() };
}

/** 数据库通知在提交后才送达（PGlite 在下一个任务里回调）。 */
export const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** 打开 SSE：带登录 Cookie（可选带 Last-Event-ID），返回读流的 reader。 */
export async function openEvents(h: Harness, cookie: string, lastEventId?: string) {
  const res = await h.cockpit.request('/api/events', {
    headers: { cookie, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) },
  });
  if (!res.body) throw new Error('没有响应体');
  return { res, reader: res.body.getReader() };
}

/** 从 SSE 流里一直读，直到出现 want（或超时）。 */
export async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  want: string,
  buffer = { text: '' },
) {
  const decoder = new TextDecoder();
  const deadline = Date.now() + 2_000;
  while (!buffer.text.includes(want)) {
    if (Date.now() > deadline) throw new Error(`等不到 ${want}，已收到：${buffer.text}`);
    const { value, done } = await reader.read();
    if (done) throw new Error(`流提前结束，已收到：${buffer.text}`);
    buffer.text += decoder.decode(value, { stream: true });
  }
  return buffer;
}

/** 把收到的文字拆成事件：[{ event, id, data }]。 */
export function sseEvents(text: string) {
  return text
    .split('\n\n')
    .filter((b) => b.startsWith('event: '))
    .map((b) => {
      const line = (prefix: string) =>
        b
          .split('\n')
          .find((l) => l.startsWith(prefix))
          ?.slice(prefix.length);
      return { event: line('event: '), id: line('id: '), data: line('data: ') };
    });
}

/** 把响应里的 Set-Cookie 变成下一个请求能带的 Cookie 头（只取 名=值）。 */
export function cookieHeader(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .filter((c): c is string => !!c && !c.endsWith('='))
    .join('; ');
}

export function setCookies(res: Response): string[] {
  return res.headers.getSetCookie();
}

/** 驾驶舱写请求：带 Cookie、CSRF 令牌和本站 Origin。 */
export function write(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  session: { cookie: string; csrf: string },
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): RequestInit {
  return {
    method,
    headers: {
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
      origin: PUBLIC_ORIGIN,
      'content-type': 'application/json',
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** 飞书网关的请求：网关通行证 + 代表哪位创始人；不带 Cookie、不带 CSRF。 */
export function viaGateway(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  actingOpenId: string,
  body?: unknown,
  pass = GATEWAY_PASS,
): RequestInit {
  return {
    method,
    headers: {
      authorization: `Bearer ${pass}`,
      'x-fleet-acting-feishu': actingOpenId,
      'content-type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

export function agentRequest(
  token: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): RequestInit {
  return {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

export async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: { code?: string } };
  return body.error?.code ?? '(no code)';
}

/** 和 testConfig 里的 githubWebhookSecret 同一把。 */
export const WEBHOOK_SECRET = 'webhook-secret-for-tests';

export function signGithub(body: string, secret = WEBHOOK_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

let deliverySeq = 0;

/**
 * 像香港那样把一条 GitHub 事件原样转进来。签名按请求体的原始字节算：body 给了就用它的字节，
 * 不从 payload 重新序列化；signature 给 null 就不带签名头。
 */
export function deliverGithub(
  h: Pick<Harness, 'cockpit'>,
  event: string,
  payload: unknown,
  options: {
    delivery?: string;
    signature?: string | null;
    body?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const body = options.body ?? JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': event,
    'x-github-delivery': options.delivery ?? `d-${++deliverySeq}`,
    ...options.headers,
  };
  if (options.signature !== null) headers['x-hub-signature-256'] = options.signature ?? signGithub(body);
  return Promise.resolve(h.cockpit.request('/github/webhook', { method: 'POST', headers, body }));
}

export type { FeedEvent };
export { DEV_RUN_ID, DEV_USER_ID, FLEET_CHANGES_CHANNEL, IDS };
