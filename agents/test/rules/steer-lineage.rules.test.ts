// 钉住「创始人的话和引导按 Mirasim 会话认主、不串会话」那条的测试（改标准：改这个文件要创始人同意，packages/conventions/standard-paths.json；决定 0080）。
// 2026-10-11 的断链（创始人「看起来没问题，但是存在一个问题，就是现在你实现的引导方式会串会话想个最佳解决方式」）：
// ① 开会话钩子把「所有别的会话最近 60 分钟收到的话」列给每个会话：fleet-dao 会话 17:49 问的话，被另一个项目的会话当成自己的活答了；
// ② 开会话叫每个会话办进度单上全部待处理引导：18:15 发给指挥官的引导，另一个 fleet-dao 会话也办了，开出重复 PR #1884。
// 修法：一个 Mirasim 会话用过的全部原生会话号算一家（agents/hooks/founder-inbox.mjs 的 lineageOf），他的话只给同一家；
// 引导记主人（pnpm progress directive 写〔主：…〕，主人记下后不再改），开会话只叫主人办，别家的只计数。
// 下面用钩子真跑一遍：脚本改回「谁都看得见、谁见了都办」，这里会红。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

type Lineage =
  | { status: 'found'; dir: string; sessionIds: string[] }
  | { status: 'none' | 'unchecked'; why: string };
interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}
const HOOKS = fileURLToPath(new URL('../../hooks/', import.meta.url));
const SESSION_START = join(HOOKS, 'session-start.mjs');
const hook = (await import(pathToFileURL(SESSION_START).href)) as {
  recentPrompts(o: { home: string; now: number; sessionId: string; lineage?: Lineage }): string[];
  checkProgressIssue(o: {
    cwd: string;
    git: (cwd: string, args: string[]) => Result;
    run: (script: string, repo: string) => Result;
    mirror: string;
    lineage: Lineage;
  }): string[];
};
const inbox = (await import(pathToFileURL(join(HOOKS, 'founder-inbox.mjs')).href)) as {
  lineageOf(o: { home: string; sessionId: unknown }): Lineage;
};

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T = (iso: string) => Date.parse(iso);
const NOW = T('2026-10-11T10:20:00Z');

/** 两个 Mirasim 会话：A（fleet-dao，换过一次原生号 a-old → a-new）、B（另一个项目） */
function world(): string {
  const home = mkdtempSync(join(tmpdir(), 'steer-lineage-'));
  made.push(home);
  const session = (dir: string, native: string, turns: unknown[]) => {
    const d = join(home, '.mirasim', 'sessions', 'claude', dir);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'record.json'), JSON.stringify({ workdir: 'D:\\x', nativeSessionId: native }));
    writeFileSync(join(d, 'turns.jsonl'), turns.map((t) => `${JSON.stringify(t)}\n`).join(''));
  };
  session('dir-a', 'a-new', [
    { sessionId: 'a-old', startedAt: T('2026-10-11T09:49:00Z'), prompt: 'A 换号前收到的话' },
    { sessionId: 'a-new', startedAt: T('2026-10-11T10:19:00Z'), prompt: 'A 开场' },
  ]);
  session('dir-b', 'b-1', [{ sessionId: 'b-1', startedAt: T('2026-10-11T10:00:00Z'), prompt: 'B 收到的话' }]);
  const log = join(home, '.fleet-dao', 'prompt-log');
  mkdirSync(log, { recursive: true });
  const rows = [
    { at: '2026-10-11T09:49:01Z', sessionId: 'a-old', prompt: 'A 换号前收到的话' },
    { at: '2026-10-11T10:19:01Z', sessionId: 'a-new', prompt: 'A 开场' },
    { at: '2026-10-11T10:00:01Z', sessionId: 'b-1', prompt: 'B 收到的话' },
  ];
  writeFileSync(join(log, '2026-10-11.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  return home;
}

describe('规矩：他的话只给同一个 Mirasim 会话（不串会话）', () => {
  it('A 开场看得到自己换号前收到的话，看不到 B 的；B 开场看不到 A 的', () => {
    const home = world();
    const a = hook.recentPrompts({ home, now: NOW, sessionId: 'a-new' }).join('\n');
    expect(a).toContain('A 换号前收到的话');
    expect(a).not.toContain('B 收到的话');
    const b = hook.recentPrompts({ home, now: NOW, sessionId: 'b-1' }).join('\n');
    expect(b).not.toContain('A 换号前收到的话');
  });

  it('不是 Mirasim 起的会话（无血缘）：别的会话的话一句都不列', () => {
    const home = world();
    expect(hook.recentPrompts({ home, now: NOW, sessionId: 'cli-session' })).toEqual([]);
  });

  it('【故意造出的失败】血缘认错成 A 家：B 开场就会看到 A 的话——上面的断言查得出串会话', () => {
    const home = world();
    const wrong = inbox.lineageOf({ home, sessionId: 'a-new' });
    const b = hook.recentPrompts({ home, now: NOW, sessionId: 'b-1', lineage: wrong }).join('\n');
    expect(b).toContain('A 换号前收到的话');
  });
});

describe('规矩：待处理的引导只叫主人那个会话办', () => {
  // 假 git：仓根 /r、origin 是 fleet-dao；progress.ts 的输出是三条引导（A 的、B 的、无主的）
  const git = (_cwd: string, args: string[]): Result => ({
    status: 0,
    stdout: args[0] === 'rev-parse' ? '/r\n' : 'https://github.com/thoerwink8/fleet-dao.git\n',
    stderr: '',
  });
  const H = '【创始人引导·待处理】2026-10-11 18:15';
  const out = `1\t${H}\t原话：A 的引导\tdir-a\n2\t${H}\t原话：B 的引导\tdir-b\n3\t${H}\t原话：旧引导\t无主\n`;
  const run = (): Result => ({ status: 0, stdout: out, stderr: '' });
  const check = (lineage: Lineage) =>
    hook.checkProgressIssue({ cwd: '/r', git, run, mirror: SESSION_START, lineage }).join('\n');
  const A: Lineage = { status: 'found', dir: 'dir-a', sessionIds: ['dir-a'] };

  it('A 只被叫去办自己的；B 的只说条数、不给原文；无主的直接办、办完关挂的单（没有认领）', () => {
    const said = check(A);
    expect(said).toContain('A 的引导');
    expect(said).not.toContain('B 的引导');
    expect(said).toContain('别的会话还有 1 条创始人引导在办');
    expect(said).toMatch(/旧引导.*直接接着办，办完把挂的单关掉/);
    expect(said).not.toContain('progress claim');
  });

  it('【故意造出的失败】换成 B 开场：A 的引导原文不给 B——上面的断言查得出撞车', () => {
    const said = check({ status: 'found', dir: 'dir-b', sessionIds: ['dir-b'] });
    expect(said).toContain('B 的引导');
    expect(said).not.toContain('A 的引导');
  });
});
