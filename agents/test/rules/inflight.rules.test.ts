// 钉住「起了后台活就自动开一个短的无人值守」（改标准：改这个文件要创始人同意，agents/test/rules/ 在清单里）。
// 规矩（创始人 2026-10-04「选 1」）：子代理、监视、工作流、后台命令都挂在会话进程上，一轮结束、进程一重开就一起被杀，
// 没有谁会被完成通知叫醒（#754 的测试和三个监视任务就是这么没的）。所以起后台活的那一下，调工具前钩子自动开一个 30 分钟的无人值守，
// 这一轮想结束会被挡回来；全收口跑 done 放行；忘了跑也不困人（到期、连着 3 次没干活都自动放行）。
// 脚本改了这条，这里会红；含故意造出的失败：前台子代理不开、手动开的更长的不被缩短、状态认不出不覆盖、认不出的工具名不被拦。
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

interface State {
  state: string;
  auto?: boolean;
  expiresAt: string;
  idle: number;
  totalBlocks: number;
}
interface Lib {
  AUTO_ARM_MINUTES: number;
  startsBackground(tool: unknown, input: unknown): boolean;
  armForBackground(o: { dir: string; sessionId: string; now?: number; minutes?: number }): {
    armed: boolean;
    kept?: boolean;
    why?: string;
  };
  decideStop(o: { dir: string; sessionId: string; now?: number }): {
    block: boolean;
    reason?: string;
    notice?: string;
  };
  readState(dir: string, id: string): { ok: boolean; state?: State | null; why?: string };
}
const HOOKS = fileURLToPath(new URL('../../hooks/', import.meta.url));
const lib = (await import(pathToFileURL(join(HOOKS, 'unattended.mjs')).href)) as Lib;
const SID = 'sess-1234-abcd';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'inflight-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const read = (dir: string) => JSON.parse(readFileSync(join(dir, `${SID}.json`), 'utf8')) as State;

describe('哪些调用算起了后台活', () => {
  it.each([
    ['Monitor', {}],
    ['Workflow', {}],
    ['Agent', {}],
    ['Agent', { run_in_background: true }],
    ['Task', {}],
    ['Bash', { run_in_background: true }],
    ['PowerShell', { run_in_background: true }],
  ])('%s %j：算', (tool, input) => {
    expect(lib.startsBackground(tool, input)).toBe(true);
  });

  it.each([
    ['Agent', { run_in_background: false }],
    ['Bash', {}],
    ['Bash', { run_in_background: false }],
    ['Bash', { run_in_background: 'true' }],
    ['PowerShell', {}],
    ['Read', {}],
    ['Grep', {}],
    [undefined, undefined],
  ])('%s %j：不算（前台的、字符串 "true"、读文件、认不出）', (tool, input) => {
    expect(lib.startsBackground(tool, input)).toBe(false);
  });
});

