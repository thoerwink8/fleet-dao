// 全程模式开关（#2823）在后端这一头的读写：设置表 'engine.flowMode'（值的写法和读法在 @fleet-dao/shared 的 flow-mode.ts）。
// 读：listSettings 里找那一行，没设过按 three、认不出也按 three 但把原因带出来（readFlowModeSetting），不悄悄吞。
// 写：putSetting（同一事务记操作记录、带版本防两人同时改）。已经是这个值（且是人写过的、认得出的值）就不改不记；
// 库里是认不出的值，写 three 也照写（不拿「认不出」当「已经是 three」）。
// 本文件的读写给命令行 fleet-api flow-mode 用。引擎另从设置表读同一行（decideFlowMode，#2826）：没贴标签的单按它分组，
// 结果进历史，之后改开关不影响已经分过组的单。

import {
  FLOW_MODE_SET,
  FLOW_MODE_SETTING,
  type FlowModeReading,
  flowModeLabel,
  formatFlowModeSetting,
  readFlowModeSetting,
} from '@fleet-dao/shared';
import type { Actor, NewAuditEntry, Store } from './ports.ts';

/** 读开关此刻的状态；设置表读不到照抛（调用方自己包一层「没查成」）。 */
export async function readFlowMode(store: Store): Promise<FlowModeReading> {
  const rows = await store.listSettings();
  return readFlowModeSetting(rows.find((s) => s.key === FLOW_MODE_SETTING)?.value);
}

export type FlowModeChange =
  | { changed: true; reading: FlowModeReading }
  | { changed: false; reading: FlowModeReading }
  | { changed: false; conflict: true; reading: FlowModeReading };

/** 给人看的一句：现在是哪种、是不是默认、认不出时原因。 */
export function describeFlowMode(reading: FlowModeReading): string {
  const label = flowModeLabel(reading.setting);
  if (reading.state === 'never_set') return `${label}（从没设过，默认三步单）`;
  if (reading.state === 'unrecognized') return `${label}（${reading.problem}）`;
  return label;
}

/** 改开关（value 已经过 parseFlowModeSetting 认过）。before/after 是设置里存的字符串；已经是这个值不改不记。 */
export async function setFlowMode(
  store: Store,
  input: { value: string; by: Actor },
  audit: Omit<NewAuditEntry, 'action' | 'target' | 'before' | 'after'>,
): Promise<FlowModeChange> {
  const rows = await store.listSettings();
  const row = rows.find((s) => s.key === FLOW_MODE_SETTING);
  const before = readFlowModeSetting(row?.value);
  if (before.state === 'set' && formatFlowModeSetting(before.setting) === input.value)
    return { changed: false, reading: before };
  const result = await store.putSetting(
    { key: FLOW_MODE_SETTING, value: input.value, expectedVersion: row?.version ?? 0, by: input.by },
    {
      ...audit,
      actor: input.by,
      action: FLOW_MODE_SET,
      target: `setting:${FLOW_MODE_SETTING}`,
      before: row?.value ?? null,
      after: input.value,
    },
  );
  const after = await readFlowMode(store);
  if (result === 'conflict') return { changed: false, conflict: true, reading: after };
  return { changed: true, reading: after };
}
