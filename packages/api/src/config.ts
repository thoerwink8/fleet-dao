// 从环境变量读配置（机器本地配置，例如 systemd 的 EnvironmentFile）。密钥、地址只从这里来，不进仓；
// 缺了或不合规就拒绝启动，并一次列出全部问题。
import { createHash, randomBytes } from 'node:crypto';
import { QUOTA_STALE_AFTER_MS } from '@fleet-dao/db';
import { NodeIdSchema } from '@fleet-dao/shared';

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
  /**
   * 没配时飞书登录返回 503，登录只剩账密。生产上只有两种情况允许没有：开发环境，或 FLEET_FEISHU_LOGIN=off 明说这台不接飞书登录
   * （见 feishuLogin）。
   */
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
  /** 额度读数超过这么久就判「过期」（设计文档第六节：每个账号池的额度读数不超过 30 分钟）。 */
  quotaStaleAfterMs: number;
  /** SSE 心跳间隔，防香港 nginx 和浏览器把空闲连接掐掉。 */
  sseHeartbeatMs: number;
  /** Temporal 服务地址（hostname:port）；不给用本机默认（和引擎的 configFromEnv 同一个默认值）。 */
  temporalAddress: string;
  /** Temporal 命名空间；不给用 fleet。 */
  temporalNamespace: string;
  /** 引擎工人取活的任务队列；只给健康检查的 engine 项（查这条队列上有没有 poller）用，发信号按工作流编号直接找。 */
  fleetTaskQueue: string;
  /**
   * 这台机器按 release.env 的 FLEET_SERVICES 没开引擎：主页持续状态条的那一格
   * 「引擎关着」就按它显示（持续显示、不伪装成失败）。读不到这项的按开着算（和 engineEnabled 一个判法）。
   */
  engineOff: boolean;
  /**
   * 这台机器给人看的名字（FLEET_MACHINE_NAME，和引擎那边同一项）：驾驶舱顶栏徽标和环境页（#820 片 1）用它。
   * 没配、空白是 null——页面写「认不出」并说明，不拿「法国」这种猜的值冒充。法国写「法国」，
   * 期望（deploy/france/desired-config.json）的 api.env 登记了。
   */
  machineName: string | null;
  /**
   * FLEET_FEISHU_LOGIN=off：这台不接飞书（没有飞书网关）。这时飞书网关的通行证即使在环境文件里也不认
   * （feishuGatewayToken 记成 null），健康页的 feishu_gateway 报「未接」而不是一直等一个永远不会来的网关（#803）。
   */
  feishuOff: boolean;
  /**
   * 把这一台的主页、环境页快照推给正式环境的看板（看板多机，node-reporter.ts）：FLEET_NODE_REPORT_URL（收快照的完整地址）和
   * FLEET_NODE_REPORT_TOKEN（那边发的通行证）两项一起配才推，都没配是 null（不推，/healthz 的 node_report 报「未接」）。
   */
  nodeReport: { url: URL; token: string } | null;
  /**
   * 收别的环境推来的快照要认的通行证（FLEET_NODE_KEYS，node-report.ts）：环境编号 → 通行证明文的 sha256（64 位十六进制）。
   * 环境文件里只放哈希、不放明文（明文只在 `fleet-api node-key new` 打印那一次、和推送方的 FLEET_NODE_REPORT_TOKEN 里）。
   * 没配是 {}——这一台不收快照（写口回 503，不回 401 冒充「通行证不对」）。
   */
  nodeKeys: Readonly<Record<string, string>>;
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
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
/** 法国本机的 Temporal；和引擎 worker.ts 的 configFromEnv 用同一套默认值，两边不用都配。 */
const DEFAULT_TEMPORAL_ADDRESS = '127.0.0.1:7243';
const DEFAULT_TEMPORAL_NAMESPACE = 'fleet';
const DEFAULT_FLEET_TASK_QUEUE = 'fleet';

type Env = Record<string, string | undefined>;

/**
 * 连 Temporal 的三样：都有默认值，两个环境都不强制配（和引擎 worker.ts 的 configFromEnv 同一套默认，Temporal 没起来也不挡
 * 后端启动）。后端启动照这里读。
 */
export function temporalSettings(
  env: Env,
): Pick<Config, 'temporalAddress' | 'temporalNamespace' | 'fleetTaskQueue'> {
  return {
    temporalAddress: env.TEMPORAL_ADDRESS?.trim() || DEFAULT_TEMPORAL_ADDRESS,
    temporalNamespace: env.TEMPORAL_NAMESPACE?.trim() || DEFAULT_TEMPORAL_NAMESPACE,
    fleetTaskQueue: env.FLEET_TASK_QUEUE?.trim() || DEFAULT_FLEET_TASK_QUEUE,
  };
}

/** release.env 的 FLEET_SERVICES 里认识的应用服务名：要和 deploy/release.sh 的 APP_UNITS 一样（config.test.ts 核对）。 */
export const APP_SERVICES: readonly string[] = ['fleet-engine', 'fleet-api'];

