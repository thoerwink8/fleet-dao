// 流程配置副本的对账（docs/decisions/0003-fusion-flow.md 第 9 条：流程配置以仓里的 .fleet/flow.json 为准，库里只是副本）：
// 每轮 GitHub 对账（github-reconcile.ts，每 15 分钟）先把每个受管的仓默认分支头上的 .fleet/flow.json 读一遍，用 core 的
// flowSync 和全组织默认合并、校验，写进库里的副本（repos 表的 flow_* 列）。派活只认副本：后端接活拉起工作流、引擎起会话之前
// 都看它（core 的 replicaVerdict、sessionTestCommand）。
//   - 仓里没有这个文件：用全组织默认，副本标 org_default（驾驶舱要标出来）；项目没写测试命令，写码会话起不来。
//   - 认不出（坏 JSON、格式不对，或全组织默认坏了）：副本里的配置不动，记下原因——这个仓停派，报一条提醒。
//   - 没查成（GitHub 接口出错）：副本不动、不当成「没有这个文件」，只记原因；太久没同步成（core 的
//     FLOW_REPLICA_MAX_AGE_MINUTES）同样停派、报提醒。
import {
  type FlowRead,
  type FlowSync,
  flowSync,
  ORG_DEFAULT_PATH,
  PROJECT_CONFIG_PATH,
  replicaVerdict,
  resolveFlowConfig,
  type Source,
} from '@fleet-dao/core';
import type { FlowReplicaState, FlowReplicaWrite } from '@fleet-dao/db';