describe('自动开', () => {
  const NOW = Date.parse('2026-10-04T12:00:00Z');

  it('没开过：开成 auto，30 分钟，Stop 把收尾挡回去，reason 说的是后台活、给 done 命令', () => {
    const dir = tmp();
    expect(lib.armForBackground({ dir, sessionId: SID, now: NOW })).toEqual({ armed: true });
    const s = read(dir);
    expect(s).toMatchObject({ state: 'on', auto: true });
    expect(Date.parse(s.expiresAt) - NOW).toBe(30 * 60_000);
    const stop = lib.decideStop({ dir, sessionId: SID, now: NOW + 60_000 });
    expect(stop.block).toBe(true);
    expect(stop.reason).toMatch(/后台活/);
    expect(stop.reason).toMatch(/unattended\.mjs done/);
  });

  it('跑 done 放行；done 之后再起后台活重新开；暂停的也重新开', () => {
    const dir = tmp();
    lib.armForBackground({ dir, sessionId: SID, now: NOW });
    const f = join(dir, `${SID}.json`);
    writeFileSync(f, JSON.stringify({ ...read(dir), state: 'done' }));
    expect(lib.decideStop({ dir, sessionId: SID, now: NOW + 1000 }).block).toBe(false);
    expect(lib.armForBackground({ dir, sessionId: SID, now: NOW + 2000 }).armed).toBe(true);
    expect(lib.decideStop({ dir, sessionId: SID, now: NOW + 3000 }).block).toBe(true);
    writeFileSync(f, JSON.stringify({ ...read(dir), state: 'paused' }));
    expect(lib.armForBackground({ dir, sessionId: SID, now: NOW + 4000 }).armed).toBe(true);
  });

  it('再起一个后台活：自动开的续到再过 30 分钟', () => {
    const dir = tmp();
    lib.armForBackground({ dir, sessionId: SID, now: NOW });
    const later = NOW + 20 * 60_000;
    expect(lib.armForBackground({ dir, sessionId: SID, now: later })).toEqual({ armed: false, kept: true });
    expect(Date.parse(read(dir).expiresAt) - later).toBe(30 * 60_000);
  });

  it('【故意造出的失败】创始人手动开的（8 小时）不被缩成 30 分钟，也不改成 auto', () => {
    const dir = tmp();
    const eight = new Date(NOW + 8 * 3_600_000).toISOString();
    writeFileSync(
      join(dir, `${SID}.json`),
      JSON.stringify({ state: 'on', expiresAt: eight, idle: 0, totalBlocks: 0, toolSinceBlock: true }),
    );
    expect(lib.armForBackground({ dir, sessionId: SID, now: NOW })).toEqual({ armed: false, kept: true });
    const s = read(dir);
    expect(s.expiresAt).toBe(eight);
    expect(s.auto).toBeUndefined();
  });

  it('【故意造出的失败】状态文件认不出：不覆盖，返回为什么；会话号不合法：不写', () => {
    const dir = tmp();
    const f = join(dir, `${SID}.json`);
    writeFileSync(f, '{坏了');
    const r = lib.armForBackground({ dir, sessionId: SID, now: NOW });
    expect(r.armed).toBe(false);
    expect(r.why).toMatch(/JSON|读不了|认不出/);
    expect(readFileSync(f, 'utf8')).toBe('{坏了');
    expect(lib.armForBackground({ dir, sessionId: '../x', now: NOW })).toMatchObject({ armed: false });
  });

  it('忘了跑 done 也不困人：30 分钟一到放行；连着 3 次挡回去都没调工具就暂停', () => {
    const dir = tmp();
    lib.armForBackground({ dir, sessionId: SID, now: NOW });
    expect(lib.decideStop({ dir, sessionId: SID, now: NOW + 31 * 60_000 }).block).toBe(false);
    const dir2 = tmp();
    lib.armForBackground({ dir: dir2, sessionId: SID, now: NOW });
    const blocks = [1, 2, 3, 4].map(
      (i) => lib.decideStop({ dir: dir2, sessionId: SID, now: NOW + i * 1000 }).block,
    );
    expect(blocks).toEqual([true, true, true, false]);
  });
});

describe('真的当钩子跑（pretool.mjs）', () => {
  const run = (dir: string, tool: string, toolInput: unknown) =>
    spawnSync(process.execPath, [join(HOOKS, 'pretool.mjs')], {
      input: JSON.stringify({ tool_name: tool, tool_input: toolInput, session_id: SID, cwd: '/work/other' }),
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, FLEET_UNATTENDED_DIR: dir, CLAUDE_CODE_SESSION_ID: SID },
    });

  it.each([
    ['Monitor', { command: 'until false; do sleep 1; done' }],
    ['Agent', { prompt: 'x', description: 'y' }],
    ['Workflow', { script: 'x' }],
  ])('%s：登记过的非判断类工具——开了无人值守、钩子放行（不会被「认不出工具名」拦下）', (tool, input) => {
    const dir = tmp();
    const r = run(dir, tool, input);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(read(dir)).toMatchObject({ state: 'on', auto: true });
  });

  it('后台命令：照常判（危险的照拦），不危险的放行并开；前台的不开', () => {
    const dir = tmp();
    expect(run(dir, 'Bash', { command: 'echo hi' }).status).toBe(0);
    expect(() => read(dir)).toThrow();
    expect(run(dir, 'Bash', { command: 'echo hi', run_in_background: true }).status).toBe(0);
    expect(read(dir)).toMatchObject({ state: 'on', auto: true });
  });

  it('【故意造出的失败】前台子代理不开；认不出的工具名仍按拦处理（只放行登记过的那几个）', () => {
    const dir = tmp();
    expect(run(dir, 'Agent', { prompt: 'x', run_in_background: false }).status).toBe(0);
    expect(() => read(dir)).toThrow();
    mkdirSync(dir, { recursive: true });
    expect(run(dir, 'SomethingElse', {}).status).toBe(2);
  });
});
