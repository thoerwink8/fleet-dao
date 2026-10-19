import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main, selectSessionId } from '../hooks/unattended.mjs';
import { codexSourceFixture } from './codex-source-fixture.ts';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'unattended-session-'));
  made.push(dir);
  return dir;
}
function invoke(env: NodeJS.ProcessEnv, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const status = main(args, { env, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { status, out: out.join('\n'), err: err.join('\n') };
}

describe('无人值守真实会话号（#2929）', () => {
  it('Claude、Codex thread、Codex session 依次优先，空变量才跳过', () => {
    const env = {
      CLAUDE_CODE_SESSION_ID: 'claude-real',
      CODEX_THREAD_ID: 'codex-thread-real',
      CODEX_SESSION_ID: 'codex-session-real',
    };
    expect(selectSessionId(env)).toEqual({ ok: true, id: 'claude-real' });
    expect(selectSessionId({ ...env, CLAUDE_CODE_SESSION_ID: '' })).toEqual({
      ok: true,
      id: 'codex-thread-real',
    });
    expect(selectSessionId({ CODEX_SESSION_ID: env.CODEX_SESSION_ID })).toEqual({
      ok: true,
      id: 'codex-session-real',
    });
  });

  it('钩子事件号优先于继承的父环境号，非法事件号不借父会话', () => {
    const env = { CLAUDE_CODE_SESSION_ID: 'parent-real' };
    expect(selectSessionId(env, 'child-real')).toEqual({ ok: true, id: 'child-real' });
    expect(selectSessionId(env, '../bad')).toMatchObject({ ok: false, missing: false });
    expect(selectSessionId(env, 1234)).toMatchObject({ ok: false, missing: false });
  });

  it.each(['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID'])(
    '%s 非法时全部命令失败，不借低优先级号，也不写状态',
    (source) => {
      const dir = temp();
      const env = {
        FLEET_UNATTENDED_DIR: dir,
        CODEX_SESSION_ID: 'valid-other-session',
        [source]: '../bad',
      };
      for (const cmd of ['on', 'status', 'off', 'done', 'needs-you']) {
        const result = invoke(env, cmd, '说明');
        expect(result.status).toBe(2);
        expect(result.err).toContain(`${source} 的会话号不合法`);
      }
      expect(readdirSync(dir)).toEqual([]);
    },
  );

  it('没有真实来源时明确失败，不伪造会话号', () => {
    const dir = temp();
    for (const cmd of ['on', 'status', 'off', 'done', 'needs-you']) {
      const result = invoke({ FLEET_UNATTENDED_DIR: dir }, cmd, '说明');
      expect(result.status).toBe(2);
      expect(result.err).toContain('拿不到会话号');
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each(['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID'])(
    '%s 支持全部命令，另一个会话的开关和收尾不影响它',
    (source) => {
      const dir = temp();
      const { home } = codexSourceFixture(dir, 'session-one');
      codexSourceFixture(dir, 'session-two');
      const env = { FLEET_UNATTENDED_DIR: dir, CODEX_HOME: home, [source]: 'session-one' };
      const other = { FLEET_UNATTENDED_DIR: dir, CODEX_HOME: home, [source]: 'session-two' };
      const file = join(dir, 'session-one.json');
      expect(invoke(env, 'on').status).toBe(0);
      const original = readFileSync(file, 'utf8');
      expect(invoke(other, 'status').out).toContain('没开');
      expect(invoke(other, 'done', '别的会话').status).toBe(1);
      expect(invoke(other, 'off').status).toBe(0);
      expect(readFileSync(file, 'utf8')).toBe(original);
      expect(invoke(env, 'status').out).toContain('on');
      expect(invoke(env, 'needs-you', '要拍板').status).toBe(0);
      expect(invoke(env, 'status').out).toContain('paused');
      expect(invoke(env, 'done', '已收口').status).toBe(0);
      expect(invoke(env, 'status').out).toContain('done');
      expect(invoke(env, 'off').status).toBe(0);
      expect(existsSync(file)).toBe(false);
    },
  );
});

interface StartOptions {
  cwd: string;
  home: string;
  git: () => { status: number; stdout: string; stderr: string };
  sync: () => { status: number; stdout: string; stderr: string };
  progress: () => { status: number; stdout: string; stderr: string };
  poolHolds: () => { ok: boolean; skipped: boolean };
  spawnBackground: () => { ok: boolean };
  env: NodeJS.ProcessEnv;
  sessionId?: string;
}
const starts = (await import(new URL('../hooks/session-start.mjs', import.meta.url).href)) as {
  sessionStart(options: StartOptions): string[];
  fastSessionStart(options: StartOptions): string[];
};

describe('SessionStart 无人值守状态消费方', () => {
  for (const name of ['sessionStart', 'fastSessionStart'] as const) {
    it(`${name} 没有事件号时读 Codex 环境号与指定状态目录；事件号隔离父环境`, () => {
      const dir = temp();
      const { home } = codexSourceFixture(dir, 'codex-real-session');
      const env = { FLEET_UNATTENDED_DIR: dir, CODEX_HOME: home, CODEX_THREAD_ID: 'codex-real-session' };
      expect(invoke(env, 'on').status).toBe(0);
      const noop = () => ({ status: 1, stdout: '', stderr: '假的非仓库' });
      const options: StartOptions = {
        cwd: dir,
        home: dir,
        git: noop,
        sync: noop,
        progress: noop,
        poolHolds: () => ({ ok: true, skipped: true }),
        spawnBackground: () => ({ ok: true }),
        env,
      };
      expect(starts[name](options).join('\n')).toContain('无人值守开着');
      expect(starts[name]({ ...options, sessionId: 'child-real-session' }).join('\n')).not.toContain(
        '无人值守开着',
      );
      const invalid = starts[name]({ ...options, env: { ...env, CODEX_THREAD_ID: '../bad' } });
      expect(invalid.join('\n')).toContain('开场身份没查成');
      expect(invalid.join('\n')).not.toContain('无人值守开着');
    });
  }
});
