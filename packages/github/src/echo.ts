// 认回声：自家机器人写了 issue / PR（改进度段、关单、开 PR、合并），GitHub 上它的 updated_at 就变成写入回执里那个值。
// 轮询补收时看不到「是谁改的」（列表里没有 sender），就按这个值认：对得上 = 自家的回声，补收时带上机器人当 sender，
// 后端据此不叫醒工作流（自己不叫醒自己）。记在幂等账里（action=github.echo），跨工人、跨重启都认得。
import type { RepoRef } from './client.ts';
import { repoSlug } from './client.ts';
import type { AppRole } from './credentials.ts';
import type { IdempotencyStore } from './idempotency.ts';

export type EchoKind = 'issue' | 'pull';

/** 同一时刻不同写法（秒 / 毫秒）按同一个认。 */
function instant(updatedAt: string): string {
  const t = Date.parse(updatedAt);
  return Number.isFinite(t) ? new Date(t).toISOString() : updatedAt;
}

export function echoKey(repo: RepoRef, kind: EchoKind, number: number, updatedAt: string): string {
  return `gh:echo:${repoSlug(repo).toLowerCase()}:${kind}#${number}@${instant(updatedAt)}`;
}

/** 记一笔：这个对象的这个版本是自家机器人写出来的。记不上就抛（报明确的失败，别悄悄漏掉）。 */
export async function recordEcho(
  store: IdempotencyStore,
  echo: { repo: RepoRef; kind: EchoKind; number: number; updatedAt: string; role: AppRole },
  now: Date,
): Promise<void> {
  const key = echoKey(echo.repo, echo.kind, echo.number, echo.updatedAt);
  const claim = await store.claim(
    { key, action: 'github.echo', target: `${repoSlug(echo.repo)}#${echo.number}` },
    now,
  );
  if (claim.status === 'claimed') {
    await store.complete(key, { role: echo.role }, now);
  } else if (claim.status === 'in-flight') {
    // 别的工人刚占了同一个键、正要记同样的东西：记成了就行，谁记的都一样
    await store.complete(key, { role: echo.role }, now).catch(() => undefined);
  }
}

/** 这个版本是不是自家机器人写出来的；是就返回哪个机器人。 */
export async function echoOf(
  store: IdempotencyStore,
  repo: RepoRef,
  kind: EchoKind,
  number: number,
  updatedAt: string,
): Promise<AppRole | null> {
  const rec = await store.peek(echoKey(repo, kind, number, updatedAt));
  const role = (rec?.result as { role?: unknown } | null | undefined)?.role;
  return rec?.completedAt && (role === 'agent' || role === 'engine') ? role : null;
}
