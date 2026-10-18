// 驾驶舱截图（#1847，设计规范片 1）：起 dev:mock（假数据，不连后端），按页 × 宽度 × 亮暗逐张截，
// 存到仓根 _tmp/shots/<标签>/<页>-<宽>-<亮暗>.png。改界面的 PR 用它出改前（主线）改后两组图。
// 用法（在 packages/web 下）：
//   node scripts/shots.ts before                         12 页 × 1920/1366/390 × 亮暗
//   node scripts/shots.ts after --widths 1366 --modes light --pages home,tasks
//   node scripts/shots.ts after --base http://localhost:5173   已有开发服务时不再另起
// 浏览器默认用本机 Chrome（channel chrome），别的用 SHOTS_BROWSER_CHANNEL（msedge、chromium）。
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgDir, '../..');

export const PAGES: readonly (readonly [string, string])[] = [
  ['home', '/'],
  // 画布：原来的主页（决定 0093 挪进「更多」）
  ['board', '/board'],
  ['tasks', '/tasks'],
  // 任务页的演示样板（#3140、#3169）：t-c9 做完、两个回合返工一次；t-12 在跑的返工回合
  ['task-c9', '/tasks/t-c9'],
  ['task-12', '/tasks/t-12'],
  ['notifications', '/notifications'],
  ['routing', '/routing'],
  ['status', '/routing/status'],
  // 思考档位并进路由页的页签（#1914）
  ['efforts', '/routing?tab=efforts'],
  ['quota', '/quota'],
  ['france', '/france'],
  // 资源页（#1986）
  ['resources', '/resources'],
  // 提需求（#2062）：列表、和指挥官聊、开了单看进度、让别家挑错
  ['intake', '/intake'],
  ['intake-chat', '/intake?r=46'],
  ['intake-progress', '/intake?r=31'],
  ['intake-review', '/intake?r=44'],
  ['intake-deleted', '/intake?view=deleted'],
  ['intake-continue', '/intake?r=new&from=31'],
  ['schedules', '/schedules'],
  ['changelog', '/changelog'],
  ['audit', '/audit'],
  ['settings', '/settings'],
];
const HEIGHTS: Record<number, number> = { 1920: 1080, 1366: 768, 390: 844 };
const MODES = ['light', 'dark'] as const;
type Mode = (typeof MODES)[number];

interface Options {
  label: string;
  pages: (readonly [string, string])[];
  widths: number[];
  modes: Mode[];
  base?: string | undefined;
  port: number;
}

function listArg(argv: string[], name: string): string[] | undefined {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v ? v.split(',').map((s) => s.trim()) : undefined;
}

export function parseArgs(argv: string[]): Options {
  const label = argv[0];
  if (!label || label.startsWith('--'))
    throw new Error('第一个参数是标签（输出到 _tmp/shots/<标签>/），没给');
  const pageKeys = listArg(argv, '--pages');
  const pages = pageKeys ? PAGES.filter(([key]) => pageKeys.includes(key)) : [...PAGES];
  if (pageKeys && pages.length !== pageKeys.length) {
    throw new Error(
      `--pages 里有认不出的页：${pageKeys.join(',')}；认得的：${PAGES.map(([k]) => k).join(',')}`,
    );
  }
  const widths = (listArg(argv, '--widths') ?? ['1920', '1366', '390']).map(Number);
  for (const w of widths) if (!HEIGHTS[w]) throw new Error(`--widths 只认 1920、1366、390，收到 ${w}`);
  const modes = (listArg(argv, '--modes') ?? [...MODES]) as Mode[];
  for (const m of modes) if (!MODES.includes(m)) throw new Error(`--modes 只认 light、dark，收到 ${m}`);
  const base = listArg(argv, '--base')?.[0];
  const port = Number(listArg(argv, '--port')?.[0] ?? 5291);
  return { label, pages, widths, modes, base, port };
}

async function waitUp(url: string, child: ChildProcess): Promise<void> {
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`dev:mock 退出了（退出码 ${child.exitCode}），没起来`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // 还没起来，接着等
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`等了 90 秒 ${url} 还没起来`);
}

function startMock(port: number): ChildProcess {
  const require = createRequire(join(pkgDir, 'package.json'));
  const bin = join(dirname(require.resolve('@react-router/dev/package.json')), 'bin.cjs');
  const child = spawn(
    process.execPath,
    [bin, 'dev', '--mode', 'mock', '--port', String(port), '--strictPort'],
    {
      cwd: pkgDir,
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );
  return child;
}

function stop(child: ChildProcess) {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGTERM');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const out = join(repoRoot, '_tmp', 'shots', opts.label);
  mkdirSync(out, { recursive: true });
  const base = opts.base ?? `http://localhost:${opts.port}`;
  const server = opts.base ? undefined : startMock(opts.port);
  try {
    if (server) await waitUp(base, server);
    const browser = await chromium.launch({ channel: process.env.SHOTS_BROWSER_CHANNEL?.trim() || 'chrome' });
    try {
      for (const width of opts.widths) {
        for (const mode of opts.modes) {
          const ctx = await browser.newContext({
            viewport: { width, height: HEIGHTS[width] ?? 768 },
            colorScheme: mode,
            reducedMotion: 'reduce',
            locale: 'zh-CN',
            timezoneId: 'Asia/Shanghai',
          });
          for (const [key, path] of opts.pages) {
            const page = await ctx.newPage();
            await page.goto(base + path, { waitUntil: 'load', timeout: 60_000 });
            // 假数据有 90ms 延迟，懒加载的路由块也要时间；等页面安静下来再截。
            await page.waitForTimeout(2500);
            const file = join(out, `${key}-${width}-${mode}.png`);
            await page.screenshot({ path: file });
            console.log(file);
            await page.close();
          }
          await ctx.close();
        }
      }
    } finally {
      await browser.close();
    }
  } finally {
    if (server) stop(server);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
