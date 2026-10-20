// 机器通行证现在认谁（#3388）：库里 node_keys 的有效通行证 + 旧配置 FLEET_NODE_KEYS，同编号以库为准。
// 改这里之前必须知道：
// - 每次认人现读库，不缓存：发钥匙不用重启，作废后下一个请求就被拒。
// - 同编号两处都有时库为准：库里的行（有效的用库里的哈希，作废的则这个编号整个不认）盖掉环境变量里的那一把。
//   作废是写 revoked_at、不删行，正是为了让它能遮住环境变量里的旧值（否则撤了库里的、旧配置又复活）。
// - 库读失败抛 503 node_keys_unreadable：不当成通行证不对（401），也不退回只认环境变量放行。
import type { NodeKeyRecord } from '@fleet-dao/store';
import type { Deps } from './deps.ts';
import { ApiError } from './http.ts';

export const NODE_KEYS_UNREADABLE = 'node_keys_unreadable';

/** 合并：环境变量里的当底，库里的行逐个盖上去（作废的把该编号抹掉）。纯函数，测试直接用。 */
export function mergeNodeKeys(
  env: Readonly<Record<string, string>>,
  rows: readonly Pick<NodeKeyRecord, 'nodeId' | 'tokenHash' | 'revokedAt'>[],
): Record<string, string> {
  const merged: Record<string, string> = { ...env };
  for (const row of rows) {
    if (row.revokedAt === undefined) merged[row.nodeId] = row.tokenHash;
    else delete merged[row.nodeId];
  }
  return merged;
}

/**
 * 现在有效的 环境编号 → 通行证 sha256，和「这台发没发过通行证」（configured：库里有过行，哪怕全作废了，或 FLEET_NODE_KEYS 有）。
 * 全作废后 keys 为空但 configured 为真：认人回 401，不回「没配」的 503。读库失败抛 ApiError(503)。
 */
export async function readNodeKeys(
  deps: Pick<Deps, 'config' | 'store' | 'log'>,
): Promise<{ keys: Record<string, string>; configured: boolean }> {
  try {
    const rows = await deps.store.listNodeKeys();
    return {
      keys: mergeNodeKeys(deps.config.nodeKeys, rows),
      configured: rows.length > 0 || Object.keys(deps.config.nodeKeys).length > 0,
    };
  } catch (err) {
    deps.log.warn('机器通行证读库失败', { code: NODE_KEYS_UNREADABLE });
    throw new ApiError(
      503,
      NODE_KEYS_UNREADABLE,
      `读不到库里的机器通行证（${err instanceof Error ? err.message : String(err)}）：不放行，也不当成通行证不对`,
    );
  }
}

/** 只要有效的那张表（看板读口用）。 */
export async function effectiveNodeKeys(
  deps: Pick<Deps, 'config' | 'store' | 'log'>,
): Promise<Record<string, string>> {
  return (await readNodeKeys(deps)).keys;
}
