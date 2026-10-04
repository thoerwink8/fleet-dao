// 切号账本和锁的真读写（#194，方案 v2 第六节第 13 条）：账本落在 db 的 session_org_state；锁两层——进程内一把（同一个工人里
// 当场触发、探针那一轮、定时读接口那一轮撞上，只一个进去）+ 库里一把带过期（引擎做到一半重启，新进程等锁过期自己放）。
//
// 改这里之前必须知道：
// - 读：库里没有这一行 = 从没切过，给空账本；有但认不出抛 OrgLedgerError（jobs/org-ledger.ts），调用方这一轮不切、推「要人看」，
//   不当成空账本接着切。
// - 锁拿不到就这一轮不判（回 null），不排队等：下一次触发（最多一分钟）会再来，等的话会让探针那一轮卡在切号上。
import { type Db, readOrgState, releaseOrgLock, saveOrgState, takeOrgLock } from '@fleet-dao/db';
import { emptyLedger, type OrgLedger, parseLedger, serializeLedger } from '../jobs/org-ledger.ts';

/** 锁的有效期：切一次号最长约 4 分钟（等收场 2 分钟 + 帮手 270 秒的一部分），再留余量；过了自己放（方案第六节第 13 条：5 分钟）。 */
export const ORG_LOCK_TTL_MS = 5 * 60_000;

/** 读账本：没有这一行 = 从没切过，给空账本；有但认不出抛 OrgLedgerError。库读不了照抛。 */
export async function loadLedger(db: Db, user: string): Promise<OrgLedger> {
  const row = await readOrgState(db, user);
  return row ? parseLedger(row.doc) : emptyLedger();
}

export interface LedgerStore {
  load(): Promise<OrgLedger>;
  save(ledger: OrgLedger): Promise<void>;
  /** 拿到锁就跑 fn、跑完放锁，交回 { ran: true, value }；没拿到交回 { ran: false }（不排队）。fn 抛了也放锁，错误照抛。 */
  withLock<T>(fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false; why: string }>;
}

export function ledgerStore(w: {
  db: Db;
  user: string;
  /** 谁拿的锁：进程内唯一就行（真装配用 machine + pid）。 */
  holder: string;
  now?: () => Date;
}): LedgerStore {
  const clock = w.now ?? (() => new Date());
  let inProcess = false;
  return {
    load: () => loadLedger(w.db, w.user),
    async save(ledger) {
      await saveOrgState(w.db, w.user, serializeLedger(ledger), clock());
    },
    async withLock(fn) {
      if (inProcess) return { ran: false, why: '这个进程里有另一个切号判断在跑' };
      inProcess = true;
      try {
        const got = await takeOrgLock(w.db, w.user, {
          holder: w.holder,
          now: clock(),
          ttlMs: ORG_LOCK_TTL_MS,
          emptyDoc: serializeLedger(emptyLedger()),
        });
        if (!got) return { ran: false, why: '切号的锁在别的进程手里（没过期）' };
        try {
          return { ran: true, value: await fn() };
        } finally {
          await releaseOrgLock(w.db, w.user, w.holder).catch(() => undefined);
        }
      } finally {
        inProcess = false;
      }
    },
  };
}
