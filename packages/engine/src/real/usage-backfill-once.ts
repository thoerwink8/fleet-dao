// 一次性回填的真接线（#1948）：以法国唯一的会话用户读他家里的 ~/.mirasim/insights（引擎自己的进程进不去，750）。
// 月度文件几十 MB，按关键字 grep -F，不整份 cat。一次命令最多筛两轮（先分支目录名，再唯一对上的会话号）。

import { SESSION_USERS } from '@fleet-dao/adapters';
import { scopeExec } from './exec.ts';
import {
  DEFAULT_MIRASIM_BRIDGE_SCRIPT,
  DEFAULT_MIRASIM_HOME,
  grepAsUser,
  MIRASIM_BRIDGE_NODE,
  mirasimDepsFor,
} from './index.ts';

const USAGE_FILE = /^usage-\d{4}-\d{2}\.ndjson$/;
const NEEDLE = /^[0-9A-Za-z][0-9A-Za-z_:.-]*$/;
/** 一轮 grep 的关键字个数：分支名一批、会话号再一批，避免命令行过长。 */
const CHUNK = 80;
/** 一次性把近几天的月度文件筛完，比定时任务那 10 秒宽。 */
const GREP_TIMEOUT_MS = 60_000;

function uniqLines(parts: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    for (const line of part.split('\n')) {
      if (!line || seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
  }
  return out.join('\n');
}

/**
 * 给 fleet-api usage-backfill-once 用的读账本。目录列不出、筛行失败照抛（调用方一行都不写）。
 * 关键字认不出的丢掉：调用方不会把这种分支名送进来。
 */
export function historicalLedgerReader(
  env: Readonly<Record<string, string | undefined>>,
): (needles: readonly string[]) => Promise<string> {
  const exec = scopeExec();
  const user = SESSION_USERS[0];
  const home = env.FLEET_MIRASIM_HOME?.trim() || DEFAULT_MIRASIM_HOME;
  const mirasim = mirasimDepsFor(exec, home, {
    command: [MIRASIM_BRIDGE_NODE, DEFAULT_MIRASIM_BRIDGE_SCRIPT],
  });
  const dir = mirasim.meterDir(user);
  let files: string[] | undefined;
  return async (needles) => {
    const wanted = [...new Set(needles)].filter((needle) => NEEDLE.test(needle));
    if (wanted.length === 0) return '';
    if (!files) {
      const names = await mirasim.meterFs(user).readdir(dir);
      files = names
        .filter((name) => USAGE_FILE.test(name))
        .sort()
        .map((name) => `${dir}/${name}`);
    }
    if (files.length === 0) return '';
    const parts: string[] = [];
    for (let i = 0; i < wanted.length; i += CHUNK) {
      parts.push(
        await grepAsUser(exec, user, wanted.slice(i, i + CHUNK), files, 'usage-once', GREP_TIMEOUT_MS),
      );
    }
    return uniqLines(parts);
  };
}
