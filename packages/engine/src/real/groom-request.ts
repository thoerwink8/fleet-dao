// 叫一次临时指挥官整理待办（jobs/groom-request.ts）的真装配：读操作记录、读引擎总开关、记「点了」。很轻（只用库），
// 拉单（real/intake.ts）和命令行（bin/groom.ts）都用它，不带上起会话那一大串（real/groom.ts）。

import { randomUUID } from 'node:crypto';
import { type Db, groomAuditRows, readEngineMasterRow, recordGroomRequest } from '@fleet-dao/db';
import { describeEngineMaster, engineMasterOf } from '@fleet-dao/shared';
import type { GroomRequestDeps } from '../jobs/groom-request.ts';

export function groomRequestDeps(db: Db, now: () => Date = () => new Date()): GroomRequestDeps {
  return {
    rows: (since) => groomAuditRows(db, since),
    async engineMaster() {
      const state = engineMasterOf(await readEngineMasterRow(db));
      return state.on ? { on: true } : { on: false, why: describeEngineMaster(state) };
    },
    record: (input) => recordGroomRequest(db, input),
    now,
    newId: randomUUID,
  };
}
