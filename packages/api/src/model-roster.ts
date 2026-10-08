// 驾驶舱路由页上的渠道模型差集（#1302）。只读库里已经记下的名册，不在请求里现连渠道。
// 没接上由接口写 modelRosterUnavailable，不拿空差集冒充「都对得上」。
// 没有名册命令的渠道（#1357）在这里登记、撤销：写入和操作记录是同一笔事务。
import {
  channelModelDiff,
  type Db,
  type ManualModelInput,
  type ManualModelView,
  registerManualModel,
  revokeManualModel,
} from '@fleet-dao/db';
import type { ModelRosterDiffSchema } from '@fleet-dao/shared';
import type { z } from 'zod';

export interface ModelRosterPort {
  read(): Promise<z.input<typeof ModelRosterDiffSchema>>;
  /** 没接上时接口 503。老的测试只实现 read。 */
  register?(input: ManualModelInput): Promise<ManualModelView>;
  revoke?(input: ManualModelInput): Promise<ManualModelView>;
}

export function pgModelRoster(db: Db): ModelRosterPort {
  return {
    read: () => channelModelDiff(db),
    register: (input) => registerManualModel(db, input),
    revoke: (input) => revokeManualModel(db, input),
  };
}

/** 开发环境、内存版没装这个口子。 */
export const MODEL_ROSTER_NOT_HERE = '渠道模型表没接上：这里读不到各渠道现在认的模型，不能当成都对得上';

/** 两层读成之后附上差集。抛了也不让路由页 503：差集没读到和两层没读成是两回事。 */
export async function modelRosterFields(
  port: ModelRosterPort | undefined,
  onError: (err: unknown) => void,
): Promise<{ modelRoster: z.input<typeof ModelRosterDiffSchema> } | { modelRosterUnavailable: string }> {
  if (!port) return { modelRosterUnavailable: MODEL_ROSTER_NOT_HERE };
  try {
    return { modelRoster: await port.read() };
  } catch (err) {
    onError(err);
    const cause = (err instanceof Error && err.message) || String(err);
    return { modelRosterUnavailable: `渠道模型表没读成：${cause}` };
  }
}
