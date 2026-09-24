// 测试用的装配：内存 Store + 假飞书 + 记录信号的假工作流 + 手动推送的变化源。每个测试自己起一份，互不干扰。
import type { Hono } from 'hono';
import { signAgentToken } from '../src/agent-token.ts';
import { buildApps } from '../src/app.ts';
import { type ChangeHub, createChangeHub } from '../src/changes.ts';
import type { Config } from '../src/config.ts';
import type { Deps } from '../src/deps.ts';
import { DEV_RUN_ID, DEV_USER_ID, devFixtures } from '../src/dev-fixtures.ts';
import { FeishuRejectedError } from '../src/feishu.ts';
import { createMemoryStore, type MemoryData } from '../src/memory-store.ts';
import type {
  FeedEvent,
  FeishuAuth,
  FeishuIdentity,
  IngestedEvent,
  Logger,
  TaskSignal,
  WorkflowControl,
} from '../src/ports.ts';

export const T0 = new Date('2026-09-25T08:00:00.000Z');
export const PUBLIC_ORIGIN = 'https://cockpit.example.test';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    env: 'test',
    publicUrl: new URL(PUBLIC_ORIGIN),
    cockpitListen: { host: '127.0.0.1', port: 0 },
    agentListen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'session-secret-for-tests-0123456789abcdef',
    agentTokenSecret: 'agent-secret-for-tests-0123456789abcdef',
    githubWebhookSecret: 'webhook-secret-for-tests',
    feishu: { appId: 'cli_test_app', appSecret: 'feishu-secret-for-tests' },
    devLogin: false,
    cookieSecure: true,
    askWaitMs: 300,
    quotaStaleAfterMs: 30 * 60_000,
    sseHeartbeatMs: 60_000,
    ...overrides,
  };
}

/** 假飞书：授权码 code-<openId 后缀> 换成对应身份；code-bad 被飞书拒。记下每次调用的参数。 */
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

export interface Harness {
  cockpit: Hono;
  agent: Hono;
  config: Config;
  store: ReturnType<typeof createMemoryStore>;
  changes: ChangeHub;
  signals: { taskId: string; signal: TaskSignal }[];
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
  feishu?: 'fake' | null;
  github?: (event: IngestedEvent) => Promise<void>;
}

export function harness(options: HarnessOptions = {}): Harness {
  const clock = { now: new Date(T0) };
  const now = () => new Date(clock.now);
  const config = testConfig(options.config);
  const changes = createChangeHub();
  const store = createMemoryStore(options.data ?? devFixtures(T0), {
    now,
    onChange: (table, id) => changes.publish({ type: 'change', table, id }),
  });
  const signals: Harness['signals'] = [];
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
    feishu: options.feishu === null ? null : feishu.auth,
    workflows: options.workflows ?? {
      async signal(taskId, signal) {
        signals.push({ taskId, signal });
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
  const { cockpit, agent } = buildApps(deps);

  return {
    cockpit,
    agent,
    config,
    store,
    changes,
    signals,
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
        taskId: input.taskId ?? 'task-12',
        subtaskId: input.subtaskId ?? 'sub-12a',
        runId: input.runId ?? DEV_RUN_ID,
        ttlSeconds: input.ttlSeconds ?? 3600,
        now: now(),
      });
    },
  };
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

export function agentRequest(token: string, method: 'GET' | 'POST' = 'GET', body?: unknown): RequestInit {
  return {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

export async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: { code?: string } };
  return body.error?.code ?? '(no code)';
}

export type { FeedEvent };
export { DEV_RUN_ID, DEV_USER_ID };
