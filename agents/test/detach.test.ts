// detach.mjs（单 #2761）：起不跟着聊天进程一起死的进程。
// 真进程的那条照 Mirasim 重启会话的做法杀父进程树（Windows：taskkill /PID <父> /T /F，server.cjs 里就是这一句；别的平台：杀父进程组），
// 断言 spawnDetached 起的还活着、参数一个字不差地到了；对照组（普通 spawn、Windows 上的 spawn({ detached: true })）被一起杀掉，
// 证明测的确实是「整棵树被杀」这件事。另有几条拿假的 PowerShell 钉住认不出、没起成时照实报。
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { commandLine, quoteArg, spawnDetached } from '../local-sessions/detach.mjs';
import { runChild } from './child.ts';

const DETACH = fileURLToPath(new URL('../local-sessions/detach.mjs', import.meta.url));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

// 「父」：起三个子进程——spawnDetached 的、spawn({ detached: true }) 的、普通 spawn 的——写下进程号，自己挂着不走（像还在跑的聊天进程）。
const PARENT = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { spawnDetached } from ${JSON.stringify(pathToFileURL(DETACH).href)};
const [out, argvOut] = process.argv.slice(2);
const code = "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2))); setTimeout(() => {}, 60000)";
const d = spawnDetached(process.execPath, ['-e', code, argvOut, 'a b', 'q"x', 'tail\\\\', '']);
const sleeper = ['-e', 'setTimeout(() => {}, 60000)'];
const nd = spawn(process.execPath, sleeper, { detached: true, stdio: 'ignore', windowsHide: true });
nd.unref();
const plain = spawn(process.execPath, sleeper, { stdio: 'ignore', windowsHide: true });
writeFileSync(out, JSON.stringify({ d, nodeDetached: nd.pid, plain: plain.pid }));
setInterval(() => {}, 1e9);
`;

describe('spawnDetached 起的进程不跟着父进程树一起死', () => {
  it('杀掉父进程树后它还活着，参数原样到了；对照组被一起杀掉', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'detach-'));
    const script = join(dir, 'parent.mjs');
    const out = join(dir, 'pids.json');
    const argvOut = join(dir, 'argv.json');
    writeFileSync(script, PARENT);
    const win = process.platform === 'win32';
    const parent = spawn(process.execPath, [script, out, argvOut], {
      stdio: 'ignore',
      windowsHide: true,
      detached: !win, // 非 Windows：父进程自成一个进程组，下面整组杀
    });
    const pids: {
      d: { ok: boolean; pid?: number; how?: string; why?: string };
      nodeDetached: number;
      plain: number;
    } = await until(() => existsSync(out), 30_000).then(() => JSON.parse(readFileSync(out, 'utf8')));
    expect(pids.d.ok, pids.d.why).toBe(true);
    expect(pids.d.how).toBe(win ? 'wmi' : 'setsid');
    const detachedPid = pids.d.pid as number;
    try {
      expect(await until(() => existsSync(argvOut), 15_000)).toBe(true);
      expect(alive(detachedPid)).toBe(true);
      expect(alive(pids.plain)).toBe(true);
      if (typeof parent.pid !== 'number') throw new Error('父进程没起来');
      if (win) {
        const k = runChild('taskkill', ['/PID', String(parent.pid), '/T', '/F']);
        expect(k.status, k.stderr).toBe(0);
      } else {
        process.kill(-parent.pid, 'SIGKILL');
      }
      // 对照组死了，说明这棵树确实被杀了
      expect(await until(() => !alive(pids.plain), 10_000)).toBe(true);
      if (win) expect(await until(() => !alive(pids.nodeDetached), 10_000)).toBe(true);
      // 父进程被杀后要等 Node 收尸（没收之前是僵尸，kill(pid, 0) 照样成功），同步查一下会偶发判活
      const parentPid = parent.pid;
      expect(await until(() => !alive(parentPid), 10_000)).toBe(true);
      // spawnDetached 起的还活着，参数一个字不差
      expect(alive(detachedPid)).toBe(true);
      expect(JSON.parse(readFileSync(argvOut, 'utf8'))).toEqual(['a b', 'q"x', 'tail\\', '']);
    } finally {
      for (const pid of [detachedPid, pids.nodeDetached, pids.plain]) {
        if (pid && alive(pid)) process.kill(pid);
      }
    }
  }, 60_000);
});

describe('命令行转义（CreateProcess 的规矩）', () => {
  it.each([
    ['plain', 'plain'],
    ['a b', '"a b"'],
    ['', '""'],
    ['q"x', '"q\\"x"'],
    ['tail\\', 'tail\\'],
    ['sp tail\\', '"sp tail\\\\"'],
    ['a\\"b', '"a\\\\\\"b"'],
    ['C:\\Program Files\\node.exe', '"C:\\Program Files\\node.exe"'],
  ])('%j → %s', (arg, want) => {
    expect(quoteArg(arg)).toBe(want);
  });

  it('整条命令行是各段转义后用空格接起来', () => {
    expect(commandLine('C:\\n\\node.exe', ['-e', 'x y'])).toBe('C:\\n\\node.exe -e "x y"');
  });
});

describe('WMI 没起成照实报，不冒充起成了', () => {
  const run = (r: { status: number | null; stdout?: string; stderr?: string; error?: Error }) => () => ({
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    error: r.error,
  });

  it('起成了：返回进程号，命令行和目录经环境变量交给 PowerShell', () => {
    let seen: Record<string, string> = {};
    const r = spawnDetached('C:\\node.exe', ['a b'], {
      platform: 'win32',
      cwd: 'D:\\w',
      runPs: (env) => {
        seen = env;
        return { status: 0, stdout: '0 4242\r\n', stderr: '' };
      },
    });
    expect(r).toEqual({ ok: true, pid: 4242, how: 'wmi' });
    expect(seen).toEqual({ FLEET_DETACH_CMD: 'C:\\node.exe "a b"', FLEET_DETACH_CWD: 'D:\\w' });
  });

  it.each([
    [{ status: 0, stdout: '9 0' }, 'Win32_Process.Create 返回 9'],
    [{ status: 0, stdout: '' }, '认不出'],
    [{ status: 0, stdout: '0 0' }, '没给进程号'],
    [{ status: 1, stderr: '拒绝访问' }, '退出码 1：拒绝访问'],
    [{ status: null, error: new Error('spawn powershell.exe ENOENT') }, 'PowerShell 没跑起来'],
  ])('%j → 没起成（%s）', (res, want) => {
    const r = spawnDetached('node', [], { platform: 'win32', runPs: run(res) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain(want);
  });

  it('PowerShell 自己抛了也不抛出来', () => {
    const r = spawnDetached('node', [], {
      platform: 'win32',
      runPs: () => {
        throw new Error('炸了');
      },
    });
    expect(r).toEqual({ ok: false, why: '起的时候自己出错了（炸了）' });
  });
});
