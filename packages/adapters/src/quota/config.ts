// 读取器配置：哪些账号池存在、凭据在哪，是机器配置，不进 git。
// 从 FLEET_QUOTA_CONFIG 指的文件读（默认 /etc/fleet-dao/quota.json）；仓里只有 deploy/examples/quota.example.json。
import { readFile } from 'node:fs/promises';
import type { QuotaConfig, ReaderType, ReadingWindowKind } from './types.ts';
import { isForbiddenClaudeEnv, isRecord } from './util.ts';

export const DEFAULT_QUOTA_CONFIG_PATH = '/etc/fleet-dao/quota.json';

export function quotaConfigPath(env: Record<string, string | undefined> = process.env): string {
  return env.FLEET_QUOTA_CONFIG?.trim() || DEFAULT_QUOTA_CONFIG_PATH;
}

export class QuotaConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`额度读取配置不对：\n- ${problems.join('\n- ')}`);
    this.name = 'QuotaConfigError';
    this.problems = problems;
  }
}

const READER_TYPES: readonly ReaderType[] = [
  'claude-usage',
  'reclaude-carpool',
  'mirasim-relay',
  'cursor-dashboard',
  'grok-billing',
  'estimate',
];
const WINDOW_KINDS: readonly ReadingWindowKind[] = [
  '5h',
  '7d',
  '7d_model',
  'month_usd',
  'points',
  'period_usd',
  'other',
];
const COMMON_KEYS = ['poolId', 'channelId', 'name', 'reader', 'timeoutMs'];
const READER_KEYS: Record<ReaderType, string[]> = {
  'claude-usage': ['command', 'orgKind', 'cwd', 'env'],
  'reclaude-carpool': ['keyFile', 'baseUrl'],
  'mirasim-relay': ['port', 'tokenFile'],
  'cursor-dashboard': ['authFile', 'baseUrl'],
  'grok-billing': ['authFile', 'baseUrl', 'clientVersion'],
  estimate: ['windows', 'usage'],
};

/** 以 _ 或 $ 开头的键留给人写注释（JSON 没有注释），其余不认识的键当拼写错误报出来。 */
const isCommentKey = (k: string) => k.startsWith('_') || k.startsWith('$');

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

function checkUnknownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  problems: string[],
) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k) && !isCommentKey(k)) problems.push(`${where} 有不认识的键 ${k}`);
  }
}

