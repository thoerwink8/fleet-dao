// fleet-api usage-backfill-once 的本体（#1948；法国上经 packages/api/bin/fleet-api 转过来，换成 fleet 身份、带 api.env 跑）：
//   node packages/engine/src/bin/usage-backfill-once.ts [--apply]
// #1946 之前没有会话号的老 run，按分支名和起止对上 Mirasim 用量账本，只补空字段。默认只读。
// 退出码：0 查完了；1 没查成（没写）；2 参数不对（不连库）。

import {
  createDb,
  type Db,
  fillHistoricalRunUsage,
  noteHistoricalRunUsage,
  runsAwaitingHistoricalMeter,
} from '@fleet-dao/db';
import { runUsageBackfillOnce } from '../jobs/usage-backfill-once.ts';
import { historicalLedgerReader } from '../real/usage-backfill-once.ts';

const env = process.env;
let opened: { db: Db; close(): Promise<void> } | undefined;

try {
  const readLedger = historicalLedgerReader(env);
  process.exitCode = await runUsageBackfillOnce(process.argv.slice(2), {
    out: (text) => console.log(text),
    err: (text) => console.error(text),
    now: () => new Date(),
    async pending() {
      opened ??= createDb({ env });
      return runsAwaitingHistoricalMeter(opened.db);
    },
    readLedger,
    async fill(runId, usage, at) {
      if (!opened) throw new Error('还没连库');
      return fillHistoricalRunUsage(opened.db, { runId, usage, at });
    },
    async note(runId, note, at) {
      if (!opened) throw new Error('还没连库');
      return noteHistoricalRunUsage(opened.db, { runId, note, at });
    },
  });
} finally {
  await opened?.close();
}