/**
 * 这台机器开没开引擎：release.env 的 FLEET_SERVICES（空格分隔的应用服务名，发布脚本照它起停）里有没有 fleet-engine。
 * 后端单元把 release.env 也读进环境（deploy/france/fleet-api.service），后端和发布脚本认同一处声明，不另写一份。
 * 没读到这一项（开发、测试、机器上没有 release.env）、或里面有不认识的名字（拼错了）：读不懂，一律按开着算——宁可多报
 * 一项红，也不把引擎坏了说成没事。
 */
export function engineEnabled(env: Env): boolean {
  const services = env.FLEET_SERVICES;
  if (services === undefined) return true;
  const listed = services.split(/\s+/).filter(Boolean);
  if (listed.some((s) => !APP_SERVICES.includes(s))) return true;
  return listed.includes('fleet-engine');
}

/**
 * 这台机器给人看的名字（FLEET_MACHINE_NAME）：法国「法国」，和引擎读的是同一项。空白、没配是 null，
 * 上层（环境页、顶栏徽标）照实写「认不出」，不猜成某一台。名字不是要保密的东西，期望当公开值登记。
 */
export function machineName(env: Env): string | null {
  const name = env.FLEET_MACHINE_NAME?.trim();
  return name ? name : null;
}

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
  const feishuOff = feishuLogin(env, problems) === 'off';
  if (feishuOff) {
    if (env.FEISHU_APP_ID || env.FEISHU_APP_SECRET) {
      problems.push(
        'FLEET_FEISHU_LOGIN=off（这台不接飞书登录），FEISHU_APP_ID / FEISHU_APP_SECRET 却配了：接不接说不清，二选一（不接就把这两项清空，接就去掉 off）',
      );
    }
  } else if (env.FEISHU_APP_ID && env.FEISHU_APP_SECRET) {
    feishu = { appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET };
  } else if (env.FEISHU_APP_ID || env.FEISHU_APP_SECRET) {
    problems.push('FEISHU_APP_ID 和 FEISHU_APP_SECRET 要一起给');
  } else if (!dev) {
    problems.push(
      '缺 FEISHU_APP_ID / FEISHU_APP_SECRET（这台确实不接飞书登录的，写 FLEET_FEISHU_LOGIN=off 明说，登录只剩账密）',
    );
  }

  const databaseUrl = env.DATABASE_URL || null;
  if (!databaseUrl && !dev) problems.push('缺 DATABASE_URL（Postgres 连接串）');

  // 通行证照旧核（写坏了照样拒启动）；只是这台明说不接飞书（off）时不认它：装机照样会生成一份，但没有网关来用
  const gatewayTokenEnv = env.FLEET_FEISHU_GATEWAY_TOKEN || null;
  if (gatewayTokenEnv !== null) {
    if (gatewayTokenEnv.length < MIN_SECRET_LENGTH) {
      problems.push(`FLEET_FEISHU_GATEWAY_TOKEN 太短：至少 ${MIN_SECRET_LENGTH} 个字符`);
    }
    if (gatewayTokenEnv === sessionSecret || gatewayTokenEnv === agentTokenSecret) {
      problems.push('FLEET_FEISHU_GATEWAY_TOKEN 不能和别的密钥相同');
    }
  }
  const feishuGatewayToken = feishuOff ? null : gatewayTokenEnv;

  const devLoginRequested = env.FLEET_DEV_LOGIN === '1';
  if (devLoginRequested && !dev) problems.push('FLEET_DEV_LOGIN=1 只允许和 FLEET_ENV=development 一起用');
  // 香港把 /auth 转发到公网：驾驶舱接口一旦监听在非回环地址上，免登就等于对公网开门。
  if (devLoginRequested && cockpitListen && !LOOPBACK.has(cockpitListen.host)) {
    problems.push(
      `FLEET_DEV_LOGIN=1 只允许驾驶舱接口监听本机回环地址，现在监听的是 ${cockpitListen.host}：/auth 会被转发到公网，免登不能开`,
    );
  }

  const { temporalAddress, temporalNamespace, fleetTaskQueue } = temporalSettings(env);

  const nodeReport = nodeReportTarget(
    env,
    fleetEnv,
    [sessionSecret, agentTokenSecret, gatewayTokenEnv],
    problems,
  );
  const nodeKeys = nodeKeysFrom(
    env,
    [sessionSecret, agentTokenSecret, gatewayTokenEnv, nodeReport?.token ?? null],
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
    databaseUrl,
    feishuGatewayToken,
    devLogin: devLoginRequested && dev,
    cookieSecure: publicUrl.protocol === 'https:',
    quotaStaleAfterMs: QUOTA_STALE_AFTER_MS,
    sseHeartbeatMs: 25 * 1000,
    temporalAddress,
    temporalNamespace,
    fleetTaskQueue,
    engineOff: !engineEnabled(env),
    feishuOff,
    machineName: machineName(env),
    nodeReport,
    nodeKeys,
  };
}

