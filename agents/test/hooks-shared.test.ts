// 钩子共用的 git 跑法（agents/hooks/git-run.mjs）和几处原来各写一份的口径（全仓审查第 4 路 R3、R4），
// 以及起子代理前取远端出错整段吞掉（S9）。每条都故意造出失败。
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

interface R {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: (Error & { code?: string }) | undefined;
  timeoutMs?: number;
}
type Git = (dir: string, args: string[], opts?: { direct?: boolean; timeoutMs?: number }) => R;

const HOOKS = fileURLToPath(new URL('../hooks/', import.meta.url));
const load = async <T>(rel: string) => (await import(pathToFileURL(join(HOOKS, rel)).href)) as T;

const run = await load<{
  gitRunner(timeoutMs?: number, directTimeoutMs?: number): Git;
  gitOk(r: R): boolean;
  gitBroken(r: R): boolean;
  gitWhy(r: R): string;
}>('git-run.mjs');
const pre = await load<{
  subagentFreshness(
    raw: string,
    deps?: { fresh?: (o: unknown) => { block: true; message: string } | null; cwd?: string },
  ): { block: boolean; message: string } | null;
}>('pretool.mjs');

/** 起真的 git、node 进程的用例：Windows 上一个 git 要几秒，几组测试并行时默认 5 秒会误红 */
const SLOW_MS = 30_000;

const made: string[] = [];
const temp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `hooks-shared-${name}-`));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('git-run.mjs：钩子跑 git 只有这一份', () => {
  it('别的钩子里不再自己 spawn git、不再自己判「git 没起来」', () => {
    const others = readdirSync(HOOKS).filter((f) => f.endsWith('.mjs') && f !== 'git-run.mjs');
    for (const f of others) {
      const text = readFileSync(join(HOOKS, f), 'utf8');
      expect(text, f).not.toMatch(/spawnSync\(\s*'git'/);
      expect(text, f).not.toContain('0x7fffffff');
    }
  });

  it('钩子之间的相对 import 都指向同目录里在的文件（同步工具把整个目录装到 ~/.fleet-dao/hooks/，少一个就整条钩子起不来）', () => {
    for (const f of readdirSync(HOOKS).filter((n) => n.endsWith('.mjs'))) {
      const text = readFileSync(join(HOOKS, f), 'utf8');
      for (const m of text.matchAll(/from '\.\/([\w.-]+\.mjs)'|import\('\.\/([\w.-]+\.mjs)'\)/g)) {
        const dep = m[1] ?? m[2] ?? '';
        expect(existsSync(join(HOOKS, dep)), `${f} → ${dep}`).toBe(true);
      }
    }
  });

  it(
    '目录不在：git 自己说话（128），不当成「git 没跑起来」',
    () => {
      const r = run.gitRunner(20_000)(join(temp('gone'), 'nope'), ['rev-parse', '--is-inside-work-tree']);
      expect(run.gitOk(r)).toBe(false);
      expect(r.status).toBe(128);
      expect(run.gitBroken(r)).toBe(false);
    },
    SLOW_MS,
  );

  it('起不来、超时、没退出码、Windows 缺 DLL 的大退出码都算没跑起来，原因说得出', () => {
    const enoent: R = {
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' }),
    };
    expect(run.gitBroken(enoent)).toBe(true);
    expect(run.gitWhy(enoent)).toBe('起不来：spawnSync git ENOENT');
    const dll: R = { status: 3221225781, stdout: '', stderr: '' };
    expect(run.gitBroken(dll)).toBe(true);
    expect(run.gitWhy(dll)).toContain('0xC0000135');
    const slow = (timeoutMs?: number): R => ({
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    expect(run.gitWhy(slow(6_000))).toBe('超过 6 秒没完');
    // 没带超时的结果不编一个秒数
    expect(run.gitWhy(slow())).toBe('超时没完');
    expect(run.gitBroken({ status: 128, stdout: '', stderr: 'fatal: not a git repository' })).toBe(false);
  });

  it(
    '直连那一次用直连的超时，结果里写的是这一次实际用的',
    () => {
      const g = run.gitRunner(20_000, 30_000);
      expect(g(HOOKS, ['--version']).timeoutMs).toBe(20_000);
      expect(g(HOOKS, ['--version'], { direct: true }).timeoutMs).toBe(30_000);
      expect(g(HOOKS, ['--version'], { timeoutMs: 25_000 }).timeoutMs).toBe(25_000);
    },
    SLOW_MS,
  );
});

describe('原来各写一份的口径（R4）', () => {
  it('工人目录：开会话钩子和 commander 技能是同一处', async () => {
    const ss = await load<{ WORKERS_REL: string }>('session-start.mjs');
    const wl = (await import(
      pathToFileURL(fileURLToPath(new URL('../skills/commander/scripts/worker-lib.mjs', import.meta.url)))
        .href
    )) as { workersDir(home: string): string; ROUTING_DEFAULT_REL: string };
    expect(wl.workersDir('H')).toBe(join('H', ss.WORKERS_REL));
    const src = await load<{ SYNC_DIR: string }>('sync-source.mjs');
    expect(wl.ROUTING_DEFAULT_REL.startsWith(`${src.SYNC_DIR}`)).toBe(true);
  });

  it('开会话列创始人最近的话认 FLEET_PROMPT_LOG_DIR（和落盘那边一样），不只看家目录', async () => {
    const ss = await load<{ recentPrompts(o: { home: string; now?: number }): string[] }>(
      'session-start.mjs',
    );
    const logs = temp('plog');
    const now = Date.parse('2026-10-05T07:30:00Z');
    writeFileSync(
      join(logs, '2026-10-05.jsonl'),
      `${JSON.stringify({ at: '2026-10-05T07:20:00Z', prompt: '落在别处的一句话' })}\n`,
    );
    const before = process.env.FLEET_PROMPT_LOG_DIR;
    process.env.FLEET_PROMPT_LOG_DIR = logs;
    try {
      expect(ss.recentPrompts({ home: temp('empty-home'), now }).join('\n')).toContain('落在别处的一句话');
    } finally {
      if (before === undefined) delete process.env.FLEET_PROMPT_LOG_DIR;
      else process.env.FLEET_PROMPT_LOG_DIR = before;
    }
  });
});

describe('起子代理前取远端那一步自己出错，不再整段吞掉（S9）', () => {
  it('出错：回一句不拦的话（主程序写进 stderr）', () => {
    const out = pre.subagentFreshness(JSON.stringify({ tool_name: 'Agent', tool_input: {} }), {
      fresh: () => {
        throw new Error('故意弄坏的');
      },
    });
    expect(out?.block).toBe(false);
    expect(out?.message).toContain('自己出错了（故意弄坏的）');
  });

  it('输入认不出不算它出错（由后面的 decide 按拦处理），不多说一句', () => {
    expect(
      pre.subagentFreshness('{认不出', {
        fresh: () => {
          throw new Error('不该走到');
        },
      }),
    ).toBeNull();
  });

  it('要拦的照拦', () => {
    const out = pre.subagentFreshness(JSON.stringify({ tool_name: 'Agent' }), {
      fresh: () => ({ block: true, message: '取不到远端' }),
    });
    expect(out).toEqual({ block: true, message: '取不到远端' });
  });
});
