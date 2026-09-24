// 从环境变量读配置（香港上是 systemd 的 EnvironmentFile=/etc/fleet-dao/feishu.env，样例见 deploy/feishu.env.example）。
// 凭据、通行证、群编号、创始人 open_id 只从这里来，不进仓；缺了或不合规就拒绝启动，并一次列出全部问题。

export interface Founder {
  openId: string;
  name: string;
}

export interface Config {
  appId: string;
  appSecret: string;
  /** 调后端的通行证，和法国那边 FLEET_FEISHU_GATEWAY_TOKEN 是同一个值。 */
  gatewayToken: string;
  /** 驾驶舱后端，经隧道：例如 http://10.99.0.2:8787。 */
  backendUrl: string;
  /** 驾驶舱在浏览器里的地址，卡片上「打开驾驶舱」用。 */
  publicUrl: string;
  /** 团队群：置顶盘面卡、三类推送都发这里。 */
  teamChatId: string;
  /** 端到端自测用的测试群：能在里面记任务、问进度，但不放盘面卡、不收推送。 */
  testChatId: string | null;
  /** 白名单：只替这几位办事，别人礼貌拒绝。 */
  founders: Founder[];
  /** 收到消息先加的表情（飞书 emoji_type）。 */
  ackEmoji: string;
  /** 每天最多发几张「求人」的卡（要人拍 + AI 追问）；超了只发一张提醒，其余只进驾驶舱。 */
  askBudgetPerDay: number;
  /** 盘面快照多久取一次。 */
  boardRefreshMs: number;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`配置有问题：\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

type Env = Record<string, string | undefined>;

const MIN_TOKEN_LENGTH = 32;

export function loadConfig(env: Env): Config {
  const problems: string[] = [];
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) problems.push(`缺 ${name}`);
    return v ?? '';
  };

  const appId = need('FEISHU_APP_ID');
  const appSecret = need('FEISHU_APP_SECRET');
  if (appId && !appId.startsWith('cli_'))
    problems.push('FEISHU_APP_ID 应以 cli_ 开头（飞书开发者后台「凭证与基础信息」里的 App ID）');

  const gatewayToken = need('FLEET_FEISHU_GATEWAY_TOKEN');
  if (gatewayToken && gatewayToken.length < MIN_TOKEN_LENGTH) {
    problems.push(`FLEET_FEISHU_GATEWAY_TOKEN 太短：至少 ${MIN_TOKEN_LENGTH} 个字符`);
  }

  const backendUrl = baseUrl('FLEET_BACKEND_URL', need('FLEET_BACKEND_URL'), problems);
  const publicUrl = baseUrl('FLEET_PUBLIC_URL', need('FLEET_PUBLIC_URL'), problems);

  const teamChatId = need('FEISHU_TEAM_CHAT_ID');
  if (teamChatId && !teamChatId.startsWith('oc_'))
    problems.push('FEISHU_TEAM_CHAT_ID 应以 oc_ 开头（群的 chat_id）');
  const testChatId = env.FEISHU_TEST_CHAT_ID?.trim() || null;
  if (testChatId && !testChatId.startsWith('oc_')) problems.push('FEISHU_TEST_CHAT_ID 应以 oc_ 开头');
  if (testChatId && testChatId === teamChatId) problems.push('FEISHU_TEST_CHAT_ID 不能和团队群是同一个');

  const founders = parseFounders(need('FEISHU_FOUNDERS'), problems);

  const ackEmoji = env.FEISHU_ACK_EMOJI?.trim() || 'Get';
  if (!/^[A-Za-z0-9_]{1,40}$/.test(ackEmoji))
    problems.push(`FEISHU_ACK_EMOJI 不像飞书的 emoji_type：「${ackEmoji}」`);

  const askBudgetPerDay = intIn(
    'FEISHU_ASK_BUDGET_PER_DAY',
    env.FEISHU_ASK_BUDGET_PER_DAY,
    10,
    1,
    200,
    problems,
  );
  const boardRefreshSeconds = intIn(
    'FEISHU_BOARD_REFRESH_SECONDS',
    env.FEISHU_BOARD_REFRESH_SECONDS,
    30,
    5,
    3600,
    problems,
  );

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    appId,
    appSecret,
    gatewayToken,
    backendUrl,
    publicUrl,
    teamChatId,
    testChatId,
    founders,
    ackEmoji,
    askBudgetPerDay,
    boardRefreshMs: boardRefreshSeconds * 1000,
  };
}

/** 「ou_a:甲,ou_b:乙」；名字可省（卡片上显示 open_id 末 4 位）。 */
function parseFounders(value: string, problems: string[]): Founder[] {
  if (!value) return [];
  const founders: Founder[] = [];
  for (const part of value.split(',')) {
    const item = part.trim();
    if (!item) continue;
    const colon = item.indexOf(':');
    const openId = (colon === -1 ? item : item.slice(0, colon)).trim();
    const name = (colon === -1 ? '' : item.slice(colon + 1)).trim();
    if (!openId.startsWith('ou_')) {
      problems.push(`FEISHU_FOUNDERS 里「${openId}」不是 open_id（应以 ou_ 开头）`);
      continue;
    }
    if (founders.some((f) => f.openId === openId)) {
      problems.push(`FEISHU_FOUNDERS 里 ${openId} 写了两次`);
      continue;
    }
    founders.push({ openId, name: name || `创始人…${openId.slice(-4)}` });
  }
  if (founders.length === 0) problems.push('FEISHU_FOUNDERS 至少要有一位创始人');
  return founders;
}

function baseUrl(name: string, value: string, problems: string[]): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      problems.push(`${name} 要是 http(s) 地址，现在是「${value}」`);
    }
    if (url.pathname !== '/' || url.search || url.hash)
      problems.push(`${name} 只写到域名（和端口），不带路径`);
    return url.origin;
  } catch {
    problems.push(`${name} 不是合法地址：「${value}」`);
    return '';
  }
}

function intIn(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  problems: string[],
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} 要是 ${min}–${max} 之间的整数，现在是「${value}」`);
    return fallback;
  }
  return n;
}
