// 同一个成功水位只选一次窗口。窗口先落幂等账再扫描，fallback/cap 在重启或后续 partial 时都不移动。
// 不从旧 schedule_runs 猜测历史 since，也不把该回执当成扫描锁；重投与 pending 继续由 reconciler 处理。
import { type IdempotencyStore, once } from '@fleet-dao/github';
import { z } from 'zod';

const WindowReceipt = z.object({
  version: z.literal(1),
  identity: z.string(),
  since: z.iso.datetime(),
  capped: z.boolean(),
});

export async function retainGitHubReconcileWindow(
  ledger: IdempotencyStore,
  input: { lastSuccessAt: Date | null; since: Date; capped: boolean },
  now: () => Date,
): Promise<{ since: Date; capped: boolean }> {
  const identity = input.lastSuccessAt?.toISOString() ?? 'initial';
  const receipt = { version: 1, identity, since: input.since.toISOString(), capped: input.capped };
  const { value } = await once<unknown>(ledger, {
    key: `gh:github-reconcile-window:v1:${identity}`,
    action: 'github.reconcile_window',
    target: identity,
    now,
    lookup: async () => null,
    write: async () => receipt,
  });
  const parsed = WindowReceipt.safeParse(value);
  if (!parsed.success || parsed.data.identity !== identity)
    throw new Error('GitHub 对账窗口回执形状或成功身份不匹配，不能重新选择回看下限');
  if (Date.parse(parsed.data.since) <= 0 || Date.parse(parsed.data.since) > now().getTime())
    throw new Error('GitHub 对账窗口回执时刻不能用，不能重新选择回看下限');
  return { since: new Date(parsed.data.since), capped: parsed.data.capped };
}
