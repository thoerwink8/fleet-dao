// 任务工作树里的 .claude/settings.local.json（#1641 第 4c 片）。
//
// 改这里之前必须知道：
// - 谁读它：Mirasim 的 claude 执行体不限 setting-sources，三层设置都读，本地这一层最后加载；引擎自己经 reclaude 起的
//   claude-code 会话带 `--setting-sources project`，不读它，两边互不影响（specs/1641-子代理分档/法国实装.md 第二节 B）。
// - 写什么：env 里给子代理并发上限；permissions.deny 挡掉 Agent(<名字>)——带 isolation: worktree 的那几个（会话已经在任务自己的
//   工作树里，嵌一层工作树改出来的东西不在交付分支上），以及会话模型不是 Claude 时挡掉全部子代理（不然 deepseek 的会话
//   会派出 Claude 模型的子代理，扣中转的 Claude 额度，选路和记账都看不见）。名字逐个列，不用通配。
// - 工作树里本来就有这个文件就合并：认不出的键原样留着，env 里人写的同名键不覆盖，deny 取并集；文件不是合法 JSON 就抛错，
//   不覆盖人写的东西。
// - 文件在 .gitignore 里（仓根），不然会被会话的 git add -A 带进 PR。

import { MAX_CONCURRENT_SUBAGENTS } from '@fleet-dao/adapters';
import { PortError } from '../ports.ts';
import { readTreeFile, type UserTree, writeTreeFile } from './user-git.ts';

export const LOCAL_SETTINGS_PATH = '.claude/settings.local.json';

/** 一次写入要挡的子代理。 */
export interface SubagentGuard {
  /** 全部子代理的名字。 */
  names: readonly string[];
  /** 带 isolation: worktree 的。 */
  isolated: readonly string[];
}

/** 这一段会话的模型是不是 Claude（路由的上游模型串，例如 claude-sonnet-5-5、deepseek-flash）。 */
export function isClaudeModel(model: string): boolean {
  return /^claude-/i.test(model);
}

export function denyRules(guard: SubagentGuard, model: string): string[] {
  const blocked = isClaudeModel(model) ? guard.isolated : guard.names;
  return blocked.map((n) => `Agent(${n})`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 把我们的两样并进已有内容（没有文件传 undefined）。已有内容形状不对（env、permissions 不是对象，deny 不是数组）抛错。 */
export function mergeLocalSettings(existing: unknown, deny: readonly string[]): Record<string, unknown> {
  const base = existing === undefined ? {} : existing;
  if (!isObject(base)) throw new Error(`${LOCAL_SETTINGS_PATH} 的顶层不是对象`);
  const env = base.env === undefined ? {} : base.env;
  if (!isObject(env)) throw new Error(`${LOCAL_SETTINGS_PATH} 的 env 不是对象`);
  const permissions = base.permissions === undefined ? {} : base.permissions;
  if (!isObject(permissions)) throw new Error(`${LOCAL_SETTINGS_PATH} 的 permissions 不是对象`);
  const oldDeny = permissions.deny === undefined ? [] : permissions.deny;
  if (!Array.isArray(oldDeny)) throw new Error(`${LOCAL_SETTINGS_PATH} 的 permissions.deny 不是数组`);
  return {
    ...base,
    // 人写的同名键排在后面，不被盖掉
    env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: MAX_CONCURRENT_SUBAGENTS, ...env },
    permissions: { ...permissions, deny: [...new Set([...oldDeny, ...deny])] },
  };
}

/** 以会话用户读—合并—写。读不了、不是 JSON、写不成都抛 PortError（deny 没写上不能装作写上了）。 */
export async function writeSegmentLocalSettings(
  t: UserTree,
  guard: SubagentGuard,
  model: string,
): Promise<void> {
  const raw = await readTreeFile(t, LOCAL_SETTINGS_PATH);
  let existing: unknown;
  if (raw !== null) {
    try {
      existing = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      throw new PortError(
        'SEGMENT_SETTINGS_BAD',
        `${LOCAL_SETTINGS_PATH} 不是合法 JSON，不覆盖：${error instanceof Error ? error.message : String(error)}`,
        { retryable: false },
      );
    }
  }
  let merged: Record<string, unknown>;
  try {
    merged = mergeLocalSettings(existing, denyRules(guard, model));
  } catch (error) {
    throw new PortError('SEGMENT_SETTINGS_BAD', error instanceof Error ? error.message : String(error), {
      retryable: false,
    });
  }
  await writeTreeFile(t, LOCAL_SETTINGS_PATH, Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, 'utf8'));
}
