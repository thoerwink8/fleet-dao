// 从环境变量读配置。密钥只从环境变量来（机器本地配置），不进仓；缺了或不合规就拒绝启动，并一次列出全部问题。
import { randomBytes } from 'node:crypto';

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
  /** 开发环境免登开关：必须 FLEET_ENV=development 且 FLEET_DEV_LOGIN=1。 */
  devLogin: boolean;
  /** https 才给 Cookie 加 Secure 和 __Host- 前缀。 */
  cookieSecure: boolean;
  /** fleet ask 阻塞等回答的上限。 */
  askWaitMs: number;
  /** 额度读数超过这么久就判「过期」（设计文档第六节：每个账号池的额度读数不超过 30 分钟）。 */
  quotaStaleAfterMs: number;
  /** SSE 心跳间隔，防香港 nginx 和浏览器把空闲连接掐掉。 */
  sseHeartbeatMs: number;
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

  const devLoginRequested = env.FLEET_DEV_LOGIN === '1';
  if (devLoginRequested && !dev) problems.push('FLEET_DEV_LOGIN=1 只允许和 FLEET_ENV=development 一起用');

  const askWaitSeconds = parseIntIn(
    'FLEET_ASK_WAIT_SECONDS',
    env.FLEET_ASK_WAIT_SECONDS,
    240,
    0,
    MAX_ASK_WAIT_SECONDS,
    problems,
  );

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
    devLogin: devLoginRequested && dev,
    cookieSecure: publicUrl.protocol === 'https:',
    askWaitMs: askWaitSeconds * 1000,
    quotaStaleAfterMs: 30 * 60 * 1000,
    sseHeartbeatMs: 25 * 1000,
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
