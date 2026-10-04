// 驾驶舱额度页的「拼车额度对账」（#194 方案 4.7）：这一窗本机记到在拼车上花了 $X，接口说用了 $Y；差得多、扣掉没记到花费的会话以后
// 还差得多，写「多半是别的设备在用」。先只显示，不报警。
// 改这里之前必须知道：
// - 窗口从接口说的清零时刻往前推 5 小时（reclaude 拼车成员上限就是 5 小时一窗）；本机花费只算到接口这次读数的时刻为止开始的会话，
//   在跑的会话收场才记花费，所以对账总会略偏小，差额里先扣掉「没记到花费的会话」（按本窗已记会话的平均估）；
// - 没记到花费的会话又没有已记会话可估平均的，说不准就写说不准（unrecorded），不往「别的设备」上猜；
// - 读不到窗口、窗口已过、没接上一律 unavailable 写明原因，不拿「对得上」冒充；
// - 「差得多」的两条线是显示用的经验值（下面两个常量），只影响这一句话怎么写，不触发任何动作。
import {
  type CarpoolApiWindow,
  type CarpoolWindowSpend,
  carpoolApiWindow,
  carpoolWindowSpend,
  type Db,
} from '@fleet-dao/db';
import type { CarpoolReconcileViewSchema } from '@fleet-dao/shared';
import type { z } from 'zod';

export interface CarpoolReconcilePort {
  /** 接口读到的拼车 5 小时窗口 + 窗口里本机记到的花费；一个窗口都没读到过为 null。读不到抛。 */
  read(): Promise<{ api: CarpoolApiWindow; spend: CarpoolWindowSpend } | null>;
}

/** reclaude 拼车成员上限的窗口长度。 */
export const CARPOOL_WINDOW_MS = 5 * 60 * 60_000;
/** 差额（扣掉没记到花费的会话以后）至少这么多美元、且至少占接口已用的这个比例，才写「多半是别的设备在用」。 */
export const RECONCILE_MIN_GAP_USD = 2;
export const RECONCILE_MIN_GAP_RATIO = 0.25;

export function pgCarpoolReconcile(db: Db): CarpoolReconcilePort {
  return {
    read: async () => {
      const api = await carpoolApiWindow(db);
      if (!api) return null;
      // 窗口起点要清零时刻才推得出；没有就让调用方照实写「没给清零时刻」，不去猜起点
      const since = api.resetsAt ? new Date(api.resetsAt.getTime() - CARPOOL_WINDOW_MS) : api.readAt;
      const spend = await carpoolWindowSpend(db, { since, until: api.readAt });
      return { api, spend };
    },
  };
}

export const CARPOOL_RECONCILE_NOT_HERE =
  '拼车额度对账没接上：这里是开发环境的内存版，没有会话和额度读数那几张表，真库上才有';

type View = z.input<typeof CarpoolReconcileViewSchema>;

const usd = (n: number) => `$${n.toFixed(2)}`;

export function carpoolReconcileView(
  raw: { api: CarpoolApiWindow; spend: CarpoolWindowSpend } | null,
  now: Date,
): View {
  if (!raw) {
    return {
      state: 'unavailable',
      why: '还没读到过拼车的 5 小时美元窗口（接口没读成、或还没配拼车池的读法），没法对账',
    };
  }
  const { api, spend } = raw;
  if (api.used === null || api.limit === null || !(api.limit > 0)) {
    return { state: 'unavailable', why: '接口这次读数里没有已用美元或上限，没法对账' };
  }
  if (!api.resetsAt) {
    return { state: 'unavailable', why: '接口没给清零时刻，推不出这一窗从几点开始，没法对账' };
  }
  if (api.resetsAt.getTime() <= now.getTime()) {
    return {
      state: 'unavailable',
      why: '最近一次读数的窗口已经过了清零时刻，等下一次读到新窗口再对',
    };
  }
  const gap = api.used - spend.recordedUsd;
  const avg = spend.recorded > 0 ? spend.recordedUsd / spend.recorded : null;
  const allowance = avg === null ? null : spend.unrecorded * avg;
  const base = {
    state: 'known' as const,
    windowStart: new Date(api.resetsAt.getTime() - CARPOOL_WINDOW_MS).toISOString(),
    windowEnd: api.resetsAt.toISOString(),
    apiReadAt: api.readAt.toISOString(),
    localUsd: spend.recordedUsd,
    apiUsedUsd: api.used,
    apiLimitUsd: api.limit,
    sessions: spend.sessions,
    unrecorded: spend.unrecorded,
    unrecordedSwitchStopped: spend.unrecordedSwitchStopped,
    gapUsd: gap,
  };
  const head = `这一窗本机记到在拼车上花了 ${usd(spend.recordedUsd)}，接口说用了 ${usd(api.used)}`;
  const unrecordedWords =
    spend.unrecorded > 0
      ? `；有 ${spend.unrecorded} 个会话没记到花费${spend.unrecordedSwitchStopped > 0 ? `（其中 ${spend.unrecordedSwitchStopped} 个是切号停下的）` : ''}`
      : '';
  const line = (gapUsd: number) => Math.max(RECONCILE_MIN_GAP_USD, RECONCILE_MIN_GAP_RATIO * gapUsd);
  if (allowance === null && spend.unrecorded > 0) {
    return {
      ...base,
      verdict: 'unrecorded',
      note: `${head}${unrecordedWords}，本窗没有记到花费的会话可以估一个平均，差 ${usd(gap)} 说不准是不是别的设备在用`,
    };
  }
  const residual = gap - (allowance ?? 0);
  const allowanceWords =
    allowance !== null && spend.unrecorded > 0
      ? `，扣掉没记到花费的会话（按本窗已记会话的平均估 ${usd(allowance)}）还差 ${usd(residual)}`
      : '';
  if (residual >= line(api.used)) {
    return {
      ...base,
      verdict: 'others',
      note: `${head}${unrecordedWords}，差 ${usd(gap)}${allowanceWords}，多半是别的设备在用`,
    };
  }
  if (-residual >= line(spend.recordedUsd)) {
    return {
      ...base,
      verdict: 'local_over',
      note: `${head}${unrecordedWords}：本机记的比接口说的还多 ${usd(-residual)}，多半是接口读数比本机记账旧，下一次读到新数再看`,
    };
  }
  return {
    ...base,
    verdict: 'match',
    note: `${head}${unrecordedWords}，差 ${usd(gap)}${allowanceWords}，在误差内`,
  };
}
