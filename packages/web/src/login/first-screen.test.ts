// 登录入口必须在第一屏（#54 创始人意见：手机上要划到第二屏才能登录）：
// 用假数据模式打一份包，真浏览器开登录页的每一版，量「用飞书登录」「用户名密码」两个按钮的底边，
// 手机 390×844、电脑 1440×900 下都得小于视口高度，也不许横向滚动。
// 浏览器用本机装的 Chrome（GitHub 的 ubuntu 机器自带），不另外下载；没有 Chrome 这条就红，不跳过。
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VARIANTS = ['a', 'b', 'c'] as const;
const VIEWPORTS = [
  { name: '手机', width: 390, height: 844 },
  { name: '电脑', width: 1440, height: 900 },
] as const;

let out: string;
let server: Server;
let base: string;
let browser: Browser;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

beforeAll(async () => {
  // 输出目录要在包里面：放到包外面时 react-router 预渲染外壳会 500（它从输出目录加载服务端那份）。dist/ 不进仓。
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  out = mkdtempSync(join(pkg, 'dist', 'first-screen-'));
  const cli = join(
    dirname(createRequire(import.meta.url).resolve('@react-router/dev/package.json')),
    'bin.cjs',
  );
  const built = spawnSync(process.execPath, [cli, 'build', '--mode', 'mock'], {
    cwd: pkg,
    env: { ...process.env, FLEET_WEB_OUT: out },
    encoding: 'utf8',
  });
  if (built.status !== 0) throw new Error(`假数据模式打包失败：\n${built.stdout}\n${built.stderr}`);
  const client = join(out, 'client');
  if (!existsSync(join(client, 'index.html'))) throw new Error(`打包完没有 ${join(client, 'index.html')}`);
  // 单页：找不到文件的路径都回落到 index.html（和线上门面一样）。
  server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
    let file = join(client, path);
    if (!file.startsWith(client) || !existsSync(file) || statSync(file).isDirectory())
      file = join(client, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  if (out) rmSync(out, { recursive: true, force: true });
});

/** 第一屏里看不全的登录入口、横向滚动：一条一句白话；空数组才算过。 */
async function firstScreenProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const buttons = [...document.querySelectorAll('button, a')].filter((b) => b.getClientRects().length);
    for (const want of [/飞书/, /密码/]) {
      const hit = buttons.filter((b) => want.test(b.textContent ?? ''));
      if (!hit.length) {
        problems.push(`没找到${want.source}的登录入口`);
        continue;
      }
      // 同一个入口可能出现好几处（顶栏一个、卡片里一个），有一处完整落在第一屏就行。
      const rects = hit.map((b) => b.getBoundingClientRect());
      if (!rects.some((r) => r.top >= 0 && r.bottom <= vh && r.left >= 0 && r.right <= vw)) {
        problems.push(
          `${want.source}的入口不在第一屏：底边 ${Math.round(Math.min(...rects.map((r) => r.bottom)))}，视口高 ${vh}`,
        );
      }
    }
    const sw = document.scrollingElement?.scrollWidth ?? 0;
    if (sw > vw) problems.push(`横向能滚：页面宽 ${sw}，视口宽 ${vw}`);
    return problems;
  });
}

async function open(v: string, width: number, height: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`${base}/login?v=${v}`);
  await page.getByRole('button', { name: /飞书/ }).first().waitFor({ state: 'visible', timeout: 20_000 });
  // 等登录配置读回来（账号密码入口要等它才出来）和入场动画走完。
  await page.getByRole('button', { name: /密码/ }).first().waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForTimeout(400);
  return page;
}

describe('登录入口在第一屏', () => {
  for (const v of VARIANTS) {
    for (const vp of VIEWPORTS) {
      test(`${v} 版 · ${vp.name} ${vp.width}×${vp.height}`, async () => {
        const page = await open(v, vp.width, vp.height);
        try {
          expect(await firstScreenProblems(page)).toEqual([]);
        } finally {
          await page.close();
        }
      }, 60_000);
    }
  }

  test('先红：把按钮挪到第一屏外面，这条检查拦得住', async () => {
    const page = await open('a', 390, 844);
    try {
      await page.addStyleTag({ content: 'button, a { position: relative; top: 2000px; }' });
      const problems = await firstScreenProblems(page);
      expect(problems.some((p) => p.includes('飞书'))).toBe(true);
      expect(problems.some((p) => p.includes('密码'))).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);
});
