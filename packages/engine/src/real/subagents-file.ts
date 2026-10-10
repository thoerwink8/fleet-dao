// 子代理定义文件（#1641 第 4b 片）：引擎启动时从发布目录的 .claude/agents/ 生成一份 `--agents` 要的 JSON，claude-code 的干活会话带上它。
//
// 改这里之前必须知道：
// - 写到会话用户读得到的地方：引擎自己的状态目录是 fleet:fleet 750，会话用户进不去；这里默认放 /var/lib/fleet-sessions/agents
//   （上一级 711：会话用户知道完整路径就进得去，列不出别的），文件 644，文件名带内容哈希——换一版定义就是新文件，
//   正在跑的会话读的旧文件不被改。
// - 生成不成不悄悄不带：导出的函数抛错，hosts.ts 让 claude-code 的干活会话起不来并写清原因（路由探针不用它）。
// - 同一份内容重复生成是幂等的（同名同字节就不重写）。

import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isolatedSubagentNames,
  loadSubagents,
  renderAgentsJson,
  SUBAGENTS_DIR,
  type SubagentDefinitions,
} from '@fleet-dao/adapters';

/** 会话用户读得到的放置目录（france.sh 建的 /var/lib/fleet-sessions 是 fleet:fleet 711）。 */
export const DEFAULT_AGENTS_DIR = '/var/lib/fleet-sessions/agents';

export interface SubagentSet {
  /** --agents 的文件（绝对路径）。 */
  file: string;
  /** 全部子代理的名字。 */
  names: string[];
  /** 带 isolation: worktree 的那几个（会话已经在任务的工作树里，要 deny）。 */
  isolated: string[];
}

export interface PrepareSubagentsOptions {
  /** 定义所在的目录，默认发布目录里的 .claude/agents。 */
  sourceDir?: string;
  /** 文件放哪，默认 DEFAULT_AGENTS_DIR。 */
  outDir?: string;
  /** 测试用。 */
  load?: (dir: string) => Promise<SubagentDefinitions>;
}

function contentName(json: string): string {
  return `subagents-${createHash('sha256').update(json).digest('hex').slice(0, 16)}.json`;
}

/** 生成并落盘。任何一步不成都抛带原因的错（调用方当「claude-code 会话起不来」处理）。 */
export async function prepareSubagents(options: PrepareSubagentsOptions = {}): Promise<SubagentSet> {
  const sourceDir = options.sourceDir ?? SUBAGENTS_DIR;
  const outDir = options.outDir ?? DEFAULT_AGENTS_DIR;
  try {
    const defs = await (options.load ?? loadSubagents)(sourceDir);
    const json = renderAgentsJson(defs);
    const file = join(outDir, contentName(json));
    await mkdir(outDir, { recursive: true, mode: 0o755 });
    // mkdir 的 mode 受 umask 管：显式放开读和进入，会话用户才进得去
    await chmod(outDir, 0o755);
    const same = await readFile(file, 'utf8').then(
      (old) => old === json,
      () => false,
    );
    if (!same) await writeFile(file, json, { mode: 0o644 });
    await chmod(file, 0o644);
    return {
      file,
      names: Object.keys(defs),
      isolated: await isolatedSubagentNames(sourceDir),
    };
  } catch (error) {
    throw new Error(
      `子代理定义文件生成不成（${sourceDir} → ${outDir}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * 要挡哪些子代理（segment-settings.ts 写 deny 用）：只读定义、不落盘，所以文件目录写不了时 Mirasim 那边的挡法照样有。
 * 读不到抛带原因的错（调用方不起会话：deny 写不上，非 Claude 的会话就会派出 Claude 模型的子代理）。
 */
export async function readSubagentGuard(sourceDir: string = SUBAGENTS_DIR): Promise<{
  names: string[];
  isolated: string[];
}> {
  try {
    return {
      names: Object.keys(await loadSubagents(sourceDir)),
      isolated: await isolatedSubagentNames(sourceDir),
    };
  } catch (error) {
    throw new Error(
      `子代理定义读不到（${sourceDir}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * 引擎启动时生成一次：立刻开始、结果存成一个承诺；没人用时失败也不会变成「未处理的拒绝」，真有 claude-code 的干活会话
 * 来取才抛出来。
 */
export function subagentsOnce(
  prepare: () => Promise<SubagentSet> = prepareSubagents,
  onFailure?: (error: Error) => void,
): () => Promise<SubagentSet> {
  const pending = prepare();
  pending.catch((error: unknown) => onFailure?.(error instanceof Error ? error : new Error(String(error))));
  return () => pending;
}

/** 成功的结果记住、失败的不记（下次再试）：定义目录一时读不到，修好之后不用重启引擎。 */
export function lazyOnSuccess<T>(load: () => Promise<T>): () => Promise<T> {
  let done: Promise<T> | undefined;
  return () => {
    if (done) return done;
    const p = load();
    done = p;
    p.catch(() => {
      if (done === p) done = undefined;
    });
    return p;
  };
}
