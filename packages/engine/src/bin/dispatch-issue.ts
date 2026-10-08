// fleet-api dispatch-issue 的本体（#1337；法国上经 packages/api/bin/fleet-api 转过来，换成 fleet 身份、带 api.env 跑）：
//   node packages/engine/src/bin/dispatch-issue.ts <owner/仓名> <单号> [--force --note "<为什么>"]
// 开关关着时点名把一张单交给引擎：先跑一遍拉单的准入，过了起任务工作流，每次写操作记录。逻辑和规矩见 jobs/dispatch-issue.ts。
// 为什么放在引擎包：准入用的交代解析、分档、拉单的装配都在引擎包里，驾驶舱后端不依赖引擎包（引擎一改后端不必重测）。
// 连库用 DATABASE_URL；Temporal 地址、命名空间、任务队列读 TEMPORAL_ADDRESS、TEMPORAL_NAMESPACE、FLEET_TASK_QUEUE（和后端同一份环境）。
// 退出码：0 派了；1 没派或没查成；2 参数不对。

import { createDb } from '@fleet-dao/db';
import { createGitHub } from '@fleet-dao/github';
import { pgLedger, pgLocker } from '@fleet-dao/store';
import { Client, Connection } from '@temporalio/client';
import { runDispatchIssue } from '../jobs/dispatch-issue.ts';
import { dispatchIssueDeps } from '../real/dispatch-issue.ts';
import { configFromEnv } from '../worker.ts';

const env = process.env;

process.exitCode = await runDispatchIssue(process.argv.slice(2), {
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  async open() {
    const config = configFromEnv(env);
    const { db, close } = createDb({ env });
    let connection: Connection | undefined;
    try {
      const gh = createGitHub({ ledger: pgLedger(db), locker: pgLocker(db) });
      connection = await Connection.connect({ address: config.address });
      const client = new Client({ connection, namespace: config.namespace });
      const conn = connection;
      return {
        deps: dispatchIssueDeps({
          db,
          gh,
          client,
          taskQueue: config.taskQueue,
          operator: env.FLEET_OPS_OPERATOR?.trim().slice(0, 64) || '认不出的用户（没经 bin/fleet-api）',
        }),
        async close() {
          await conn.close();
          await close();
        },
      };
    } catch (err) {
      await connection?.close().catch(() => undefined);
      await close().catch(() => undefined);
      throw err;
    }
  },
});
