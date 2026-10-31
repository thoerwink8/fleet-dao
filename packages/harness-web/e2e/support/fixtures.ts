import { resolve } from 'node:path';
import { events } from '@fleet-dao/harness-store';
import { type BrowserContext, test as base, expect, type Page } from '@playwright/test';
import { asc, eq } from 'drizzle-orm';
import { type Stack, startStack } from '../../dev/stack.ts';

export { expect };

interface Fixtures {
  /** 每个用例自己一整套：自己的库、自己的接口层、自己的端口。 */
  stack: Stack;
}

interface Options {
  /** SSE 断线补发的上限；调小用来逼出 resync。 */
  replayCap: number | undefined;
  /** false = 不带登录 Cookie（测 401 的登录入口）。 */
  loggedIn: boolean;
}

/** 给浏览器上下文塞一个签好的创始人登录 Cookie（部署形态里这个 Cookie 是旧驾驶舱登录时发的）。 */
export async function login(ctx: BrowserContext, stack: Stack): Promise<void> {
  await ctx.addCookies([{ ...stack.cookie(), url: stack.url }]);
}

export const test = base.extend<Fixtures & Options>({
  replayCap: [undefined, { option: true }],
  loggedIn: [true, { option: true }],
  context: async ({ context, stack, loggedIn }, use) => {
    if (loggedIn) await login(context, stack);
    await use(context);
  },
  stack: async ({ replayCap }, use) => {
    const stack = await startStack({
      distDir: resolve(import.meta.dirname, '../../dist'),
      pollMs: 100,
      heartbeatMs: 2000,
      ...(replayCap !== undefined ? { replayCap } : {}),
    });
    await use(stack);
    await stack.close();
  },
});

/** 往会话连发 n 条进度事件，返回事件号。 */
export async function emitProgress(
  stack: Stack,
  sessionId: string,
  from: number,
  n: number,
): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      await stack.emit(sessionId, 'worker.progress.reported', {
        summary: `进度 ${from + i}`,
        percent: Math.min(100, from + i),
      }),
    );
  }
  return ids;
}

/** 库里这个会话的事件号（真相）。 */
export async function dbIds(stack: Stack, sessionId: string): Promise<number[]> {
  const rows = await stack.db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.streamId, `session:${sessionId}`))
    .orderBy(asc(events.id));
  return rows.map((r) => r.id);
}

/** 页面上渲染出来的事件号（按出现顺序，含重复就会重复）。 */
export async function pageIds(page: Page): Promise<number[]> {
  return page.$$eval('[data-event-id]', (els) => els.map((e) => Number((e as HTMLElement).dataset.eventId)));
}

export const feedStatus = (page: Page) => page.getByTestId('session-stream');

/** 「做完」组默认折叠：要点里面的会话时先点开（已经开着就不动）。 */
export async function expandDone(page: Page): Promise<void> {
  const toggle = page.getByTestId('toggle-done');
  await toggle.waitFor();
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
}
