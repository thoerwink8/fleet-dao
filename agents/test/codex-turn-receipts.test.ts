import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { latestRows } from '../hooks/continuation-latest.mjs';
import { fingerprint, readLatestReceiptState, receiptStatus } from '../hooks/continuation-receipts.mjs';
import { runChild } from './child.ts';
import { codexSourceFixture } from './codex-source-fixture.ts';
import { interactiveHookEnv } from './hook-env.ts';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const hooks = ['continuation-start', 'stop-codex', 'continuation-progress-codex'];
function fixture(cli: 'codex' | 'claude' = 'codex') {
  const dir = mkdtempSync(join(tmpdir(), 'codex-turn-'));
  made.push(dir);
  const sid = 'isolated-root';
  const { home } = codexSourceFixture(dir, sid);
  const env = {
    ...interactiveHookEnv(),
    CODEX_HOME: home,
    FLEET_UNATTENDED_DIR: dir,
    FLEET_WORK_RUNS_DIR: join(dir, 'runs'),
  };
  // 仅在临时目录开独立窗口；随后真实wrapper不继承CLI身份。
  const opened = runChild(
    process.execPath,
    [fileURLToPath(new URL('../hooks/unattended.mjs', import.meta.url)), 'on'],
    {
      cwd: dir,
      env: { ...env, ...(cli === 'codex' ? { CODEX_THREAD_ID: sid } : { CLAUDE_CODE_SESSION_ID: sid }) },
    },
  );
  expect(opened.status).toBe(0);
  const file = join(dir, '.receipts', `${fingerprint(sid)}.latest-v2`);
  const stateFile = join(dir, `${sid}.json`);
  const rows = () => {
    const read = readLatestReceiptState(dir, fingerprint(sid));
    if (!read.ok || !read.state) throw Error(read.ok ? 'missing snapshot' : read.code);
    return latestRows(read.state).filter((row) => row !== null);
  };
  const run = (hook: string, input: object = {}, extra: NodeJS.ProcessEnv = {}) => {
    const r = runChild(process.execPath, [fileURLToPath(new URL(`../hooks/${hook}.mjs`, import.meta.url))], {
      cwd: dir,
      env: { ...env, ...extra },
      input: JSON.stringify({ session_id: sid, cwd: dir, ...input }),
    });
    expect(r.status).toBe(0);
    return r;
  };
  return { dir, sid, file, stateFile, rows, run };
}

describe('可信Codex wrapper使用本次事件turn，CLI家族不授予根资格', { timeout: 0 }, () => {
  it.each(hooks)('%s无CLI环境仍保存合法事件turn指纹', (hook) => {
    const s = fixture();
    s.run(hook, { turn_id: 'event-turn' });
    const entered = s.rows().findLast((r) => r.phase === 'entered');
    expect(entered).toMatchObject({
      cli: 'codex',
      turn: fingerprint('event-turn'),
      session: fingerprint(s.sid),
    });
    expect(readFileSync(s.file, 'utf8')).not.toContain('event-turn');
  });

  it.each(hooks)('%s缺失或非法turn不从环境补造', (hook) => {
    const s = fixture();
    for (const turn_id of [undefined, '', '../bad', { id: 'bad' }, 'x'.repeat(129)]) {
      s.run(hook, { turn_id }, { CODEX_TURN_ID: 'inherited-turn' });
      expect(s.rows().findLast((r) => r.phase === 'entered')).toMatchObject({ cli: 'codex', turn: null });
    }
  });

  it('Stop同turn/下一turn有独立记录，仍不声称真实续轮或结果消费', () => {
    const s = fixture();
    expect(JSON.parse(s.run('stop-codex', { turn_id: 'first-turn' }).stdout).decision).toBe('block');
    s.run('continuation-progress-codex', { turn_id: 'first-turn' });
    expect(s.rows().some((r) => r.phase === 'same_turn')).toBe(true);
    expect(s.rows().some((r) => r.phase === 'next_turn_observed')).toBe(false);
    s.run('continuation-progress-codex', { turn_id: 'second-turn' });
    expect(s.rows().find((r) => r.phase === 'next_turn_observed')).toMatchObject({
      originTurn: fingerprint('first-turn'),
      turn: fingerprint('second-turn'),
      decision: 'source_unknown',
    });
    const state = JSON.parse(readFileSync(s.stateFile, 'utf8'));
    expect(receiptStatus(s.dir, s.sid, state.generation)).toMatchObject({
      nextTurnObserved: true,
      rootContinuation: 'unknown',
      resultConsumption: 'unknown',
    });
  });

  it.each(['agent', 'native-child', 'unknown', 'cli-conflict'] as const)(
    '%s不能借可信wrapper改父状态或回执',
    (kind) => {
      const s = fixture();
      if (kind === 'native-child')
        codexSourceFixture(
          s.dir,
          s.sid,
          {
            subagent: { thread_spawn: { parent_thread_id: 'ancestor', depth: 1, agent_path: '/root/child' } },
          },
          'ancestor',
        );
      if (kind === 'unknown') codexSourceFixture(s.dir, s.sid, 'unknown-source');
      const parent = readFileSync(s.file);
      const state = readFileSync(s.stateFile);
      for (const hook of hooks) {
        const r = s.run(
          hook,
          { turn_id: 'child-turn', ...(kind === 'agent' ? { agent_id: 'child' } : {}) },
          kind === 'cli-conflict' ? { CLAUDE_CODE_SESSION_ID: 'different-cli' } : {},
        );
        if (r.stdout) expect(JSON.parse(r.stdout).decision).not.toBe('block');
      }
      expect(readFileSync(s.file)).toEqual(parent);
      expect(readFileSync(s.stateFile)).toEqual(state);
      const pool = join(s.dir, '.receipts', `${'0'.repeat(64)}.latest-v2`);
      expect(existsSync(pool)).toBe(true);
      const rows = [JSON.parse(readFileSync(pool, 'utf8'))];
      expect(
        rows.every(
          (r) => r.authority === (kind === 'unknown' || kind === 'cli-conflict' ? 'unknown' : 'machine'),
        ),
      ).toBe(true);
      if (kind === 'cli-conflict')
        expect(rows.every((r) => r.receipt.cli === 'unknown' && r.receipt.turn === null)).toBe(true);
    },
  );

  it('共享Claude入口保持Claude且不把事件turn作为Codex轮次', () => {
    const s = fixture('claude');
    for (const hook of ['continuation-progress', 'stop']) {
      s.run(hook, { turn_id: 'claude-event' }, { CLAUDE_CODE_SESSION_ID: s.sid });
      expect(s.rows().findLast((r) => r.phase === 'entered')).toMatchObject({ cli: 'claude', turn: null });
    }
  });

  it('共享入口不把事件正文声明的CLI家族当可信登记', () => {
    const s = fixture('claude');
    for (const hook of ['continuation-progress', 'stop']) {
      s.run(hook, { turn_id: 'untrusted-turn', expectedCli: 'codex', cli: 'codex' });
      expect(s.rows().findLast((r) => r.phase === 'entered')).toMatchObject({ cli: 'unknown', turn: null });
    }
  });
});
