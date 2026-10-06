// 钉住「起了后台活不再自动挡收尾」（决定 0026，创始人 2026-10-06 17:25「按照你推荐」）。
// 2026-10-04「选 1」曾经：起子代理、监视、后台命令就自动开 30 分钟无人值守，Stop 把收尾挡回去。
// 那条把普通对话按住几小时，也让引导要等的下一轮对账迟迟不来。现在 armForBackground 不写状态，decideStop 不拦。
// 认不出的工具名仍按拦处理。改标准：改这个文件要创始人同意。
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

describe('不再自动挡收尾', () => {
  const NOW = Date.parse('2026-10-06T12:00:00Z');

  it('起了后台活：不写状态，Stop 不拦', () => {
    const dir = tmp();
    expect(lib.armForBackground({ dir, sessionId: SID, now: NOW })).toEqual({
      armed: false,
      why: expect.stringMatching(/0026/),
    });
    expect(() => read(dir)).toThrow();
    expect(lib.decideStop({ dir, sessionId: SID, now: NOW + 60_000 }).block).toBe(false);
  });

  it('【故意造出的失败】旧的「开着」状态文件还在：不续期、不改内容，Stop 仍不拦', () => {
    const dir = tmp();
    const eight = new Date(NOW + 8 * 3_600_000).toISOString();
    const before = JSON.stringify({
      state: 'on',
      expiresAt: eight,
      idle: 0,
      totalBlocks: 0,
      toolSinceBlock: true,
    });
    writeFileSync(join(dir, `${SID}.json`), before);
    expect(lib.armForBackground({ dir, sessionId: SID, now: NOW }).armed).toBe(false);
    expect(readFileSync(join(dir, `${SID}.json`), 'utf8')).toBe(before);
    expect(lib.decideStop({ dir, sessionId: SID, now: NOW + 1000 }).block).toBe(false);
  });

  it('【故意造出的失败】状态文件认不出：不覆盖', () => {
    const dir = tmp();
    const f = join(dir, `${SID}.json`);
    writeFileSync(f, '{坏了');
    expect(lib.armForBackground({ dir, sessionId: SID, now: NOW }).armed).toBe(false);
    expect(readFileSync(f, 'utf8')).toBe('{坏了');
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
  ])('%s：登记过的非判断类工具——放行，并且不自动开无人值守', (tool, input) => {
    const dir = tmp();
    const r = run(dir, tool, input);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(() => read(dir)).toThrow();
  });

  it('后台命令：照常判（危险的照拦），不危险的放行；前台、后台都不开无人值守', () => {
    const dir = tmp();
    expect(run(dir, 'Bash', { command: 'echo hi' }).status).toBe(0);
    expect(() => read(dir)).toThrow();
    expect(run(dir, 'Bash', { command: 'echo hi', run_in_background: true }).status).toBe(0);
    expect(() => read(dir)).toThrow();
  });

  it('【故意造出的失败】前台子代理不开；认不出的工具名仍按拦处理（只放行登记过的那几个）', () => {
    const dir = tmp();
    expect(run(dir, 'Agent', { prompt: 'x', run_in_background: false }).status).toBe(0);
    expect(() => read(dir)).toThrow();
    mkdirSync(dir, { recursive: true });
    expect(run(dir, 'SomethingElse', {}).status).toBe(2);
  });
});
