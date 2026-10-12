// 升级请求和结果落在磁盘上的那一层（#1971）。引擎写 wanted.json 和 request.json，root 的单元写 state.json。
// 引擎重启会丢掉内存里的排空：请求还在、结果还没对上，就在接活之前把升级排空挂回去。
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CLI_UPGRADE_CORDON_MS,
  CLI_UPGRADE_DIR,
  CLI_UPGRADE_REQUEST_NAME,
  CLI_UPGRADE_STATE_NAME,
  CLI_UPGRADE_STUCK_MS,
  CLI_UPGRADE_WANTED_NAME,
  parseUpgradeState,
  type UpgradeState,
} from './cli-upgrade.ts';
import type { Cordon, EngineDrain } from './drain.ts';

export function cliUpgradeDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.FLEET_CLI_UPGRADE_DIR ?? CLI_UPGRADE_DIR;
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

export async function readUpgradePendingAt(dir: string): Promise<string | null> {
  const raw = await readJson(join(dir, CLI_UPGRADE_WANTED_NAME));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const at = (raw as { at?: unknown }).at;
  return typeof at === 'string' && at !== '' ? at : null;
}

export async function readUpgradeStateFile(dir: string): Promise<UpgradeState | null> {
  return parseUpgradeState(await readJson(join(dir, CLI_UPGRADE_STATE_NAME)));
}

/** PathExists 只在文件出现时触发。盖掉已经在的请求不会再起单元，所以先删再写。 */
export async function writeUpgradeRequest(dir: string, at: string): Promise<void> {
  const body = `${JSON.stringify({ schema: 1, at, why: 'idle' })}\n`;
  const wanted = join(dir, CLI_UPGRADE_WANTED_NAME);
  const request = join(dir, CLI_UPGRADE_REQUEST_NAME);
  await writeFile(wanted, body, { mode: 0o644 });
  await rm(request, { force: true });
  await writeFile(request, body, { mode: 0o644 });
}

export async function clearUpgradePending(dir: string): Promise<void> {
  await rm(join(dir, CLI_UPGRADE_WANTED_NAME), { force: true });
  await rm(join(dir, CLI_UPGRADE_REQUEST_NAME), { force: true });
}

/** 单元没来：请求改名，wanted 删掉。文件本来没有就不算错。 */
export async function quarantineUpgradeRequest(dir: string): Promise<void> {
  await rename(join(dir, CLI_UPGRADE_REQUEST_NAME), join(dir, 'request.stuck')).catch(() => undefined);
  await rm(join(dir, CLI_UPGRADE_WANTED_NAME), { force: true });
}

/**
 * 请求还在、结果对不上、并且还没过「单元没来」的时限：重新挂上升级排空。
 * 已经对上、或已经超时：不挂。超时的由下一轮定时任务记卡住，不在这里把会话再挡一会儿。
 */
export async function restoreCliUpgradeCordon(
  drain: EngineDrain,
  dir: string,
  now: Date = new Date(),
): Promise<void> {
  const pendingAt = await readUpgradePendingAt(dir);
  if (!pendingAt) return;
  const state = await readUpgradeStateFile(dir);
  if (state?.at === pendingAt) return;
  const sinceMs = Date.parse(pendingAt);
  if (Number.isNaN(sinceMs)) return;
  if (now.getTime() - sinceMs >= CLI_UPGRADE_STUCK_MS) return;
  const cordon: Cordon = {
    source: 'cli-upgrade',
    since: new Date(sinceMs).toISOString(),
    until: new Date(sinceMs + CLI_UPGRADE_CORDON_MS).toISOString(),
    why: '空闲，升级命令行工具（引擎重启，请求还在）',
  };
  drain.cordon(cordon);
}