export interface FlowConfigJobDeps {
  /** 受管的仓连同副本此刻的样子（@fleet-dao/db 的 listFlowReplicas）。读不出原样抛。 */
  list(): Promise<FlowReplicaState[]>;
  /** 全组织默认（fleet-dao 的 packages/core/flow.default.json，随引擎的代码一起发布）。 */
  orgDefault(): Promise<Source>;
  /**
   * 读一个仓默认分支头上的 .fleet/flow.json，带上读的是哪个提交。GitHub 出错（没权限、5xx、形状认不出）一律抛——记成
   * 没查成；文件在却不是能读的文本（目录、子模块）给 unreadable，按认不出算。
   */
  read(repo: { owner: string; name: string }): Promise<{ commit: string; file: Source }>;
  /** @fleet-dao/db 的 writeFlowReplica。 */
  write(repoId: string, w: FlowReplicaWrite, at: Date): Promise<'ok' | 'not_found'>;
  /** 提醒：同一个键只一条，再报原地更新（@fleet-dao/db 的 upsertAlert）。 */
  alert(key: string, title: string, body: string): Promise<void>;
  /** 事情好了撤掉提醒（resolveAlertByKey）；本来就没有、已经撤了都不算错。 */
  resolve(key: string): Promise<void>;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

export interface FlowRepoOutcome {
  /** owner/name。 */
  repo: string;
  /** gone = 列出来之后这个仓被从库里删了，没写上。 */
  outcome: 'synced' | 'invalid' | 'unread' | 'gone';
  source?: 'project' | 'org_default' | undefined;
  why?: string | undefined;
  /** 这一轮写完之后这个仓停派（认不出，或没查成而副本已经太旧）。 */
  blocked: boolean;
}

export interface FlowSyncResult {
  repos: FlowRepoOutcome[];
}

/** 全组织默认坏了只报这一条（所有项目一起停派），不按仓各报一条。 */
export const ORG_FLOW_ALERT_KEY = 'flow-config:org';
export const flowAlertKey = (repo: { owner: string; name: string }) =>
  `flow-config:${repo.owner}/${repo.name}`.toLowerCase();

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function toWrite(d: FlowSync): FlowReplicaWrite {
  switch (d.write) {
    case 'synced':
      return {
        write: 'synced',
        // 副本存的是合并校验过的整份（core 的 FlowConfig），读的地方按 core 的类型用
        config: d.config as unknown as Record<string, unknown>,
        source: d.source,
        commit: d.commit,
        testCommand: d.testCommand,
      };
    case 'invalid':
      return { write: 'invalid', why: d.why };
    case 'unread':
      return { write: 'unread', why: d.why };
  }
}

/**
 * 同步一轮。列仓读不出原样抛（这一轮记成没跑成）；单个仓读不到、认不出、提醒写不进去都不挡别的仓，照实记在结果里。
 * 写副本失败（库出错）原样抛：没写上就不能装作同步了。
 */
export async function syncFlowConfigs(deps: FlowConfigJobDeps): Promise<FlowSyncResult> {
  const repos = await deps.list();
  let org: Source;
  try {
    org = await deps.orgDefault();
  } catch (err) {
    org = { kind: 'unreadable', error: message(err) };
  }

  const alert = async (key: string, title: string, body: string) => {
    try {
      await deps.alert(key, title, body);
    } catch (err) {
      deps.log('error', '流程配置的提醒没写进去（停派照样生效）', { key, title, error: message(err) });
    }
  };
  const resolve = async (key: string) => {
    try {
      await deps.resolve(key);
    } catch (err) {
      deps.log('warn', '流程配置的提醒没撤掉', { key, error: message(err) });
    }
  };

  const orgCheck = resolveFlowConfig(org, { kind: 'missing' });
  if (orgCheck.ok) await resolve(ORG_FLOW_ALERT_KEY);
  else {
    await alert(
      ORG_FLOW_ALERT_KEY,
      '全组织默认的流程配置认不出：所有项目停派',
      `${orgCheck.why}。全组织默认是 fleet-dao 的 ${ORG_DEFAULT_PATH}，随引擎发布：改好、重新发布后，下一轮对账自动恢复。`,
    );
  }

  const out: FlowRepoOutcome[] = [];
  for (const repo of repos) {
    const slug = `${repo.owner}/${repo.name}`;
    let read: FlowRead;
    try {
      const got = await deps.read(repo);
      read = { kind: 'read', commit: got.commit, file: got.file };
    } catch (err) {
      read = { kind: 'unread', why: message(err) };
    }
    const decided = flowSync(org, read);
    const at = deps.now();
    if ((await deps.write(repo.repoId, toWrite(decided), at)) === 'not_found') {
      out.push({ repo: slug, outcome: 'gone', why: '列出来之后这个仓从库里删了', blocked: false });
      continue;
    }
    const key = flowAlertKey(repo);
    if (decided.write === 'synced') {
      await resolve(key);
      if (decided.source === 'org_default') {
        deps.log('info', `${slug} 没有 ${PROJECT_CONFIG_PATH}，用的全组织默认`, { repo: slug });
      }
      out.push({ repo: slug, outcome: 'synced', source: decided.source, blocked: false });
      continue;
    }
    if (decided.write === 'invalid') {
      // 全组织默认坏了由上面那一条提醒说，不按仓再报
      if (decided.scope === 'project') {
        await alert(key, `${slug} 的流程配置认不出：这个项目停派`, decided.why);
      }
      deps.log('warn', '流程配置认不出，这个项目停派', { repo: slug, why: decided.why });
      out.push({ repo: slug, outcome: 'invalid', why: decided.why, blocked: true });
      continue;
    }
    // 没查成：副本没动。按写完之后的样子判还能不能派；不能派（太久没同步成、从没同步成过）就报提醒
    const after = replicaVerdict(
      {
        syncedAt: repo.syncedAt ? repo.syncedAt.toISOString() : null,
        error: repo.error,
        unread: decided.why,
        testCommand: repo.testCommand,
      },
      at,
    );
    if (!after.ok) await alert(key, `${slug} 停派：流程配置副本不能用（这一轮没查成）`, after.why);
    deps.log('warn', '流程配置没查成，副本没动', { repo: slug, why: decided.why, blocked: !after.ok });
    out.push({ repo: slug, outcome: 'unread', why: decided.why, blocked: !after.ok });
  }
  return { repos: out };
}
