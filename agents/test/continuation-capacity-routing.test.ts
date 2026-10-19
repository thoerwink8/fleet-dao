// 只用临时来源/状态。修前可将同一文件置于官方 baseline 树运行：不依赖新增导出才能收集用例。
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendReceipt,
  fingerprint,
  MAX_RECEIPT_FILES,
  MAX_RECEIPT_ROWS,
  readLatestDiagnosticState,
  readLatestReceiptState,
  receiptContext,
} from '../hooks/continuation-receipts.mjs';
import { runChild } from './child.ts';
import { codexSourceFixture } from './codex-source-fixture.ts';
import { interactiveHookEnv } from './hook-env.ts';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const poolKey = '0'.repeat(64);
function fixture(cli: 'codex' | 'claude' = 'codex') {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-capacity-'));
  made.push(dir);
  const sid = 'capacity-root';
  const { home } = codexSourceFixture(dir, sid);
  const env = {
    ...interactiveHookEnv(),
    CODEX_THREAD_ID: cli === 'codex' ? sid : '',
    CLAUDE_CODE_SESSION_ID: cli === 'claude' ? sid : '',
    CODEX_HOME: home,
    FLEET_UNATTENDED_DIR: dir,
    FLEET_WORK_RUNS_DIR: join(dir, 'runs'),
  };
  const command = (...args: string[]) =>
    runChild(
      process.execPath,
      [fileURLToPath(new URL('../hooks/unattended.mjs', import.meta.url)), ...args],
      { cwd: dir, env },
    );
  expect(command('on').status).toBe(0);
  const stateFile = join(dir, `${sid}.json`);
  const root = join(dir, '.receipts');
  const parentFile = join(root, `${fingerprint(sid)}.jsonl`);
  const pool = join(root, `${poolKey}.jsonl`);
  const diagnosticFile = join(root, `${poolKey}.latest-v2`);
  // 升级前v1历史原位保留；后续真实入口不追加这些文件。
  rmSync(join(root, `${fingerprint(sid)}.latest-v2`));
  const captured = JSON.parse(readFileSync(stateFile, 'utf8'));
  expect(
    appendReceipt(receiptContext(dir, { session_id: sid }, captured, 'Command', env, 'allowed'), {
      phase: 'window',
      decision: 'on',
    }),
  ).toEqual({ ok: true });
  const run = (script: string, more: object = {}, extra: NodeJS.ProcessEnv = {}, raw?: string) =>
    runChild(process.execPath, [fileURLToPath(new URL(`../hooks/${script}.mjs`, import.meta.url))], {
      cwd: dir,
      env: { ...env, ...extra },
      input: raw ?? JSON.stringify({ session_id: sid, cwd: dir, ...more }),
    });
  const context = (session: string, authority: 'allowed' | 'machine' | 'unknown' = 'machine') =>
    receiptContext(dir, { session_id: session }, null, 'PostToolUse', env, authority);
  const legacyDiagnostics = () =>
    existsSync(pool)
      ? readFileSync(pool, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  const diagnostics = () => {
    const read = readLatestDiagnosticState(dir);
    if (!read.ok) throw Error(read.code);
    return [...legacyDiagnostics(), ...(read.state ? [read.state] : [])];
  };
  return {
    dir,
    sid,
    env,
    root,
    parentFile,
    pool,
    diagnosticFile,
    stateFile,
    run,
    command,
    context,
    diagnostics,
    legacyDiagnostics,
  };
}

describe('非根回执容量隔离，原权威来源与原业务不变', { timeout: 0 }, () => {
  it.each(['agent', 'headless', 'worker'] as const)('Claude共有进展/Stop入口的%s同样不占父日志', (kind) => {
    const s = fixture('claude');
    const parent = readFileSync(s.parentFile);
    const state = readFileSync(s.stateFile);
    const more = kind === 'agent' ? { agent_id: 'claude-child' } : {};
    const extra =
      kind === 'headless' ? { FLEET_HEADLESS: '1' } : kind === 'worker' ? { FLEET_WORKER: '1' } : {};
    for (const script of ['continuation-progress', 'stop']) {
      const r = s.run(script, more, extra);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(s.diagnostics().at(-1)).toMatchObject({
        authority: 'machine',
        receipt: { cli: 'claude', event: script === 'stop' ? 'Stop' : 'PostToolUse', phase: 'bypass' },
      });
    }
    expect(readFileSync(s.parentFile)).toEqual(parent);
    expect(readFileSync(s.stateFile)).toEqual(state);
    expect(s.diagnostics()).toHaveLength(1);
  });

  it.each(['agent', 'native-child', 'headless', 'worker', 'unknown'] as const)(
    '真实三个入口的%s不增长父日志，保留实际判定和subject',
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
      if (kind === 'unknown') codexSourceFixture(s.dir, s.sid, 'unrecognized-source');
      const before = readFileSync(s.parentFile);
      const state = readFileSync(s.stateFile);
      const input = {
        ...(kind === 'agent' ? { agent_id: 'child-agent' } : {}),
        turn_id: 'child-turn',
        tool_input: { command: 'private-command-canary' },
        tool_response: { text: 'private-output-canary' },
      };
      const extra =
        kind === 'headless' ? { FLEET_HEADLESS: '1' } : kind === 'worker' ? { FLEET_WORKER: '1' } : {};
      for (const script of ['continuation-start', 'continuation-progress-codex', 'stop-codex']) {
        const r = s.run(script, input, extra);
        expect(r.status).toBe(0);
        if (r.stdout) expect(JSON.parse(r.stdout).decision).not.toBe('block');
        const row = s.diagnostics().at(-1);
        expect(row).toMatchObject({
          authority: kind === 'unknown' ? 'unknown' : 'machine',
          receipt: {
            event:
              script === 'continuation-start'
                ? 'SessionStart'
                : script === 'stop-codex'
                  ? 'Stop'
                  : 'PostToolUse',
            phase: kind === 'unknown' ? 'fault' : 'bypass',
            session: fingerprint(s.sid),
            generation: null,
          },
        });
      }
      expect(readFileSync(s.parentFile)).toEqual(before);
      expect(readFileSync(s.stateFile)).toEqual(state);
      const rows = s.diagnostics();
      expect(rows).toHaveLength(1);
      expect(rows.every((r) => r.authority === (kind === 'unknown' ? 'unknown' : 'machine'))).toBe(true);
      expect(
        rows.every(
          (r) =>
            r.receipt.session === fingerprint(s.sid) &&
            r.receipt.session !== poolKey &&
            r.receipt.generation === null,
        ),
      ).toBe(true);
      expect(rows.filter((r) => r.receipt.phase === (kind === 'unknown' ? 'fault' : 'bypass'))).toHaveLength(
        1,
      );
      expect(readFileSync(s.diagnosticFile, 'utf8')).not.toMatch(
        /private-command-canary|private-output-canary|capacity-root|child-agent/,
      );
    },
  );

  it('无可用上下文的catch故障进入unknown诊断，根日志与旧unbound历史零改', () => {
    const s = fixture();
    const unbound = join(s.root, 'unbound.jsonl');
    writeFileSync(unbound, 'legacy-unbound-history\n');
    const parent = readFileSync(s.parentFile);
    const r = s.run('continuation-progress-codex', {}, {}, '{broken');
    expect(r.status).toBe(0);
    expect(readFileSync(s.parentFile)).toEqual(parent);
    expect(readFileSync(unbound, 'utf8')).toBe('legacy-unbound-history\n');
    expect(s.diagnostics()).toMatchObject([
      {
        authority: 'unknown',
        receipt: { session: null, generation: null, phase: 'fault', decision: 'invalid_input' },
      },
    ]);
  });

  it('旧writer仍按旧池追加；新入口保持旧文件不变，最新Stop进入v2', () => {
    const s = fixture();
    const before = readFileSync(s.parentFile);
    for (let i = 0; i <= MAX_RECEIPT_FILES; i++)
      expect(appendReceipt(s.context(`child-${i}`), { phase: 'bypass', decision: 'machine' })).toEqual({
        ok: true,
      });
    expect(readFileSync(s.parentFile)).toEqual(before);
    expect(readdirSync(s.root).filter((name) => name.endsWith('.jsonl'))).toHaveLength(2);
    expect(new Set(s.legacyDiagnostics().map((r) => r.receipt.session)).size).toBe(MAX_RECEIPT_FILES + 1);
    // 同一个目录中已有新池，旧准入识别的受管名字不使合法新根创建变成IO。
    expect(
      appendReceipt(s.context('second-root', 'allowed'), { phase: 'entered', decision: 'none' }),
    ).toEqual({ ok: true });
    expect(s.command('off').status).toBe(0);
    expect(s.command('on').status).toBe(0);
    expect(JSON.parse(s.run('stop-codex', { turn_id: 'root-turn' }).stdout).decision).toBe('block');
    const rootRows = readFileSync(s.parentFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(readFileSync(s.parentFile)).toEqual(before);
    const latest = readLatestReceiptState(s.dir, fingerprint(s.sid));
    expect(latest).toMatchObject({
      ok: true,
      state: { pending: { emitted: { event: 'Stop', phase: 'emitted' } } },
    });
    expect(rootRows.every((r) => r.session === fingerprint(s.sid))).toBe(true);
  });

  it('父文件旧满额仍只读LIMIT；非根能留诊断但不恢复父文件追加', () => {
    const s = fixture();
    const full = readFileSync(s.parentFile, 'utf8').repeat(MAX_RECEIPT_ROWS);
    writeFileSync(s.parentFile, full);
    expect(s.run('continuation-progress-codex', { agent_id: 'child' }).status).toBe(0);
    expect(s.diagnostics().some((r) => r.receipt.decision === 'subagent')).toBe(true);
    expect(appendReceipt(s.context(s.sid, 'allowed'), { phase: 'entered', decision: 'none' })).toEqual({
      ok: false,
      code: 'LIMIT',
    });
    const status = s.command('status', '--receipts');
    expect(status.status).toBe(1);
    expect(JSON.parse(status.stdout)).toMatchObject({
      capacity: 'exhausted',
      coverage: 'unknown',
      code: 'LIMIT',
      rootContinuation: 'unknown',
      resultConsumption: 'unknown',
    });
    expect(readFileSync(s.parentFile, 'utf8')).toBe(full);
  });

  it('池自身4096行仍拒绝追加、不删历史，父正常Stop继续block', () => {
    const s = fixture();
    expect(appendReceipt(s.context('child'), { phase: 'bypass', decision: 'machine' })).toEqual({ ok: true });
    const full = readFileSync(s.pool, 'utf8').repeat(MAX_RECEIPT_ROWS);
    writeFileSync(s.pool, full);
    expect(appendReceipt(s.context('another-child'), { phase: 'entered', decision: 'none' })).toEqual({
      ok: false,
      code: 'LIMIT',
    });
    expect(readFileSync(s.pool, 'utf8')).toBe(full);
    const r = s.run('stop-codex', { turn_id: 'root-turn' });
    expect(JSON.parse(r.stdout).decision).toBe('block');
  });

  it('原128份目录满不为诊断清历史，新池准入失败也不改业务豁免', () => {
    const s = fixture();
    for (let i = 1; i < MAX_RECEIPT_FILES; i++)
      writeFileSync(join(s.root, `${fingerprint(`old-${i}`)}.jsonl`), 'old\n');
    const before = readFileSync(s.parentFile);
    const r = s.run('stop-codex', { agent_id: 'child' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('LIMIT');
    expect(existsSync(s.pool)).toBe(false);
    expect(readdirSync(s.root)).toHaveLength(MAX_RECEIPT_FILES);
    expect(readFileSync(s.parentFile)).toEqual(before);
  });

  it.each(['legacy-root', 'empty', 'partial', 'locked', 'directory'] as const)(
    '池路径已有%s时拒绝，原内容和根日志不变',
    (kind) => {
      const s = fixture();
      const original =
        kind === 'legacy-root'
          ? `${JSON.stringify({ ...JSON.parse(readFileSync(s.parentFile, 'utf8').trim()), session: poolKey })}\n`
          : kind === 'partial'
            ? '{"version":'
            : '';
      if (kind === 'directory') mkdirSync(s.pool);
      else writeFileSync(s.pool, original);
      if (kind === 'locked') writeFileSync(`${s.pool}.lock`, '');
      const parent = readFileSync(s.parentFile);
      expect(appendReceipt(s.context('child'), { phase: 'entered', decision: 'none' }).ok).toBe(false);
      if (kind !== 'directory') expect(readFileSync(s.pool, 'utf8')).toBe(original);
      expect(readFileSync(s.parentFile)).toEqual(parent);
    },
  );
});
