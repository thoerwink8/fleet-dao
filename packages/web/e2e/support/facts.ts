// 备库（packages/api/test/e2e/prepare.ts）打到标准输出最后一行的那份 JSON 的形状。
// 两边是两个包、各自的 tsconfig 不互相引用，所以形状在这里用 zod 再写一遍并在读入时校验：
// 备库改了字段而这里没跟上，读入当场报「认不出」，不会让用例拿着 undefined 往下走。
import { z } from 'zod';

const Ids = z.object({
  running: z.string(),
  done: z.string(),
  stalled: z.string(),
  queued: z.string(),
  failed: z.string(),
  asking: z.string(),
});

export const E2eFactsSchema = z.object({
  dbUrl: z.string(),
  userId: z.string(),
  username: z.string(),
  password: z.string(),
  tasks: Ids,
  issues: z.object({
    running: z.number(),
    done: z.number(),
    stalled: z.number(),
    queued: z.number(),
    failed: z.number(),
    asking: z.number(),
  }),
  askId: z.string(),
  askingAskId: z.string(),
  approvalNotificationId: z.string(),
  alertNotificationId: z.string(),
  pools: z.object({ carpool: z.string(), solo: z.string() }),
});
export type E2eFacts = z.infer<typeof E2eFactsSchema>;

/** 解析备库的输出；认不出就抛，带上哪一项不对。 */
export function parseFacts(text: string): E2eFacts {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`备库的输出认不出（最后一行不是 JSON）：${text.slice(0, 200)}`);
  }
  const r = E2eFactsSchema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new Error(`备库的输出和 e2e 约定的形状对不上（${issue?.path.join('.')}：${issue?.message}）`);
  }
  return r.data;
}
