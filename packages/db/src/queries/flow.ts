// 流程配置副本（repos 表的 flow_* 列，docs/decisions/0003-fusion-flow.md 第 9 条）的读写：只由引擎的对账写
// （packages/engine/src/jobs/flow-config.ts），接活、起会话读。往里写什么、能不能派活由 @fleet-dao/core 的 replica.ts 判，
// 这里照着写、原样读，不补默认值。
import { eq } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { repos } from '../schema/index.ts';

/** 一个仓的副本此刻的样子（字段和 core 的 FlowReplica 对得上，外加给人看的几样）。 */
export interface FlowReplicaState {
  repoId: string;
  owner: string;
  name: string;
  /** 最近一次读成、认得出的时刻；从没读成过是 null。 */
  syncedAt: Date | null;
  /** 认不出的原因（非空就停派）。 */
  error: string | null;
  /** 最近一次没查成的原因。 */
  unread: string | null;
  /** 副本里的测试命令（flow_config 的 testCommand）；项目没写、从没读成过都是 null。 */
  testCommand: string | null;
  source: 'project' | 'org_default' | null;
  commit: string | null;
  checkedAt: Date | null;
}

type RepoRow = typeof repos.$inferSelect;

/** 副本里的测试命令。库里有约束（repos_flow_config_shape）保证它要么没有、要么是不空的字符串。 */
export function replicaTestCommand(config: RepoRow['flowConfig']): string | null {
  const v = config?.testCommand;
  return typeof v === 'string' ? v : null;
}

export function flowReplicaOf(row: RepoRow): FlowReplicaState {
  return {
    repoId: row.id,
    owner: row.owner,
    name: row.name,
    syncedAt: row.flowSyncedAt,
    error: row.flowError,
    unread: row.flowUnread,
    testCommand: replicaTestCommand(row.flowConfig),
    source: row.flowSource,
    commit: row.flowCommit,
    checkedAt: row.flowCheckedAt,
  };
}

/** 受管的仓（repos 表的每一行）连同副本此刻的样子：对账逐个去读。 */
export async function listFlowReplicas(db: Db): Promise<FlowReplicaState[]> {
  const rows = await db.select().from(repos).orderBy(repos.owner, repos.name);
  return rows.map(flowReplicaOf);
}

/** 对账这一轮往副本里写的（core 的 flowSync 判出来的三种）。 */
export type FlowReplicaWrite =
  /** 读成、认得出：整份换掉，清掉出错和没查成；配置里写了测试命令就顺带改给人看的 test_command。 */
  | {
      write: 'synced';
      config: Record<string, unknown>;
      source: 'project' | 'org_default';
      commit: string;
      testCommand: string | null;
    }
  /** 认不出：配置、测试命令、同步时刻都不动，只记原因（停派）。 */
  | { write: 'invalid'; why: string }
  /** 没查成：什么都不动，只记这一次没查成的原因。 */
  | { write: 'unread'; why: string };

/** 写一个仓的副本。这个仓刚被删掉（列出来之后）回 not_found，不装作写上了。 */
export async function writeFlowReplica(
  db: Db,
  repoId: string,
  w: FlowReplicaWrite,
  at: Date,
): Promise<'ok' | 'not_found'> {
  const set: Partial<typeof repos.$inferInsert> =
    w.write === 'synced'
      ? {
          flowConfig: w.config,
          flowSource: w.source,
          flowCommit: w.commit,
          flowSyncedAt: at,
          flowError: null,
          flowCheckedAt: at,
          flowUnread: null,
          ...(w.testCommand !== null ? { testCommand: w.testCommand } : {}),
        }
      : w.write === 'invalid'
        ? { flowError: w.why, flowCheckedAt: at, flowUnread: null }
        : { flowCheckedAt: at, flowUnread: w.why };
  const updated = await db.update(repos).set(set).where(eq(repos.id, repoId)).returning({ id: repos.id });
  return updated.length > 0 ? 'ok' : 'not_found';
}
