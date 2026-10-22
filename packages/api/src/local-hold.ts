// 诊断型 / diff 外验收条的单不再被续上（#3602）：人工「继续」、task.redo 在发信号 / 另起一代之前先过判据
// （conventions 的 offDiffHoldOf，和拉单同一份）。命中就不续，改贴「本机做」交回本机并在单上留一句原因。
// 贴标签和留言走引擎机器人的 GitHub；没接上（开发环境、凭据没读到）或写不成，照实写进拒绝原因，不假装已交回。
import {
  implementRoundsDone,
  type OffDiffHold,
  type OffDiffHoldAction,
  offDiffHoldOf,
  type RoundRunFact,
  type TotalRoundsHold,
  type TotalRoundsHoldAction,
  totalRoundsHoldOf,
} from '@fleet-dao/conventions';
import { criteriaOf } from '@fleet-dao/core';
import { MAX_TOTAL_ROUNDS } from '@fleet-dao/shared/continue-exhausted';
import { errMessage } from '@fleet-dao/shared/util';

export interface LocalHoldInput {
  repo: { owner: string; name: string };
  issueNumber: number;
  /** 留言的幂等键。 */
  key: string;
  comment: string;
}

/** 先留言再贴「本机做」。任何一步写不成都抛，由 holdOffDiff 翻成拒绝原因。 */
export type LocalHoldPort = (input: LocalHoldInput) => Promise<void>;

export interface OffDiffRefusal {
  hold: OffDiffHold;
  /** 给人看的完整拒绝原因：为什么不续，以及单子有没有真的交回本机。 */
  why: string;
}

/**
 * 这张单要不要拦住不续。没命中回 null（普通单不受影响，也读不出「怎么算做完」的单不拦：判不了就不挡）。
 * 命中：试着交回本机，结果（成了 / 没接口 / 写失败）都写进 why。
 */
export async function holdOffDiff(
  task: { rawRequest: string },
  target: { repo: { owner: string; name: string }; issueNumber: number },
  action: OffDiffHoldAction,
  port: LocalHoldPort | undefined,
): Promise<OffDiffRefusal | null> {
  const criteria = criteriaOf(task.rawRequest);
  const hold = offDiffHoldOf('ok' in criteria ? criteria.ok : [], action);
  if (hold === null) return null;
  if (port === undefined) {
    return {
      hold,
      why: `${hold.why.replace('已交回本机做', '没续')}；这个入口没接上 GitHub，没贴「本机做」，请手动贴`,
    };
  }
  try {
    await port({ repo: target.repo, issueNumber: target.issueNumber, key: hold.key, comment: hold.comment });
  } catch (error) {
    return {
      hold,
      why: `${hold.why.replace('已交回本机做', '没续')}；可贴「本机做」和留言没写成（${errMessage(error).slice(0, 200)}），请手动贴`,
    };
  }
  return { hold, why: hold.why };
}

export interface TotalRoundsRefusal {
  hold: TotalRoundsHold;
  /** 给人看的完整拒绝原因：为什么不起新一代，以及单子有没有真的交回本机。 */
  why: string;
}

/**
 * 重做另起一代之前看历代累计动手轮数（#3625）：到了上限就不起新一代，交回本机并留言；没到回 null。
 * runs 是这张单历代全部三段流水（store.listSegmentRuns，跨代）；读不到由调用方抛，不在这里当成 0。
 */
export async function holdTotalRounds(
  runs: readonly RoundRunFact[],
  target: { repo: { owner: string; name: string }; issueNumber: number },
  action: TotalRoundsHoldAction,
  port: LocalHoldPort | undefined,
): Promise<TotalRoundsRefusal | null> {
  const hold = totalRoundsHoldOf(implementRoundsDone(runs), action, MAX_TOTAL_ROUNDS);
  if (hold === null) return null;
  if (port === undefined) {
    return {
      hold,
      why: `${hold.why.replace('已交回本机做', '没起')}；这个入口没接上 GitHub，没贴「本机做」，请手动贴`,
    };
  }
  try {
    await port({ repo: target.repo, issueNumber: target.issueNumber, key: hold.key, comment: hold.comment });
  } catch (error) {
    return {
      hold,
      why: `${hold.why.replace('已交回本机做', '没起')}；可贴「本机做」和留言没写成（${errMessage(error).slice(0, 200)}），请手动贴`,
    };
  }
  return { hold, why: hold.why };
}

/** 真实现：引擎机器人的 GitHub（和 historical-audit 同一份安装凭据）。连库只为记幂等账。 */
export async function openLocalHold(url: string): Promise<{ hold: LocalHoldPort; close(): Promise<void> }> {
  const { createDb } = await import('@fleet-dao/db');
  const { pgLedger, pgLocker, withStatementTimeout } = await import('@fleet-dao/store');
  const { createGitHub } = await import('@fleet-dao/github');
  const { LOCAL_LABEL } = await import('@fleet-dao/conventions');
  const { db, close } = createDb({ url: withStatementTimeout(url) });
  try {
    const gh = createGitHub({ ledger: pgLedger(db), locker: pgLocker(db) });
    return {
      hold: async (input) => {
        await gh.commentIssue({
          repo: input.repo,
          issueNumber: input.issueNumber,
          key: input.key,
          body: input.comment,
        });
        await gh.addIssueLabel({ repo: input.repo, issueNumber: input.issueNumber, label: LOCAL_LABEL });
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
