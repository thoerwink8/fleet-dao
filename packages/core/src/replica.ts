// 库里的流程配置副本（docs/decisions/0003-fusion-flow.md 第 9 条：流程配置以仓里的 .fleet/flow.json 为准，库里 repos 表的
// flow_* 列只是副本）：对账读完仓里的文件往副本里写什么、派活前副本能不能用、写码会话拿哪条测试命令。
// 读仓、写库是外壳的事——引擎的对账（packages/engine/src/jobs/flow-config.ts）写；后端接活（packages/api/src/issue-intake.ts）、
// 引擎起会话（packages/engine/src/real/flow-gate.ts）读。这里只判。
import type { StageKind } from '@fleet-dao/shared';
import { type FlowConfig, PROJECT_CONFIG_PATH, resolveFlowConfig, type Source } from './config.ts';

/** 写码类的阶段：交活核对要这次会话跑过测试命令的证据（packages/api/src/done-check.ts），没有测试命令就不起。 */
export const CODE_STAGES: ReadonlySet<StageKind> = new Set<StageKind>(['execute', 'ui']);

/**
 * 副本多久没同步成就停派（分钟）。对账每 15 分钟一轮：连着两轮没读成（GitHub 抖一下、引擎重启）照样派，第三轮还没读成
 * 就停——和定时任务页、看门狗判对账「过期」是同一条线（引擎 jobs/github-reconcile.ts 的 expectEveryMinutes），那边报
 * 对账停了，这边也不再拿没核实过的配置派活。
 */
export const FLOW_REPLICA_MAX_AGE_MINUTES = 45;

export interface FlowReplica {
  /** 最近一次读成、认得出的时刻（ISO）。从没同步成过是 null。 */
  syncedAt: string | null;
  /** 仓里的配置认不出（或全组织默认坏了）的原因：非空就这个项目停派，直到改好、对账读成。 */
  error: string | null;
  /** 最近一次去读却没查成的原因（GitHub 接口出错）：副本没动，只用来写清为什么过期。 */
  unread: string | null;
  /** 合并后配置里的测试命令；项目没写是 null。 */
  testCommand: string | null;
}

/** 加上副本这几列之后、对账第一次读成之前的样子：按「还没同步过」停派。 */
export const UNSYNCED_REPLICA: FlowReplica = { syncedAt: null, error: null, unread: null, testCommand: null };

export type ReplicaVerdict = { ok: true } | { ok: false; why: string };

/** 派活前（接活拉起工作流、起会话）看副本：认不出、从没同步过、同步时刻认不出、太久没同步成，都停派并写明原因。 */
export function replicaVerdict(replica: FlowReplica, now: Date): ReplicaVerdict {
  const lastUnread = replica.unread ? `；最近一次没查成：${replica.unread}` : '';
  if (replica.error) {
    return {
      ok: false,
      why: `流程配置认不出：${replica.error}。改好仓里的 ${PROJECT_CONFIG_PATH}，合进主线、对账读成后自动恢复`,
    };
  }
  if (replica.syncedAt === null) {
    return {
      ok: false,
      why: `还没从仓里同步过流程配置（${PROJECT_CONFIG_PATH}），等对账读成一次${lastUnread}`,
    };
  }
  const at = Date.parse(replica.syncedAt);
  if (!Number.isFinite(at)) return { ok: false, why: `流程配置副本的同步时刻认不出（${replica.syncedAt}）` };
  // 同步时刻在将来（两边的钟差一点）当成刚同步过：不为钟差停派
  const ageMs = now.getTime() - at;
  if (ageMs > FLOW_REPLICA_MAX_AGE_MINUTES * 60_000) {
    return {
      ok: false,
      why: `流程配置副本 ${Math.floor(ageMs / 60_000)} 分钟没同步成（超过 ${FLOW_REPLICA_MAX_AGE_MINUTES} 分钟就停派，不拿没核实过的配置派活）${lastUnread}`,
    };
  }
  return { ok: true };
}

export type SessionTestCommand = { ok: true; command: string | null } | { ok: false; why: string };

/**
 * 起会话前：副本要能用；写码阶段还要有测试命令（交活只认会话里原样跑过它）。项目没写就明确失败，不拿空串、旧值或
 * 全组织默认顶。别的阶段没有测试命令照样起（提示词里不提跑测试）。
 */
export function sessionTestCommand(replica: FlowReplica, stage: StageKind, now: Date): SessionTestCommand {
  const verdict = replicaVerdict(replica, now);
  if (!verdict.ok) return verdict;
  const command = replica.testCommand?.trim() || null;
  if (command === null && CODE_STAGES.has(stage)) {
    return {
      ok: false,
      why: `项目没写测试命令：写码会话交活要原样跑它，没有就不起。在仓里 ${PROJECT_CONFIG_PATH} 写上 testCommand（只跑改动影响到的测试的那条），合进主线、对账同步进库后点「继续」`,
    };
  }
  return { ok: true, command };
}

/** 对账去读仓里配置文件的结果：读到了（读的是默认分支哪个提交、文件在不在），或没查成（GitHub 接口出错）。 */
export type FlowRead = { kind: 'read'; commit: string; file: Source } | { kind: 'unread'; why: string };

export type FlowSync =
  /** 读成、认得出：副本整份换成这份（测试命令跟着变）。source 标出仓里有没有自己的文件（没有就是全组织默认）。 */
  | {
      write: 'synced';
      config: FlowConfig;
      source: 'project' | 'org_default';
      commit: string;
      testCommand: string | null;
    }
  /** 认不出（全组织默认坏了是 org）：副本里的配置不动，记下原因，这个项目停派、报提醒。 */
  | { write: 'invalid'; scope: 'org' | 'project'; why: string }
  /** 没查成：副本一样不动（不当成「没有这个文件」），只记下原因；太久没同步成由 replicaVerdict 停派。 */
  | { write: 'unread'; why: string };

/** 对账读完一个仓之后往副本里写什么。 */
export function flowSync(org: Source, read: FlowRead): FlowSync {
  // 全组织默认坏了先说：仓里读没读成都一样停派（没有默认可合，也不拿旧的顶）
  const orgOnly = resolveFlowConfig(org, { kind: 'missing' });
  if (!orgOnly.ok) return { write: 'invalid', scope: 'org', why: orgOnly.why };
  if (read.kind === 'unread') return { write: 'unread', why: read.why.trim() || '没带原因' };
  const decided = resolveFlowConfig(org, read.file);
  if (!decided.ok) {
    return {
      write: 'invalid',
      scope: decided.scope,
      why: `${decided.why}（提交 ${read.commit.slice(0, 7)}）`,
    };
  }
  return {
    write: 'synced',
    config: decided.config,
    source: decided.usedOrgDefault ? 'org_default' : 'project',
    commit: read.commit,
    testCommand: decided.config.testCommand ?? null,
  };
}
