// 引擎起来时核自己的拼车并发上限和登记的对不对得上（#194 方案 4.7）。
// 登记的数在仓里这台机器的期望（deploy/*/desired-config.json 的 engine.env，FLEET_CARPOOL_MAX_CONCURRENCY，发布时照期望写进
// /etc/fleet-dao/engine.env），各台加起来不超过总上限由配置检查核（deploy/france/auto-release/config.mjs）；引擎实际按库里拼车池的
// max_concurrency 放行（pool-runs.ts 数没结束的拼车会话，满了就不派），这里把两边比一遍。
// 改这里之前必须知道：
// - 数值只在期望里，这里不留默认数：环境变量没写、不是正整数、库里一个拼车池都没有，都是「对不上」，推提醒，不当成「没配就不限」；
// - 对不上不挡引擎接活（并发上限照库里的数管着，不会派超），但不静默：error 日志 + 提醒 carpool-cap:registry，对上了自己撤；
// - 库读不了照常抛给调用方（registerJobs 那一步记错误日志），不当成「对上了」。
import { carpoolPoolCaps, type Db, resolveAlertWithReason, upsertAlert } from '@fleet-dao/db';

/** 这台机器登记的拼车并发上限，发布时写进 engine.env。 */
export const CARPOOL_CAP_ENV = 'FLEET_CARPOOL_MAX_CONCURRENCY';
/** 对不上的提醒（对上了自己撤）。 */
export const CARPOOL_CAP_ALERT = 'carpool-cap:registry';

export type CarpoolCapVerdict =
  | { ok: true; registered: number; poolIds: string[] }
  | { ok: false; code: 'unregistered' | 'bad_value' | 'no_carpool_pool' | 'mismatch'; why: string };

/** 纯判断：登记的原文（环境变量）和库里各拼车池的上限比。 */
export function judgeCarpoolCap(input: {
  raw: string | undefined;
  pools: readonly { poolId: string; maxConcurrency: number }[];
}): CarpoolCapVerdict {
  const raw = input.raw?.trim();
  if (raw === undefined || raw === '') {
    return {
      ok: false,
      code: 'unregistered',
      why: `这台机器的引擎配置里没有 ${CARPOOL_CAP_ENV}（拼车并发上限的登记）：发布时照仓里期望 deploy/*/desired-config.json 的 engine.env 写，没写就是这台没登记，不能当成「不限」`,
    };
  }
  if (!/^[1-9][0-9]{0,5}$/.test(raw)) {
    return {
      ok: false,
      code: 'bad_value',
      why: `${CARPOOL_CAP_ENV} 写的是「${raw}」，不是正整数`,
    };
  }
  const registered = Number(raw);
  if (input.pools.length === 0) {
    return {
      ok: false,
      code: 'no_carpool_pool',
      why: `库里没有带组织类型 carpool 的池（目录配置 catalog.json 没装上、或拼车池没配 orgKind）：登记了拼车并发 ${registered}，但引擎手上没有拼车池可核`,
    };
  }
  const actual = input.pools.reduce((sum, p) => sum + p.maxConcurrency, 0);
  if (actual !== registered) {
    return {
      ok: false,
      code: 'mismatch',
      why: `登记的拼车并发上限是 ${registered}，库里拼车池（${input.pools.map((p) => `${p.poolId} ${p.maxConcurrency}`).join('、')}）加起来是 ${actual}：引擎按库里的数放行，两边对不上。改目录配置 catalog.json 里拼车池的 maxConcurrency 重新装、或改仓里的登记（要同时过「各台加起来不超过总上限」的配置检查）`,
    };
  }
  return { ok: true, registered, poolIds: input.pools.map((p) => p.poolId) };
}

export interface CarpoolCapCheckDeps {
  db: Db;
  env: Readonly<Record<string, string | undefined>>;
  /** 给人看的这台机器名（提醒里写清去哪台修）。 */
  machine: string;
  log?: (level: 'info' | 'error', text: string) => void;
  now?: () => Date;
}

/**
 * 核一遍并按结果推、撤提醒；交回结论。库读不了抛（不推「对上了」）。
 * 提醒写 level alert、taskId null；对上了才撤。
 */
export async function checkCarpoolCap(d: CarpoolCapCheckDeps): Promise<CarpoolCapVerdict> {
  const log = d.log ?? ((level, text) => console[level](text));
  const verdict = judgeCarpoolCap({ raw: d.env[CARPOOL_CAP_ENV], pools: await carpoolPoolCaps(d.db) });
  if (verdict.ok) {
    log('info', `拼车并发上限对得上：登记 ${verdict.registered}，拼车池 ${verdict.poolIds.join('、')}`);
    await resolveAlertWithReason(d.db, {
      dedupeKey: CARPOOL_CAP_ALERT,
      by: 'engine:startup',
      why: `引擎起来核过，拼车并发上限和登记的 ${verdict.registered} 对上了`,
      ...(d.now ? { at: d.now() } : {}),
    });
    return verdict;
  }
  log('error', `拼车并发上限和登记的对不上（${verdict.code}）：${verdict.why}`);
  await upsertAlert(d.db, {
    dedupeKey: CARPOOL_CAP_ALERT,
    level: 'alert',
    taskId: null,
    title: `${d.machine}的拼车并发上限和登记的对不上`,
    body: `${verdict.why}。拼车总并发有上限（各台登记加起来不超过总数，少触发风控、免得一台抢光整窗额度），方案 #194 4.7；改对后重启引擎（或发布一轮）会自己撤。`,
  });
  return verdict;
}
