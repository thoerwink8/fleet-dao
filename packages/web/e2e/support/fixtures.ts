// e2e 用例共用的几样：整套环境的地址和编号、登录、截图、页面错误收集、直连后端读写。
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, test as base, expect, type Page } from '@playwright/test';
import { STACK_FILE } from './global-setup.ts';
import { type StackEnv, startStack } from './stack.ts';

const SHOT_DIR = join(import.meta.dirname, '..', '..', '..', '..', '_tmp', 'e2e');

/** E2E_REUSE=1：读 e2e:serve 写下的那一套（support/serve.ts），不自己起。 */
function reusedStack(): StackEnv {
  try {
    return JSON.parse(readFileSync(STACK_FILE, 'utf8')) as StackEnv;
  } catch (err) {
    throw new Error(`E2E_REUSE=1 但读不到 ${STACK_FILE}（先在另一个终端跑 pnpm e2e:serve）：${String(err)}`);
  }
}

/** 浏览器里出现的、不该有的东西：控制台错误、没捕获的异常、失败的请求、4xx/5xx 响应。 */
export interface PageProblems {
  list: string[];
  /** 这条用例有意造出来的错误（比如后端断开）：按子串放过，其余照报。 */
  allow: (substring: string) => void;
}

export const test = base.extend<
  {
    /** 用账密真登录一次（POST /auth/password/login），会话 Cookie 落在这个浏览器上下文里。 */
    login: () => Promise<void>;
    /** 本页的截图：存 _tmp/e2e/<视口>/<名字>.png（视口 = 项目名里的分辨率）。 */
    shot: (page: Page, name: string) => Promise<void>;
    problems: PageProblems;
    /** 直连后端（经前端同源），带登录 Cookie 和写请求要的来源头、CSRF 令牌。 */
    api: {
      get: (path: string) => Promise<unknown>;
      send: (
        method: 'PUT' | 'POST',
        path: string,
        body: unknown,
      ) => Promise<{ status: number; json: unknown }>;
    };
  },
  {
    /**
     * 这个 worker 自己的一整套（决定 0093）：库 fleet_e2e_w<worker 号>、现分的端口，worker 起来时起、收工时收。
     * Playwright 换项目（视口）、用例红了都会换新 worker，新 worker 起新的一套、重建库：1366 那一遍只读，看到的是刚备好的库；
     * 同一个 worker 里按文件名顺序走，后面的文件看得到前面文件（同一 worker 分到的那些）的写入，和原来单 worker 时一样只会更少。
     */
    stack: StackEnv;
  }
>({
  stack: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright 夹具的第一个参数必须是解构写法
    async ({}, use, workerInfo) => {
      if (process.env.E2E_REUSE === '1') {
        await use(reusedStack());
        return;
      }
      // 库名、日志都按 worker 号（这一轮里每个 worker 进程一个号，不重用）：两套永远不碰同一个库，换了 worker 也不盖掉前一个红了的日志
      const n = workerInfo.workerIndex;
      const stack = await startStack({ dbName: `fleet_e2e_w${n}`, slot: n, tag: `w${n}` });
      try {
        await use(stack.env);
      } finally {
        stack.stop();
      }
    },
    { scope: 'worker', timeout: 120_000 },
  ],
  // 浏览器的 baseURL 是这个 worker 那一套的门面（端口现分）
  baseURL: async ({ stack }, use) => use(stack.webOrigin),
  login: async ({ context, stack }, use) => {
    await use(async () => {
      const res = await context.request.post(`${stack.webOrigin}/auth/password/login`, {
        headers: { origin: stack.webOrigin },
        data: { username: stack.facts.username, password: stack.facts.password },
      });
      expect(res.status(), '账密登录').toBe(204);
    });
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright 夹具的第一个参数必须是解构写法
  shot: async ({}, use, testInfo) => {
    await use(async (page, name) => {
      const size = page.viewportSize();
      const dir = join(SHOT_DIR, size ? `${size.width}x${size.height}` : testInfo.project.name);
      mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: join(dir, `${name}.png`) });
    });
  },
  problems: [
    async ({ page }, use) => {
      const allowed: string[] = [];
      const list: string[] = [];
      const note = (text: string) => {
        if (!allowed.some((a) => text.includes(a))) list.push(text);
      };
      page.on('console', (m) => {
        if (m.type() === 'error') note(`console.error：${m.text()}（${m.location().url}）`);
      });
      page.on('pageerror', (e) => note(`未捕获异常：${e.message}`));
      page.on('requestfailed', (r) =>
        note(`请求失败：${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`),
      );
      page.on('response', (r) => {
        if (r.status() >= 400) note(`HTTP ${r.status()}：${r.request().method()} ${r.url()}`);
      });
      const problems: PageProblems = { list, allow: (s) => void allowed.push(s) };
      await use(problems);
      expect(problems.list, '页面上不该出现控制台错误、异常、失败的请求').toEqual([]);
    },
    { auto: true },
  ],
  api: async ({ context, stack }, use) => {
    const req: APIRequestContext = context.request;
    let csrf: string | undefined;
    const token = async () => {
      if (csrf) return csrf;
      const me = (await (await req.get(`${stack.webOrigin}/api/me`)).json()) as { csrfToken: string };
      csrf = me.csrfToken;
      return csrf;
    };
    await use({
      get: async (path) => {
        const res = await req.get(`${stack.webOrigin}${path}`);
        const text = await res.text();
        expect(res.status(), `GET ${path}：${text.slice(0, 500)}`).toBe(200);
        return JSON.parse(text);
      },
      send: async (method, path, body) => {
        const res = await req.fetch(`${stack.webOrigin}${path}`, {
          method,
          headers: { origin: stack.webOrigin, 'x-csrf-token': await token() },
          data: body,
        });
        const text = await res.text();
        return { status: res.status(), json: text ? JSON.parse(text) : null };
      },
    });
  },
});

export { expect };

/** 1920 那一遍才跑的用例（改库的）：1366 那一遍只读，跳过。 */
export function onlyDesktop(info: { project: { name: string } }): boolean {
  return info.project.name.endsWith('1920');
}
