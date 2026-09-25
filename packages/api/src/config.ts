// 从环境变量读配置（机器本地配置，例如 systemd 的 EnvironmentFile）。密钥、地址只从这里来，不进仓；
// 缺了或不合规就拒绝启动，并一次列出全部问题。
import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { QUOTA_STALE_AFTER_MS } from '@fleet-dao/db';

export type FleetEnv = 'production' | 'development' | 'test';

export interface Listen {
  host: string;
  port: number;
}

export interface Config {
  env: FleetEnv;
  /** 浏览器看到的驾驶舱地址（香港域名）。飞书回调地址、CSRF 的来源校验都按它。 */
  publicUrl: URL;
  /** 驾驶舱接口监听：生产上是法国机器的 WireGuard 地址，只有香港经加密通道访问。 */
  cockpitListen: Listen;
  /** fleet 命令接口监听：只许本机回环地址，外面够不着。 */
  agentListen: Listen;
  sessionSecret: string;
  agentTokenSecret: string;
  /** 没配时 GitHub 事件入口返回 503（只允许在开发环境缺）。 */
  githubWebhookSecret: string | null;
  /** 没配时飞书登录返回 503（只允许在开发环境缺）。 */
  feishu: { appId: string; appSecret: string } | null;
  /** Postgres 连接串（DATABASE_URL）。生产必须有；开发环境没有就用内存里的样例数据。 */
  databaseUrl: string | null;
  /**
   * 飞书网关的通行证：香港的飞书网关经隧道调驾驶舱接口时带 `Authorization: Bearer <它>`，
   * 并用 X-Fleet-Acting-Feishu 说明代表哪位创始人。没配就不认网关请求。
   */
  feishuGatewayToken: string | null;
  /** 开发环境免登开关：必须 FLEET_ENV=development、FLEET_DEV_LOGIN=1，而且驾驶舱接口只听本机回环地址。 */
  devLogin: boolean;
  /** https 才给 Cookie 加 Secure 和 __Host- 前缀。 */
  cookieSecure: boolean;
  /** fleet ask 阻塞等回答的上限。 */
  askWaitMs: number;
  /** 额度读数超过这么久就判「过期」（设计文档第六节：每个账号池的额度读数不超过 30 分钟）。 */
  quotaStaleAfterMs: number;
  /** SSE 心跳间隔，防香港 nginx 和浏览器把空闲连接掐掉。 */
  sseHeartbeatMs: number;
  /**
   * 演示版可见范围的发布目录（FLEET_DEMO_DIR，绝对路径）：scopes/ 下的文件由装机时的同步单元推到香港，
   * links/ 下是只留本机的备注。没配时驾驶舱发不了演示链接（接口说明没配，不假装「没有链接」）。
   * 演示版的地址不归后端管：发布脚本构建驾驶舱时写进前端（FLEET_DEMO_URL），链接由前端拼。
   */
  demoDir: string | null;
  /** Temporal 服务地址（hostname:port）；不给用本机默认（和引擎的 configFromEnv 同一个默认值）。 */
  temporalAddress: string;
  /** Temporal 命名空间；不给用 fleet。 */
  temporalNamespace: string;
  /** 引擎工人取活的任务队列；只给健康检查的 engine 项（查这条队列上有没有 poller）用，发信号按工作流编号直接找。 */
  fleetTaskQueue: string;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`配置有问题：\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const MIN_SECRET_LENGTH = 32;
/** Node 自带 fetch 默认 300 秒收不到响应头就断开；阻塞等回答要比它短，命令端才收得到 pending。 */
const MAX_ASK_WAIT_SECONDS = 290;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
/** 法国本机的 Temporal；和引擎 worker.ts 的 configFromEnv 用同一套默认值，两边不用都配。 */
const DEFAULT_TEMPORAL_ADDRESS = '127.0.0.1:7243';
const DEFAULT_TEMPORAL_NAMESPACE = 'fleet';
const DEFAULT_FLEET_TASK_QUEUE = 'fleet';

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env): Config {
  const problems: string[] = [];
  const fleetEnv = parseEnv(env.FLEET_ENV, problems);
  const dev = fleetEnv === 'development';

  const publicUrl = parseUrl(env.FLEET_PUBLIC_URL ?? (dev ? 'http://localhost:5173' : undefined), problems);
  if (publicUrl && fleetEnv === 'production' && publicUrl.protocol !== 'https:') {
    problems.push('FLEET_PUBLIC_URL 在生产环境必须是 https');
  }

  const cockpitListen = parseListen(
    'FLEET_COCKPIT_LISTEN',
    env.FLEET_COCKPIT_LISTEN ?? (dev ? '127.0.0.1:8787' : undefined),
    problems,
  );
  const agentListen = parseListen('FLEET_AGENT_LISTEN', env.FLEET_AGENT_LISTEN ?? '127.0.0.1:8788', problems);
  if (agentListen && !LOOPBACK.has(agentListen.host)) {
    problems.push('FLEET_AGENT_LISTEN 只许监听本机回环地址（127.0.0.1 / ::1）：fleet 命令接口不对外');
  }

  const sessionSecret = secret('FLEET_SESSION_SECRET', env, dev, problems);
  const agentTokenSecret = secret('FLEET_AGENT_TOKEN_SECRET', env, dev, problems);
  if (sessionSecret && sessionSecret === agentTokenSecret) {
    problems.push('FLEET_SESSION_SECRET 和 FLEET_AGENT_TOKEN_SECRET 不能相同');
  }

  const githubWebhookSecret = env.FLEET_GITHUB_WEBHOOK_SECRET || null;
  if (!githubWebhookSecret && !dev) problems.push('缺 FLEET_GITHUB_WEBHOOK_SECRET');

  let feishu: Config['feishu'] = null;
  if (env.FEISHU_APP_ID && env.FEISHU_APP_SECRET) {
    feishu = { appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET };
  } else if (env.FEISHU_APP_ID || env.FEISHU_APP_SECRET) {
    problems.push('FEISHU_APP_ID 和 FEISHU_APP_SECRET 要一起给');
  } else if (!dev) {
    problems.push('缺 FEISHU_APP_ID / FEISHU_APP_SECRET');
  }

  const databaseUrl = env.DATABASE_URL || null;
  if (!databaseUrl && !dev) problems.push('缺 DATABASE_URL（Postgres 连接串）');

  const feishuGatewayToken = env.FLEET_FEISHU_GATEWAY_TOKEN || null;
  if (feishuGatewayToken !== null) {
    if (feishuGatewayToken.length < MIN_SECRET_LENGTH) {
      problems.push(`FLEET_FEISHU_GATEWAY_TOKEN 太短：至少 ${MIN_SECRET_LENGTH} 个字符`);
    }
    if (feishuGatewayToken === sessionSecret || feishuGatewayToken === agentTokenSecret) {
      problems.push('FLEET_FEISHU_GATEWAY_TOKEN 不能和别的密钥相同');
    }
  }

  const devLoginRequested = env.FLEET_DEV_LOGIN === '1';
  if (devLoginRequested && !dev) problems.push('FLEET_DEV_LOGIN=1 只允许和 FLEET_ENV=development 一起用');
  // 香港把 /auth 转发到公网：驾驶舱接口一旦监听在非回环地址上，免登就等于对公网开门。
  if (devLoginRequested && cockpitListen && !LOOPBACK.has(cockpitListen.host)) {
    problems.push(
      `FLEET_DEV_LOGIN=1 只允许驾驶舱接口监听本机回环地址，现在监听的是 ${cockpitListen.host}：/auth 会被转发到公网，免登不能开`,
    );
  }

  const demoDir = env.FLEET_DEMO_DIR || null;
  if (demoDir !== null && !isAbsolute(demoDir))
    problems.push(`FLEET_DEMO_DIR 要写绝对路径，现在是「${demoDir}」`);

  const askWaitSeconds = parseIntIn(
    'FLEET_ASK_WAIT_SECONDS',
    env.FLEET_ASK_WAIT_SECONDS,
    240,
    0,
    MAX_ASK_WAIT_SECONDS,
    problems,
  );

  // 都有默认值，两个环境都不强制配（和引擎 worker.ts 的 configFromEnv 同一套默认，Temporal 没起来也不挡后端启动）。
  const temporalAddress = env.TEMPORAL_ADDRESS?.trim() || DEFAULT_TEMPORAL_ADDRESS;
  const temporalNamespace = env.TEMPORAL_NAMESPACE?.trim() || DEFAULT_TEMPORAL_NAMESPACE;
  const fleetTaskQueue = env.FLEET_TASK_QUEUE?.trim() || DEFAULT_FLEET_TASK_QUEUE;

  if (
    problems.length > 0 ||
    !publicUrl ||
    !cockpitListen ||
    !agentListen ||
    !sessionSecret ||
    !agentTokenSecret
  ) {
    throw new ConfigError(problems);
  }
  return {
    env: fleetEnv,
    publicUrl,
    cockpitListen,
    agentListen,
    sessionSecret,
    agentTokenSecret,
    githubWebhookSecret,
    feishu,
    databaseUrl,
    feishuGatewayToken,
    devLogin: devLoginRequested && dev,
    cookieSecure: publicUrl.protocol === 'https:',
    askWaitMs: askWaitSeconds * 1000,
    quotaStaleAfterMs: QUOTA_STALE_AFTER_MS,
    sseHeartbeatMs: 25 * 1000,
    demoDir,
    temporalAddress,
    temporalNamespace,
    fleetTaskQueue,
  };
}

function parseEnv(value: string | undefined, problems: string[]): FleetEnv {
  if (value === undefined || value === '' || value === 'production') return 'production';
  if (value === 'development' || value === 'test') return value;
  problems.push(`FLEET_ENV 只能是 production / development / test，现在是「${value}」`);
  return 'production';
}

function parseUrl(value: string | undefined, problems: string[]): URL | null {
  if (!value) {
    problems.push('缺 FLEET_PUBLIC_URL（浏览器看到的驾驶舱地址）');
    return null;
  }
  try {
    const url = new URL(value);
    if (url.pathname !== '/' || url.search || url.hash) {
      problems.push('FLEET_PUBLIC_URL 只写到域名（和端口），不带路径');
    }
    return url;
  } catch {
    problems.push(`FLEET_PUBLIC_URL 不是合法地址：「${value}」`);
    return null;
  }
}

function parseListen(name: string, value: string | undefined, problems: string[]): Listen | null {
  if (!value) {
    problems.push(`缺 ${name}（形如 <本机 WireGuard 地址>:8787）`);
    return null;
  }
  const colon = value.lastIndexOf(':');
  const host = value.slice(0, colon).replace(/^\[|\]$/g, '');
  const port = Number(value.slice(colon + 1));
  if (colon <= 0 || !host || !Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`${name} 要写成 地址:端口，现在是「${value}」`);
    return null;
  }
  return { host, port };
}

function secret(name: string, env: Env, dev: boolean, problems: string[]): string | null {
  const value = env[name];
  if (!value) {
    // 开发环境缺密钥就临时生成：重启后旧登录和旧令牌作废，正合适。
    if (dev) return randomBytes(32).toString('base64url');
    problems.push(`缺 ${name}`);
    return null;
  }
  if (value.length < MIN_SECRET_LENGTH) {
    problems.push(`${name} 太短：至少 ${MIN_SECRET_LENGTH} 个字符`);
    return null;
  }
  return value;
}

function parseIntIn(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} 要是 ${min}–${max} 之间的整数，现在是「${value}」`);
    return fallback;
  }
  return n;
}