function checkUrl(v: unknown, where: string, problems: string[]) {
  if (v === undefined) return;
  if (!isNonEmptyString(v) || !/^https:\/\//.test(v)) problems.push(`${where} 要是 https:// 开头的地址`);
}

function checkEstimateWindows(v: unknown, where: string, problems: string[]) {
  if (!Array.isArray(v) || v.length === 0) {
    problems.push(`${where}.windows 要是非空数组`);
    return;
  }
  const labels = new Set<string>();
  v.forEach((w: unknown, i) => {
    const at = `${where}.windows[${i}]`;
    if (!isRecord(w)) {
      problems.push(`${at} 要是对象`);
      return;
    }
    checkUnknownKeys(w, ['label', 'window', 'unit', 'periodHours', 'anchor', 'limit', 'scope'], at, problems);
    if (!isNonEmptyString(w.label)) problems.push(`${at}.label 要有`);
    else if (labels.has(w.label)) problems.push(`${at}.label ${w.label} 重复`);
    else labels.add(w.label);
    if (!WINDOW_KINDS.includes(w.window as ReadingWindowKind))
      problems.push(`${at}.window 要是 ${WINDOW_KINDS.join(' / ')}`);
    if (w.unit !== 'usd' && w.unit !== 'points') problems.push(`${at}.unit 要是 usd 或 points`);
    if (typeof w.periodHours !== 'number' || !(w.periodHours > 0))
      problems.push(`${at}.periodHours 要是正数`);
    if (w.anchor !== undefined && (typeof w.anchor !== 'string' || Number.isNaN(Date.parse(w.anchor)))) {
      problems.push(`${at}.anchor 要是 ISO 时间`);
    }
    if (w.limit !== undefined && (typeof w.limit !== 'number' || !(w.limit >= 0)))
      problems.push(`${at}.limit 要是非负数`);
    if (w.scope !== undefined && !isNonEmptyString(w.scope)) problems.push(`${at}.scope 要是非空字符串`);
  });
}

function checkPool(p: unknown, i: number, problems: string[]): void {
  const where = `pools[${i}]`;
  if (!isRecord(p)) {
    problems.push(`${where} 要是对象`);
    return;
  }
  if (!isNonEmptyString(p.poolId)) problems.push(`${where}.poolId 要有`);
  if (!isNonEmptyString(p.channelId)) problems.push(`${where}.channelId 要有`);
  if (p.name !== undefined && typeof p.name !== 'string') problems.push(`${where}.name 要是字符串`);
  if (p.timeoutMs !== undefined && !isPositiveInt(p.timeoutMs))
    problems.push(`${where}.timeoutMs 要是正整数（毫秒）`);
  const reader = p.reader as ReaderType;
  if (!READER_TYPES.includes(reader)) {
    problems.push(`${where}.reader 要是 ${READER_TYPES.join(' / ')} 之一`);
    return;
  }
  checkUnknownKeys(p, [...COMMON_KEYS, ...READER_KEYS[reader]], where, problems);
  switch (reader) {
    case 'claude-usage': {
      if (!Array.isArray(p.command) || p.command.length === 0 || !p.command.every(isNonEmptyString)) {
        problems.push(`${where}.command 要是非空的字符串数组，例如 ["/home/<服务用户>/.local/bin/reclaude"]`);
      }
      if (p.orgKind !== undefined && p.orgKind !== 'solo' && p.orgKind !== 'carpool') {
        problems.push(`${where}.orgKind 要是 solo 或 carpool`);
      }
      if (p.cwd !== undefined && !isNonEmptyString(p.cwd)) problems.push(`${where}.cwd 要是非空字符串`);
      if (p.env !== undefined) {
        if (!isRecord(p.env) || !Object.values(p.env).every((v) => typeof v === 'string')) {
          problems.push(`${where}.env 要是「名字 → 字符串」`);
        } else {
          for (const k of Object.keys(p.env)) {
            if (isForbiddenClaudeEnv(k)) {
              problems.push(
                `${where}.env 不许带 ${k}：ANTHROPIC_* 与 CLAUDE_CODE_OAUTH_TOKEN 会让 Claude Code 绕开 reclaude`,
              );
            }
          }
        }
      }
      break;
    }
    case 'reclaude-carpool':
      if (!isNonEmptyString(p.keyFile)) problems.push(`${where}.keyFile 要有：reclaude API Key 文件的路径`);
      checkUrl(p.baseUrl, `${where}.baseUrl`, problems);
      break;
    case 'mirasim-relay':
      if (p.port !== undefined && !(isPositiveInt(p.port) && p.port <= 65535))
        problems.push(`${where}.port 要是 1–65535`);
      if (p.tokenFile !== undefined && !isNonEmptyString(p.tokenFile))
        problems.push(`${where}.tokenFile 要是非空字符串`);
      break;
    case 'cursor-dashboard':
      if (p.authFile !== undefined && !isNonEmptyString(p.authFile))
        problems.push(`${where}.authFile 要是非空字符串`);
      checkUrl(p.baseUrl, `${where}.baseUrl`, problems);
      break;
    case 'grok-billing':
      if (p.authFile !== undefined && !isNonEmptyString(p.authFile))
        problems.push(`${where}.authFile 要是非空字符串`);
      checkUrl(p.baseUrl, `${where}.baseUrl`, problems);
      if (p.clientVersion !== undefined && !isNonEmptyString(p.clientVersion)) {
        problems.push(`${where}.clientVersion 要是非空字符串`);
      }
      break;
    case 'estimate': {
      checkEstimateWindows(p.windows, where, problems);
      const u = p.usage;
      if (u !== undefined) {
        if (!isRecord(u) || u.type !== 'daily-token-files') {
          problems.push(`${where}.usage.type 目前只认 daily-token-files`);
        } else {
          checkUnknownKeys(u, ['type', 'dir', 'usdPerMTok'], `${where}.usage`, problems);
          if (!isNonEmptyString(u.dir)) problems.push(`${where}.usage.dir 要有`);
          if (typeof u.usdPerMTok !== 'number' || !(u.usdPerMTok > 0))
            problems.push(`${where}.usage.usdPerMTok 要是正数`);
        }
      }
      break;
    }
  }
}

/** 校验配置；所有问题一次列全再报，不是撞到第一个就停。 */
export function parseQuotaConfig(raw: unknown): QuotaConfig {
  const problems: string[] = [];
  if (!isRecord(raw)) throw new QuotaConfigError(['顶层要是对象']);
  checkUnknownKeys(raw, ['timeoutMs', 'pools'], '顶层', problems);
  if (raw.timeoutMs !== undefined && !isPositiveInt(raw.timeoutMs))
    problems.push('timeoutMs 要是正整数（毫秒）');
  if (!Array.isArray(raw.pools) || raw.pools.length === 0) {
    problems.push('pools 要是非空数组');
    throw new QuotaConfigError(problems);
  }
  const ids = new Set<string>();
  raw.pools.forEach((p: unknown, i) => {
    checkPool(p, i, problems);
    if (isRecord(p) && isNonEmptyString(p.poolId)) {
      if (ids.has(p.poolId)) problems.push(`pools[${i}].poolId ${p.poolId} 重复`);
      ids.add(p.poolId);
    }
  });
  if (problems.length) throw new QuotaConfigError(problems);
  return raw as unknown as QuotaConfig;
}

/** 读配置文件并校验。文件不在、不是 JSON、内容不对都抛 QuotaConfigError。 */
export async function loadQuotaConfig(path = quotaConfigPath()): Promise<QuotaConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'ERR';
    throw new QuotaConfigError([
      `读不到配置文件 ${path}（${code}）：用 FLEET_QUOTA_CONFIG 指定，样例见 deploy/examples/quota.example.json`,
    ]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new QuotaConfigError([`配置文件 ${path} 不是合法 JSON：${(e as Error).message}`]);
  }
  return parseQuotaConfig(raw);
}
