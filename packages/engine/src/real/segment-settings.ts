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

import {
  MAX_CONCURRENT_SUBAGENTS,
  parseSubagent,
  renderAgentsJson,
  type SubagentDefinitions,
} from '@fleet-dao/adapters';
import { type Db, resolveAlertWithReason, upsertAlert } from '@fleet-dao/db';
import { PortError } from '../ports.ts';
import { readHomeFile, readTreeFile, type UserTree, writeTreeFile } from './user-git.ts';

export const LOCAL_SETTINGS_PATH = '.claude/settings.local.json';

/** 一次写入要挡的子代理。 */
export interface SubagentGuard {
  /** 全部子代理的名字。 */
  names: readonly string[];
  /** 带 isolation: worktree 的。 */
  isolated: readonly string[];
  /** 仓里的定义（不给 = 不核对家里装的那份）。 */
  definitions?: SubagentDefinitions;
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

/**
 * Mirasim 的 Claude 会话怎么拿到子代理定义（#2820）：它不带 --agents，读会话用户家里的 ~/.claude/agents/<名>.md，
 * 那三份由 agents-sync 随每次发版装进去（packages/agents-sync 的 SUBAGENT_TARGET，docs/ops.md 第五节）。
 * 这里在 Claude 模型的会话开跑前核对：家里装的那份按 loadSubagents 同一个解析函数（parseSubagent）读出来，和仓里的定义逐份比
 * （比的是 --agents 里的那个形状，不比字节）。对上了回 []；对不上的每份回一条说明（家里没有、和仓里不一样、解析不了、读不了）。
 * 对不上照常起会话（#2834）：挡掉整条主力线的代价远大于子代理档位不对的代价（子代理跟着会话用主模型，只是多花钱），
 * 所以这里不抛错；说明交给调用方（task-segment.ts）经 reportSubagentDefs 报成一条提醒，对上了再撤。
 * 非 Claude 模型全部子代理已经 deny，不核对，回 null（没核对）；清单里没带定义也回 null。被叫停（signal 已经 aborted）照常抛。
 * home 只给测试用（默认按账号库查会话用户的家目录）。
 */
export async function checkSubagentsInstalled(
  t: UserTree,
  guard: SubagentGuard,
  model: string,
  home?: string,
): Promise<string[] | null> {
  if (!guard.definitions || !isClaudeModel(model)) return null;
  const problems: string[] = [];
  for (const [name, want] of Object.entries(guard.definitions)) {
    const file = `${name}.md`;
    let raw: Buffer | null;
    try {
      raw = await readHomeFile(t, `.claude/agents/${file}`, home);
    } catch (error) {
      if (t.signal?.aborted) throw error;
      const why = error instanceof Error ? error.message : String(error);
      problems.push(`${name}：读不了 .claude/agents/${file}（${why}）`);
      continue;
    }
    if (raw === null) {
      problems.push(`${name}：家里没有 .claude/agents/${file}`);
      continue;
    }
    try {
      const got = parseSubagent(file, raw.toString('utf8'));
      if (renderAgentsJson({ [name]: got.definition }) !== renderAgentsJson({ [name]: want }))
        problems.push(`${name}：和仓里 agents/subagents/${file} 不一样`);
    } catch (error) {
      problems.push(`${name}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return problems;
}

/** 提醒的键前缀：每个会话用户一条（#2834）。 */
export const SUBAGENT_DEFS_ALERT_PREFIX = 'segment-subagent-defs:';

/**
 * 子代理定义对不上的提醒（#2834）：problems 非空就写（同一个键原地更新、不重复推）；空的就撤掉（本来没有、撤过了都不算错）。
 * 报不成的话抛出来，由调用方记日志、不挡会话。
 */
export async function reportSubagentDefs(db: Db, user: string, problems: readonly string[]): Promise<void> {
  const dedupeKey = `${SUBAGENT_DEFS_ALERT_PREFIX}${user}`;
  if (problems.length === 0) {
    await resolveAlertWithReason(db, {
      dedupeKey,
      by: 'engine',
      why: '会话用户家里的子代理定义和仓里对上了',
    });
    return;
  }
  await upsertAlert(db, {
    dedupeKey,
    level: 'alert',
    taskId: null,
    title: `会话用户 ${user} 家里的子代理定义和仓里对不上（会话照常起）`,
    body: `${problems.join('\n')}\n\n子代理的档位可能不对（比如 Explore 跟着会话用主模型）。发版时 agents-sync 会换回仓里的；没跟上就照 docs/ops.md 第五节那条同步命令手动跑一次。`,
  });
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
