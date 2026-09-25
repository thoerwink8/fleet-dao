// 机器配置：判断题后端的地址、密钥文件、起 reclaude 的命令。不进 git。
// 从 FLEET_JEV_CONFIG 指的文件读（默认 /etc/fleet-dao/jev.json）；样例是 packages/jev/config.example.json。
// 用哪个后端、哪个模型不在这里定：调度台「判断」阶段排第一的那条路由说了算（backendForRoute）。
import { readFile } from 'node:fs/promises';
import type { ClaudeEffort } from '@fleet-dao/adapters';
import type { HostId } from '@fleet-dao/shared';
import { checkPinnedModel, type JevBackend } from './backend.ts';
import { createTypesafeBackend } from './backends/typesafe.ts';

export const DEFAULT_JEV_CONFIG_PATH = '/etc/fleet-dao/jev.json';

export function jevConfigPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.FLEET_JEV_CONFIG?.trim() || DEFAULT_JEV_CONFIG_PATH;
}

export interface JevMachineConfig {
  typesafe?: {
    /** 例如 https://api.typesafe.ai/v1/systemone。 */
    endpoint: string;
    /** 密钥文件（一行），root:fleet 0640：引擎读得到，会话用户读不到。 */
    keyFile: string;
    timeoutMs?: number;
  };
  claude?: {
    /** 起 reclaude 的命令，绝对路径。 */
    command: string[];
    effort?: ClaudeEffort;
    workRoot?: string;
    wallClockMs?: number;
  };
}

export class JevConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`判断题配置不对：\n- ${problems.join('\n- ')}`);
    this.name = 'JevConfigError';
    this.problems = problems;
  }
}

const EFFORTS: readonly ClaudeEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isPositiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
/** 以 _ 开头的键留给人写注释（JSON 没有注释）。 */
const isComment = (k: string) => k.startsWith('_');

function unknownKeys(obj: Record<string, unknown>, allowed: string[], where: string, problems: string[]) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k) && !isComment(k)) problems.push(`${where} 有不认识的键 ${k}`);
  }
}

export function parseJevConfig(raw: unknown): JevMachineConfig {
  const problems: string[] = [];
  if (!isRecord(raw)) throw new JevConfigError(['配置要是一个 JSON 对象']);
  unknownKeys(raw, ['typesafe', 'claude'], '配置', problems);
  const out: JevMachineConfig = {};
  if (raw.typesafe !== undefined) {
    const t = raw.typesafe;
    if (!isRecord(t)) problems.push('typesafe 要是对象');
    else {
      unknownKeys(t, ['endpoint', 'keyFile', 'timeoutMs'], 'typesafe', problems);
      if (!isText(t.endpoint) || !/^https:\/\//.test(t.endpoint))
        problems.push('typesafe.endpoint 要是 https:// 开头的地址');
      if (!isText(t.keyFile)) problems.push('typesafe.keyFile 要是密钥文件的路径');
      if (t.timeoutMs !== undefined && !isPositiveInt(t.timeoutMs))
        problems.push('typesafe.timeoutMs 要是正整数（毫秒）');
      if (isText(t.endpoint) && isText(t.keyFile)) {
        out.typesafe = {
          endpoint: t.endpoint,
          keyFile: t.keyFile,
          ...(isPositiveInt(t.timeoutMs) ? { timeoutMs: t.timeoutMs } : {}),
        };
      }
    }
  }
  if (raw.claude !== undefined) {
    const c = raw.claude;
    if (!isRecord(c)) problems.push('claude 要是对象');
    else {
      unknownKeys(c, ['command', 'effort', 'workRoot', 'wallClockMs'], 'claude', problems);
      const command = c.command;
      const commandOk = Array.isArray(command) && command.length > 0 && command.every(isText);
      if (!commandOk)
        problems.push('claude.command 要是非空的字符串数组，例如 ["/home/<会话用户>/.local/bin/reclaude"]');
      if (c.effort !== undefined && !EFFORTS.includes(c.effort as ClaudeEffort))
        problems.push(`claude.effort 要是 ${EFFORTS.join(' / ')} 之一`);
      if (c.workRoot !== undefined && !isText(c.workRoot)) problems.push('claude.workRoot 要是目录路径');
      if (c.wallClockMs !== undefined && !isPositiveInt(c.wallClockMs))
        problems.push('claude.wallClockMs 要是正整数（毫秒）');
      if (commandOk) {
        out.claude = {
          command: command as string[],
          ...(EFFORTS.includes(c.effort as ClaudeEffort) ? { effort: c.effort as ClaudeEffort } : {}),
          ...(isText(c.workRoot) ? { workRoot: c.workRoot } : {}),
          ...(isPositiveInt(c.wallClockMs) ? { wallClockMs: c.wallClockMs } : {}),
        };
      }
    }
  }
  if (problems.length) throw new JevConfigError(problems);
  return out;
}

export async function loadJevConfig(path: string): Promise<JevMachineConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    throw new JevConfigError([`读不到配置文件 ${path}：${(err as Error).message}`]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new JevConfigError([`${path} 不是合法的 JSON：${(err as Error).message}`]);
  }
  return parseJevConfig(raw);
}

