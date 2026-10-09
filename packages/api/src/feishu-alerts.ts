// 驾驶舱提醒（#795）：拒收、进群、飞书用量到八成写进 notifications，驾驶舱「提醒」读的就是这张表。
// 同一件事（dedupeKey）一条，再报原地更新并重新打开。内存版直接改 store.data.notifications；库版走 upsertAlert。
import type { Db } from '@fleet-dao/db';
import { upsertAlert } from '@fleet-dao/db';
import type { NotificationRecord } from '@fleet-dao/store';

export interface CockpitAlertInput {
  dedupeKey: string;
  title: string;
  body: string;
}

export interface CockpitAlerts {
  raise(input: CockpitAlertInput): Promise<void>;
}

/** 开发、测试的内存库：推一条，或按 dedupeKey 原地改并重新打开。 */
export function memoryCockpitAlerts(notifications: NotificationRecord[]): CockpitAlerts {
  return {
    async raise(input) {
      const existing = notifications.find((n) => n.dedupeKey === input.dedupeKey);
      if (existing) {
        existing.level = 'alert';
        existing.title = input.title;
        existing.body = input.body;
        existing.resolvedAt = undefined;
        existing.resolvedBy = undefined;
        return;
      }
      notifications.push({
        id: crypto.randomUUID(),
        level: 'alert',
        title: input.title,
        body: input.body,
        createdAt: new Date().toISOString(),
        deliveries: [],
        dedupeKey: input.dedupeKey,
      });
    },
  };
}

/** 正式库：和引擎报警同一张表、同一种「同一件事一条」。 */
export function pgCockpitAlerts(db: Db): CockpitAlerts {
  return {
    async raise(input) {
      await upsertAlert(db, { ...input, level: 'alert', taskId: null });
    },
  };
}