/**
 * 推快照的目标（FLEET_NODE_REPORT_URL + FLEET_NODE_REPORT_TOKEN）：两项都空 = 不推；只配一项、地址认不出、生产上不是 https、
 * 地址里带账号密码、通行证太短或和别的密钥相同，都拒启动（不猜着推、不悄悄不推）。
 */
function nodeReportTarget(
  env: Env,
  fleetEnv: FleetEnv,
  otherSecrets: readonly (string | null)[],
  problems: string[],
): Config['nodeReport'] {
  const rawUrl = env.FLEET_NODE_REPORT_URL?.trim() || null;
  const token = env.FLEET_NODE_REPORT_TOKEN?.trim() || null;
  if (rawUrl === null && token === null) return null;
  if (rawUrl === null || token === null) {
    problems.push(
      'FLEET_NODE_REPORT_URL 和 FLEET_NODE_REPORT_TOKEN 要一起给（都不给 = 这台不往别的看板推快照）',
    );
    return null;
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    problems.push(`FLEET_NODE_REPORT_URL 不是合法地址：${rawUrl}`);
    return null;
  }
  const before = problems.length;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    problems.push('FLEET_NODE_REPORT_URL 只能是 http(s) 地址');
  } else if (fleetEnv === 'production' && url.protocol !== 'https:') {
    problems.push('FLEET_NODE_REPORT_URL 在生产环境必须是 https（通行证走在请求头里）');
  }
  if (url.username || url.password)
    problems.push('FLEET_NODE_REPORT_URL 里不许带账号密码：通行证放 FLEET_NODE_REPORT_TOKEN');
  if (token.length < MIN_SECRET_LENGTH) {
    problems.push(`FLEET_NODE_REPORT_TOKEN 太短：至少 ${MIN_SECRET_LENGTH} 个字符`);
  }
  if (otherSecrets.includes(token)) problems.push('FLEET_NODE_REPORT_TOKEN 不能和别的密钥相同');
  return problems.length > before ? null : { url, token };
}

/**
 * 收快照的通行证表（FLEET_NODE_KEYS，形如 {"local":"<sha256 十六进制>"}）：不写、空着 = 不收（{}）。写了就必须是 JSON 对象，
 * 键是合法的环境编号，值是 64 位小写十六进制（填成明文、写短了都拒启动）；两个环境不许共用一把；哪一把的明文
 * 和别的密钥（会话、fleet 令牌、网关通行证、本台往外推的通行证）相同也拒——一把钥匙只管一件事。报错只写环境编号，不印哈希。
 */
function nodeKeysFrom(
  env: Env,
  otherSecrets: readonly (string | null)[],
  problems: string[],
): Readonly<Record<string, string>> {
  const raw = env.FLEET_NODE_KEYS?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    problems.push('FLEET_NODE_KEYS 不是合法的 JSON（要写成 {"<环境编号>":"<通行证的 sha256>"}）');
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    problems.push('FLEET_NODE_KEYS 要是一个 JSON 对象：{"<环境编号>":"<通行证的 sha256>"}');
    return {};
  }
  const otherHashes = new Set(
    otherSecrets.flatMap((s) => (s === null ? [] : [createHash('sha256').update(s).digest('hex')])),
  );
  const keys: Record<string, string> = {};
  const owner = new Map<string, string>();
  for (const [id, hash] of Object.entries(parsed)) {
    if (!NodeIdSchema.safeParse(id).success) {
      problems.push(
        `FLEET_NODE_KEYS 里的环境编号 ${JSON.stringify(id)} 不合法（小写字母开头，只许小写字母、数字、短横线，最长 40）`,
      );
      continue;
    }
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      problems.push(
        `FLEET_NODE_KEYS 里 ${id} 的值要是通行证的 sha256（64 位小写十六进制，用 fleet-api node-key new 生成），不能填明文`,
      );
      continue;
    }
    if (otherHashes.has(hash)) {
      problems.push(`FLEET_NODE_KEYS 里 ${id} 的通行证不能和别的密钥相同`);
      continue;
    }
    const taken = owner.get(hash);
    if (taken !== undefined) {
      problems.push(`FLEET_NODE_KEYS 里 ${id} 和 ${taken} 用了同一把通行证：每个环境各发各的`);
      continue;
    }
    owner.set(hash, id);
    keys[id] = hash;
  }
  return keys;
}

/**
 * 驾驶舱接不接飞书登录（FLEET_FEISHU_LOGIN）：不写、空着或 on——接，生产必须配飞书一对；off——这台不接（比如没有香港、
 * 没有对外域名），飞书一对必须空着，登录只剩账密（fleet-api set-password）。
 * 只认这两个写法，写错了拒启动、不猜成哪一种；没写 off、飞书又没配，生产照旧拒启动——不默认放行。
 */
function feishuLogin(env: Env, problems: string[]): 'on' | 'off' {
  const value = env.FLEET_FEISHU_LOGIN?.trim();
  if (value === undefined || value === '' || value === 'on') return 'on';
  if (value === 'off') return 'off';
  problems.push(`FLEET_FEISHU_LOGIN 只能是 on 或 off（off = 这台不接飞书登录），现在是「${value}」`);
  return 'on';
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