export const CLAUDE_ROUTE_CLOSED =
  '判断路由走 Claude 会话先不开：要经 fleet-agent-scope 以会话用户的身份起，插头 PR #14 合并、本包接上之前一律拒绝';

/** 调度台「判断」阶段选中的路由：执行方式 + 具体模型（引擎把目录里的模型换成执行体认的型号）。 */
export interface JudgeRoute {
  hostId: HostId;
  model: string;
}

/**
 * 按路由起后端。TypeSafe 走「接口 + 自研外壳」（api-shell）、模型 jev-*；Claude 走 claude-code（接上 fleet-agent-scope 之前关着）。
 * 配置缺了、模型没钉死、执行方式接不了判断题，都当场报错——这是装机问题，不该等到第一次提问才发现。
 */
export async function backendForRoute(
  route: JudgeRoute,
  config: JevMachineConfig,
  readKey: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
): Promise<JevBackend> {
  if (route.hostId === 'api-shell' && route.model.startsWith('jev-')) {
    const problem = checkPinnedModel('typesafe', route.model);
    if (problem) throw new JevConfigError([problem]);
    if (!config.typesafe) throw new JevConfigError(['判断路由走 TypeSafe，但机器配置里没有 typesafe 一节']);
    let key: string;
    try {
      key = (await readKey(config.typesafe.keyFile)).trim();
    } catch (err) {
      throw new JevConfigError([`读不到 TypeSafe 密钥文件：${(err as Error).message}`]);
    }
    if (!key) throw new JevConfigError(['TypeSafe 密钥文件是空的']);
    return createTypesafeBackend({
      endpoint: config.typesafe.endpoint,
      apiKey: key,
      model: route.model,
      ...(config.typesafe.timeoutMs ? { timeoutMs: config.typesafe.timeoutMs } : {}),
    });
  }
  if (route.hostId === 'claude-code') {
    const problem = checkPinnedModel('claude-code', route.model);
    if (problem) throw new JevConfigError([problem]);
    // 先关着：Claude 判断会话要以会话用户的身份经 fleet-agent-scope 起（插头 PR #14 的 cgroup 参数），
    // 本包的 Claude 后端现在还以调用方自己的身份直接起 reclaude。接上之后按 config.claude 起 createClaudeJudgeBackend，
    // 连同这道闸的测试一起改掉。
    throw new JevConfigError([CLAUDE_ROUTE_CLOSED]);
  }
  throw new JevConfigError([`这条路由接不了判断题：执行方式 ${route.hostId}、模型 ${route.model}`]);
}
