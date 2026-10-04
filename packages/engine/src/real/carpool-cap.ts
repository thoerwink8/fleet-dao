// 引擎起来时核自己的拼车并发上限和登记的对不对得上（#194 方案 4.7）。
// 登记的数在仓里这台机器的期望（deploy/*/desired-config.json 的 engine.env，FLEET_CARPOOL_MAX_CONCURRENCY，发布时照期望写进
// /etc/fleet-dao/engine.env），各台加起来不超过总上限由配置检查核（deploy/france/auto-release/config.mjs）；引擎实际按库里拼车池的
// max_concurrency 放行（pool-runs.ts 数没结束的拼车会话，满了就不派），这里把两边比一遍。
// 改这里之前必须知道：
// - 数值只在期望里，这里不留默认数：环境变量没写、不是正整数、库里一个拼车池都没有，都是「对不上」，推提醒，不当成「没配就不限」；
// - 对不上不挡引擎接活，但拼车池不再派新活（#896，方案第六节第 19 条「拼车不派、推提醒」）：选路每次经 carpoolRegistry().view() 现核
//   一遍，对不上、没登记、写坏了、库里没有拼车池、核对本身没读成都交回 ok:false，routing/filter.ts 把带拼车组织类型的池硬挡掉
//   （驾驶舱路由页读同一条提醒显示原因）；对上了自己恢复、提醒自己撤。不拿「提醒开着没」当开关：人点掉提醒不该放开拼车；
// - 引擎起来那一下（registerJobs）仍调 checkCarpoolCap：库读不了照常抛给调用方（记错误日志），不当成「对上了」；
//   选路那条路读不了不抛（别的池照派），拼车池按「核对没读成」不派。
import {
  CARPOOL_CAP_ALERT,
  carpoolPoolCaps,
  type Db,
  resolveAlertWithReason,
  upsertAlert,
} from '@fleet-dao/db';
import type { CarpoolRegistryView } from '../routing/types.ts';

export { CARPOOL_CAP_ALERT };

/** 这台机器登记的拼车并发上限，发布时写进 engine.env。 */
export const CARPOOL_CAP_ENV = 'FLEET_CARPOOL_MAX_CONCURRENCY';

export type CarpoolCapVerdict =
  | { ok: true; registered: number; poolIds: string[] }
  | {
      ok: false;
      code: 'unregistered' | 'bad_value' | 'no_carpool_pool' | 'mismatch' | 'unreadable';
      why: string;
    };

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

const logOf = (d: CarpoolCapCheckDeps) => d.log ?? ((level, text) => console[level](text));

/** 现读库里的拼车池、拿登记的原文核一遍，不碰提醒。库读不了抛。 */
async function judgeNow(d: CarpoolCapCheckDeps): Promise<CarpoolCapVerdict> {
  return judgeCarpoolCap({ raw: d.env[CARPOOL_CAP_ENV], pools: await carpoolPoolCaps(d.db) });
}

/** 按结论推、撤提醒（level alert、taskId null；对上了才撤）。by：谁撤的（引擎起来、选路现核到的）。 */
async function syncAlert(d: CarpoolCapCheckDeps, verdict: CarpoolCapVerdict, by: string): Promise<void> {
  if (verdict.ok) {
    await resolveAlertWithReason(d.db, {
      dedupeKey: CARPOOL_CAP_ALERT,
      by,
      why: `${by === 'engine:startup' ? '引擎起来核过' : '选路现核'}，拼车并发上限和登记的 ${verdict.registered} 对上了`,
      ...(d.now ? { at: d.now() } : {}),
    });
    return;
  }
  await upsertAlert(d.db, {
    dedupeKey: CARPOOL_CAP_ALERT,
    level: 'alert',
    taskId: null,
    title: `${d.machine}的拼车并发上限和登记的对不上`,
    body: `${verdict.why}。拼车并发核对不上期间引擎不往拼车池派新活（独享、别家的池照派）；拼车总并发有上限（各台登记加起来不超过总数，少触发风控、免得一台抢光整窗额度），方案 #194 4.7、第 19 条；改对后重启引擎（或发布一轮）会自己撤、拼车恢复。`,
  });
}

/**
 * 核一遍并按结果推、撤提醒；交回结论。库读不了抛（不推「对上了」）。引擎起来那一下用它。
 */
export async function checkCarpoolCap(d: CarpoolCapCheckDeps): Promise<CarpoolCapVerdict> {
  const log = logOf(d);
  const verdict = await judgeNow(d);
  if (verdict.ok) {
    log('info', `拼车并发上限对得上：登记 ${verdict.registered}，拼车池 ${verdict.poolIds.join('、')}`);
  } else {
    log('error', `拼车并发上限和登记的对不上（${verdict.code}）：${verdict.why}`);
  }
  await syncAlert(d, verdict, 'engine:startup');
  return verdict;
}

export interface CarpoolRegistry {
  /** 引擎起来那一下核（registerJobs）：核 + 推、撤提醒，库读不了抛。 */
  check(): Promise<CarpoolCapVerdict>;
  /**
   * 选路前现核（每次 pickRoute、每小时对账判阶段派不派得出去都问）：登记的数只在环境变量里（重启才变），库里拼车池的上限现读，
   * 所以目录配置重装之后下一次选路就跟着恢复或收紧，不等重启。核不了（读库失败）也交回 ok:false 写明原因，不抛——别的池照派，
   * 只是拼车池按「核对没读成」不派，不当成对上了。结论变了（对上 ↔ 对不上）顺手推、撤提醒，推不了只记日志。
   */
  view(): Promise<CarpoolRegistryView>;
}

export function carpoolRegistry(d: CarpoolCapCheckDeps): CarpoolRegistry {
  const log = logOf(d);
  /** 上一次现核的结论是不是对上；还没核过 undefined。 */
  let lastOk: boolean | undefined;
  return {
    async check() {
      const verdict = await checkCarpoolCap(d);
      lastOk = verdict.ok;
      return verdict;
    },
    async view() {
      let verdict: CarpoolCapVerdict;
      try {
        verdict = await judgeNow(d);
      } catch (error) {
        verdict = {
          ok: false,
          code: 'unreadable',
          why: `拼车并发登记没核成，读不到库里的拼车池：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (lastOk !== verdict.ok) {
        lastOk = verdict.ok;
        if (verdict.ok) log('info', `拼车并发上限对得上了：登记 ${verdict.registered}，拼车恢复派活`);
        else log('error', `拼车并发上限和登记的对不上（${verdict.code}），拼车池不派新活：${verdict.why}`);
        try {
          await syncAlert(d, verdict, 'engine:pick-route');
        } catch (error) {
          log('error', `拼车并发登记的提醒没推、撤成（下一次结论变了再试）：${String(error)}`);
          lastOk = undefined;
        }
      }
      return verdict.ok ? { ok: true } : { ok: false, why: verdict.why };
    },
  };
}
