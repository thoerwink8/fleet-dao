import { type SpawnOptions, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

interface Answer {
  ok: boolean;
  why?: string;
  cleanupFailed?: boolean;
}
interface Ask {
  askOne(
    key: string,
    model: string,
    prompt: string,
    limit: number,
    dir: string,
    deps: { spawnFn: typeof spawn; stopTree?: (child: unknown) => void },
  ): Promise<Answer>;
}
const ask = (await import(
  pathToFileURL(fileURLToPath(new URL('../skills/discuss/scripts/ask.mjs', import.meta.url))).href
)) as Ask;
// 运行时生成的夹具放仓根临时目录，不是测试读取的版本控制输入。
const workspace = join(process.cwd(), '_tmp');
mkdirSync(workspace, { recursive: true });

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(ids: number[]) {
  const until = Date.now() + 2000;
  while (ids.some(alive) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

it('讨论超时后才返回：假执行体及其长驻子孙均已停止，工作区可删除', { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(workspace, 'discuss-tree-'));
  const script = join(dir, 'fake.mjs');
  const pids = join(dir, 'pids.json');
  writeFileSync(
    script,
    `import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
writeFileSync(${JSON.stringify(pids)},JSON.stringify([process.pid,child.pid]));
setInterval(()=>{},1000);
`,
  );
  let child: ReturnType<typeof spawn> | undefined;
  let closed = false;
  const spawnFn = ((_file: string, _args: string[], options: SpawnOptions) => {
    child = spawn(process.execPath, [script], options);
    child.once('close', () => {
      closed = true;
    });
    return child;
  }) as typeof spawn;
  try {
    const result = await ask.askOne('fake', 'no-model', 'no-network', 0.7, dir, { spawnFn });
    expect(result.ok).toBe(false);
    expect(result.why).toContain('超过');
    expect(result.cleanupFailed).toBe(false);
    expect(closed, '必须等执行体和输出管道关闭才结算').toBe(true);
    expect(existsSync(pids), '假执行体必须真正启动并创建子孙').toBe(true);
    const ids = JSON.parse(readFileSync(pids, 'utf8')) as number[];
    await waitGone(ids);
    expect(ids.map(alive), '超时完成时不能留存活子孙').toEqual([false, false]);
    rmSync(dir, { recursive: true });
    expect(existsSync(dir)).toBe(false);
  } finally {
    if (existsSync(pids)) {
      for (const pid of (JSON.parse(readFileSync(pids, 'utf8')) as number[]).reverse()) {
        if (alive(pid)) process.kill(pid, 'SIGKILL');
      }
    }
    child?.stdin?.destroy();
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    if (child?.pid && alive(child.pid)) child.kill('SIGKILL');
    if (child && !closed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        child?.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

it('终止进程树失败须返回未确认收尾，不能说停掉了或清理工作区', { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(workspace, 'discuss-stop-failed-'));
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<void> | undefined;
  const spawnFn = ((_file: string, _args: string[], options: SpawnOptions) => {
    child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...options, shell: false });
    exited = new Promise((resolve) => child?.once('exit', () => resolve()));
    return child;
  }) as typeof spawn;
  try {
    const result = await ask.askOne('fake', 'no-model', 'no-network', 0.2, dir, {
      spawnFn,
      stopTree: () => {
        throw new Error('synthetic permission denied');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.cleanupFailed).toBe(true);
    expect(result.why).toContain('收尾没查成');
    expect(result.why).toContain('synthetic permission denied');
    expect(result.why).not.toContain('已终止');
    expect(alive(child?.pid as number)).toBe(true);
    expect(existsSync(dir)).toBe(true);
  } finally {
    if (child?.pid && alive(child.pid)) child.kill('SIGKILL');
    await exited;
    await waitGone(child?.pid ? [child.pid] : []);
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

it('每家拿到各自独立的 CURSOR_CONFIG_DIR，且都在本次临时目录下、互不相同', async () => {
  const dir = mkdtempSync(join(workspace, 'discuss-cfg-'));
  const seen: Record<string, string | undefined> = {};
  const mk = (key: string) =>
    ((_file: string, _args: string[], options: SpawnOptions) => {
      seen[key] = options.env?.CURSOR_CONFIG_DIR;
      return spawn(process.execPath, ['-e', 'process.stdin.resume();process.stdin.on("end",()=>{})'], {
        ...options,
        shell: false,
      });
    }) as typeof spawn;
  try {
    await Promise.all(['a', 'b'].map((k) => ask.askOne(k, 'no-model', 'x', 0.3, dir, { spawnFn: mk(k) })));
    expect(seen.a).toBeTruthy();
    expect(seen.b).toBeTruthy();
    expect(seen.a).not.toBe(seen.b);
    expect(seen.a?.startsWith(dir)).toBe(true);
    expect(seen.b?.startsWith(dir)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

it('执行体早退且关闭 stdin：报告原始非零退出，不被 EPIPE 或超时改写', { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(workspace, 'discuss-early-exit-'));
  const spawnFn = ((_file: string, _args: string[], options: SpawnOptions) =>
    spawn(process.execPath, ['-e', 'process.stderr.write("synthetic refusal");process.exitCode=7;'], {
      ...options,
      shell: false,
    })) as typeof spawn;
  try {
    const result = await ask.askOne('fake', 'no-model', 'x'.repeat(1024 * 1024), 5, dir, { spawnFn });
    expect(result.ok).toBe(false);
    expect(result.cleanupFailed).toBe(false);
    expect(result.why).toContain('退出码 7');
    expect(result.why).toContain('synthetic refusal');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});
