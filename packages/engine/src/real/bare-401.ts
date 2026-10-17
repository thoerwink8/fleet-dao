// 只凭 HTTP 401 的共享记号：写进设置表，所有任务一起数。同一个池短时间里第二次才暂停整池。
import { type Db, updateBare401Stamp } from '@fleet-dao/db';
import { PortError } from '../ports.ts';
import type { NoteBare401Input, NoteBare401Result } from '../task-contract.ts';
import { nextBare401Stamp } from '../workflows/task-support.ts';

export function createNoteBare401(db: Db) {
  return async (input: NoteBare401Input): Promise<NoteBare401Result> => {
    if (
      input?.schemaVersion !== 1 ||
      typeof input.poolId !== 'string' ||
      input.poolId.length === 0 ||
      typeof input.claim !== 'string' ||
      input.claim.length === 0 ||
      typeof input.now !== 'string' ||
      Number.isNaN(Date.parse(input.now))
    ) {
      throw new PortError('INVALID_INPUT', '记只凭 401：要有池、这一次的身份和时刻', { retryable: false });
    }
    return updateBare401Stamp(db, input.poolId, (existing) =>
      nextBare401Stamp(existing, { now: input.now, claim: input.claim }),
    );
  };
}
