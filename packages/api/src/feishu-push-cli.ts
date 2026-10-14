// fleet-api feishu-push status | test（决定 0090 的提醒推飞书）：
//   status：后端记下的推送状态（配没配、为什么）、该推还没送到几条、最近一次送到的时刻，和看门狗同一份判法给结论。
//   test：建一条测试提醒（键 feishu:test:<时刻>，推送马上推这一类），等在跑的后端把它推出去（最多 --wait 秒，默认 90），
//   读回送达记录：送到了退出 0，没送到（附上没送成的原因）退出 1。走的是线上那条推送本身，不另起一条发消息的路。
// 测试提醒等结果出来后标成已处理（处理人 ops:feishu-push-test），不在驾驶舱里挂着。
import {
  type Db,
  FEISHU_PUSH_CHANNEL,
  feishuPushFacts,
  feishuPushProblem,
  notificationDeliveries,
  resolveAlertWithReason,
  upsertAlert,
} from '@fleet-dao/db';
import { and, eq } from 'drizzle-orm';

export const FEISHU_PUSH_USAGE =
  '用法：fleet-api feishu-push status（推送状态、该推没送到几条、最近一次送到）| fleet-api feishu-push test [--wait <秒，默认 90>]（建一条测试提醒，等后端推出去，读回送达记录；送到了退出 0）';

export class FeishuPushCliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'FeishuPushCliError';
    this.exitCode = exitCode;
  }
}

export type FeishuPushCommand = { kind: 'status' } | { kind: 'test'; waitSeconds: number };

export function parseFeishuPushArgs(argv: readonly string[]): FeishuPushCommand {
  const [sub, ...rest] = argv;
  if (sub === 'status' && rest.length === 0) return { kind: 'status' };
  if (sub === 'test') {
    let waitSeconds = 90;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--wait') {
        const n = Number(rest[++i]);
        if (!Number.isInteger(n) || n < 1 || n > 600)
          throw new FeishuPushCliError(`--wait 要 1 到 600 的整数秒。${FEISHU_PUSH_USAGE}`);
        waitSeconds = n;
      } else {
        throw new FeishuPushCliError(`认不出参数 ${arg}。${FEISHU_PUSH_USAGE}`);
      }
    }
    return { kind: 'test', waitSeconds };
  }
  throw new FeishuPushCliError(FEISHU_PUSH_USAGE);
}

export async function runFeishuPush(
  cmd: FeishuPushCommand,
  deps: { db: Db; now: () => Date; sleep: (ms: number) => Promise<void>; operator: string },
): Promise<{ code: number; text: string }> {
  if (cmd.kind === 'status') {
    const at = deps.now();
    const f = await feishuPushFacts(deps.db, at);
    const problem = feishuPushProblem(f, at);
    const lines = [
      `推送状态：${f.status ? (f.status.configured ? `配好了（${f.status.at.toISOString()} 记的）` : `没配：${f.status.why ?? '没说为什么'}`) : '后端还没记过（推送没跑过）'}`,
      `该推还没送到：${f.undelivered} 条`,
      `最近一次送到：${f.lastDeliveredAt ? f.lastDeliveredAt.toISOString() : '从没送到过'}`,
      `结论：${problem ?? '通着'}`,
    ];
    return { code: problem ? 1 : 0, text: lines.join('\n') };
  }
  const startedAt = deps.now();
  const dedupeKey = `feishu:test:${startedAt.toISOString()}`;
  const { id } = await upsertAlert(deps.db, {
    dedupeKey,
    level: 'daily',
    taskId: null,
    title: '飞书推送测试',
    body: `这是一条测试推送（${deps.operator} 跑 fleet-api feishu-push test），收到说明驾驶舱的提醒能推到这个群。不用处理。`,
    link: '/notifications',
  });
  const deadline = startedAt.getTime() + cmd.waitSeconds * 1000;
  let row: typeof notificationDeliveries.$inferSelect | undefined;
  for (;;) {
    [row] = await deps.db
      .select()
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.notificationId, id),
          eq(notificationDeliveries.channel, FEISHU_PUSH_CHANNEL),
        ),
      );
    if (row?.deliveredAt || deps.now().getTime() >= deadline) break;
    await deps.sleep(3000);
  }
  const delivered = Boolean(row?.deliveredAt);
  await resolveAlertWithReason(deps.db, {
    dedupeKey,
    by: 'ops:feishu-push-test',
    why: delivered ? '测试推送送到了' : '测试推送没等到送达',
  });
  if (delivered && row?.deliveredAt) {
    return {
      code: 0,
      text: `送到了：提醒 ${id}，${row.deliveredAt.toISOString()} 送到（试了 ${row.attempts} 次，飞书给了 message_id）`,
    };
  }
  const why = row
    ? `试了 ${row.attempts} 次，最近一次没送成：${row.lastError ?? '没记原因'}`
    : '后端一次都没试（推送没在跑，或这台没在正式环境）';
  return { code: 1, text: `${cmd.waitSeconds} 秒内没送到：提醒 ${id}，${why}` };
}
