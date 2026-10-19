import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { latestRows } from '../hooks/continuation-latest.mjs';
import {
  appendReceipt,
  DIAGNOSTIC_RECEIPT_KEY,
  fingerprint,
  MAX_RECEIPT_BYTES,
  MAX_RECEIPT_FILES,
  MAX_RECEIPT_ROWS,
  observeContinuation,
  readDiagnosticReceipts,
  readLatestDiagnosticState,
  readLatestReceiptState,
  readReceipts,
  receiptContext,
  receiptStatus,
} from '../hooks/continuation-receipts.mjs';
import { main, readState, unattendedAuthority } from '../hooks/unattended.mjs';
import { runChild } from './child.ts';
import { codexSourceFixture } from './codex-source-fixture.ts';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, closeSync: vi.fn(actual.closeSync), unlinkSync: vi.fn(actual.unlinkSync) };
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(cli: 'codex' | 'claude' = 'codex') {
  const dir = mkdtempSync(join(tmpdir(), 'continuation-receipts-'));
  dirs.push(dir);
  const sid = 'receipt-session';
  const { home } = codexSourceFixture(dir, sid);
  const env = {
    ...process.env,
    FLEET_UNATTENDED_DIR: dir,
    FLEET_WORK_RUNS_DIR: join(dir, 'runs'),
    FLEET_WORKER: '',
    FLEET_HEADLESS: '',
    CLAUDE_CODE_SESSION_ID: cli === 'claude' ? sid : '',
    CODEX_THREAD_ID: cli === 'codex' ? sid : '',
    CODEX_SESSION_ID: '',
    CODEX_HOME: home,
  };
  const command = (...args: string[]) => main(args, { env, out: () => {}, err: () => {} });
  expect(command('on')).toBe(0);
  const state = () => JSON.parse(readFileSync(join(dir, `${sid}.json`), 'utf8'));
  // 构造升级前同一窗口的v1历史；真实入口随后只写v2，v1存储单测继续测旧格式合同。
  rmSync(join(dir, '.receipts', `${fingerprint(sid)}.latest-v2`));
  expect(
    appendReceipt(receiptContext(dir, { session_id: sid }, state(), 'Command', env, 'allowed'), {
      phase: 'window',
      decision: 'on',
    }),
  ).toEqual({ ok: true });
  const run = (script: string, more: object = {}, extraEnv: NodeJS.ProcessEnv = {}) =>
    runChild(process.execPath, [fileURLToPath(new URL(`../hooks/${script}.mjs`, import.meta.url))], {
      cwd: dir,
      env: { ...env, ...extraEnv },
      input: JSON.stringify({ session_id: sid, cwd: dir, ...more }),
    });
  const rows = () => {
    const r = readReceipts(dir, fingerprint(sid));
    if (!r.ok) throw Error(r.code);
    const latest = readLatestReceiptState(dir, fingerprint(sid));
    return [
      ...r.rows,
      ...(latest.ok && latest.state ? latestRows(latest.state).filter((row) => row !== null) : []),
    ];
  };
  const context = (more: object = {}, captured = state()) => {
    const input = { session_id: sid, cwd: dir, ...more };
    const authority = unattendedAuthority({
      env,
      cwd: dir,
      hookId: input.session_id,
      agentId: Reflect.get(input, 'agent_id'),
    });
    return receiptContext(dir, input, captured, 'Stop', env, authority.kind, undefined, () =>
      readState(dir, sid),
    );
  };
  const diagnostics = () => {
    const r = readDiagnosticReceipts(dir);
    if (!r.ok) throw Error(r.code);
    const latest = readLatestDiagnosticState(dir);
    return [
      ...r.rows,
      ...(latest.ok && latest.state
        ? [{ authority: latest.state.authority, receipt: latest.state.receipt }]
        : []),
    ];
  };
  const file = join(dir, '.receipts', `${fingerprint(sid)}.jsonl`);
  return { dir, sid, env, state, command, run, rows, diagnostics, context, file };
}
describe('既有钩子持久脱敏回执与真实回合关联', { timeout: 0 }, () => {
  it('真实Stop准备/写出不同阶段；同轮非新轮，下一轮来源未知，任意工具不证明消费', () => {
    const s = fixture();
    expect(JSON.parse(s.run('stop', { turn_id: 'turn-one' }).stdout).decision).toBe('block');
    const prepared = s.rows().find((r) => r.phase === 'prepared');
    const emitted = s.rows().find((r) => r.phase === 'emitted');
    if (!prepared || !emitted) throw Error('真实Stop缺准备或写出回执');
    expect(emitted.continuation).toBe(prepared.continuation);
    expect(emitted.turn).toBe(fingerprint('turn-one'));
    s.run('continuation-progress', {
      turn_id: 'turn-one',
      tool_name: 'Bash',
      tool_use_id: 'tool-a',
      tool_input: { command: 'pnpm test' },
      tool_response: { exit_code: 0 },
    });
    expect(s.rows().some((r) => r.phase === 'same_turn')).toBe(true);
    expect(s.rows().some((r) => r.phase === 'next_turn_observed')).toBe(false);
    const event = {
      turn_id: 'turn-two',
      tool_name: 'Bash',
      tool_use_id: 'tool-b',
      tool_input: { command: 'pnpm test' },
      tool_response: { exit_code: 0 },
    };
    s.run('continuation-progress', event);
    s.run('continuation-progress', event);
    expect(s.rows().filter((r) => r.phase === 'next_turn_observed')).toHaveLength(1);
    expect(s.rows().find((r) => r.phase === 'next_turn_observed')).toMatchObject({
      decision: 'source_unknown',
      originTurn: fingerprint('turn-one'),
      turn: fingerprint('turn-two'),
      source: 'unknown',
    });
    expect(receiptStatus(s.dir, s.sid, s.state().generation)).toMatchObject({
      nextTurnObserved: true,
      rootContinuation: 'unknown',
      resultConsumption: 'unknown',
    });
  });
  it('子代理共父session不认根；缺真实session不借环境；Claude缺turn明确未知', () => {
    const s = fixture();
    s.run('stop', { turn_id: 'turn-one' });
    s.run('continuation-progress', { turn_id: 'turn-child', agent_id: 'child-one' });
    expect(s.rows().some((r) => r.phase === 'next_turn_observed')).toBe(false);
    expect(s.diagnostics().find((r) => r.receipt.decision === 'subagent')).toMatchObject({
      authority: 'machine',
      receipt: { source: 'subagent', session: fingerprint(s.sid) },
    });
    s.run('continuation-progress', { session_id: null, turn_id: 'turn-two' });
    expect(s.rows().some((r) => r.phase === 'next_turn_observed')).toBe(false);
    const c = fixture('claude');
    c.run('stop');
    c.run('continuation-progress', { tool_name: 'Write', tool_response: { success: true } });
    expect(c.rows().find((r) => r.phase === 'association_unknown')).toMatchObject({
      decision: 'missing_turn',
      turn: null,
    });
  });
  it('事件session与Codex环境冲突时明确未知，不借另一会话已发请求凑关联', () => {
    const s = fixture();
    s.run('stop', { turn_id: 'turn-one' });
    s.run('continuation-progress', { session_id: 'other-session', turn_id: 'turn-two' });
    expect(s.rows().some((r) => r.phase === 'next_turn_observed')).toBe(false);
    s.run('continuation-progress', { turn_id: 'turn-two' }, { CODEX_THREAD_ID: 'different-inherited-id' });
    expect(s.rows().some((r) => r.phase === 'next_turn_observed')).toBe(false);
    expect(
      s.diagnostics().some((r) => r.receipt.phase === 'fault' && r.receipt.decision === 'identity_unknown'),
    ).toBe(true);
  });
  it('on换代保留回执，旧hook晚写不挂新窗口；legacy无generation仍未知', () => {
    const s = fixture(),
      old = s.context({ turn_id: 'old-turn' }),
      oldGeneration = s.state().generation;
    s.command('on');
    expect(s.state().generation).not.toBe(oldGeneration);
    appendReceipt(old, { phase: 'emitted', decision: 'block', continuation: fingerprint('late') });
    s.run('continuation-progress', { turn_id: 'new-turn' });
    expect(receiptStatus(s.dir, s.sid, s.state().generation)).toMatchObject({ nextTurnObserved: false });
    expect(s.rows().filter((r) => r.phase === 'window' && r.decision === 'on')).toHaveLength(2);
    const legacy = { ...s.state() };
    delete legacy.generation;
    writeFileSync(join(s.dir, `${s.sid}.json`), JSON.stringify(legacy));
    s.run('stop', { turn_id: 'legacy-turn' });
    s.run('continuation-progress', { turn_id: 'later-turn' });
    expect(
      s
        .rows()
        .filter((r) => r.generation === null)
        .some((r) => r.phase === 'next_turn_observed'),
    ).toBe(false);
  });
  it('只准备未写出不证明下一轮；结果精确key重哈希但不改旧去重', () => {
    const s = fixture();
    appendReceipt(s.context({ turn_id: 'turn-one' }), {
      phase: 'prepared',
      decision: 'block',
      continuation: fingerprint('not-written'),
    });
    s.run('continuation-progress', { turn_id: 'turn-two' });
    expect(s.rows().some((r) => r.phase === 'next_turn_observed')).toBe(false);
    const run = join(s.dir, 'runs', 'job');
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'spec.json'), JSON.stringify({ dispatcher: s.sid, issue: 3247 }));
    writeFileSync(
      join(run, 'result.json'),
      JSON.stringify({ state: 'done', issue: 3247, summary: 'private result text', attempts: 1 }),
    );
    const first = s.run('stop', { turn_id: 'result-turn' });
    expect(first.stdout).toContain('private result text');
    expect(s.rows().findLast((r) => r.phase === 'prepared')?.results).toHaveLength(1);
    expect(s.run('stop', { turn_id: 'result-turn' }).stdout).not.toContain('private result text');
    expect(readFileSync(s.file, 'utf8')).not.toContain('private result text');
    expect(receiptStatus(s.dir, s.sid, s.state().generation).resultConsumption).toBe('unknown');
  });

  it('真实stdout管道关闭只记准备/写失败，不记emitted或消费', () => {
    const s = fixture();
    const script = fileURLToPath(new URL('../hooks/stop.mjs', import.meta.url));
    const wrapper = `const{spawn}=require('node:child_process');const p=spawn(process.execPath,[${JSON.stringify(script)}],{stdio:['pipe','pipe','pipe']});p.stdout.destroy();p.stderr.resume();p.stdin.end(${JSON.stringify(JSON.stringify({ session_id: s.sid, cwd: s.dir, turn_id: 'closed-pipe-turn' }))});p.on('close',code=>console.log(JSON.stringify({code})));`;
    const r = runChild(process.execPath, ['-e', wrapper], { cwd: s.dir, env: s.env });
    expect(JSON.parse(r.stdout).code).toBe(0);
    expect(s.rows().some((row) => row.phase === 'prepared')).toBe(true);
    expect(s.rows().some((row) => row.phase === 'fault' && row.decision === 'write_failed')).toBe(true);
    expect(s.rows().some((row) => row.phase === 'emitted')).toBe(false);
  });
  it('回执目录故障不把block变放行，不泄露原始异常或工具数据', () => {
    const s = fixture();
    rmSync(join(s.dir, '.receipts'), { recursive: true });
    writeFileSync(join(s.dir, '.receipts'), 'blocked');
    const r = s.run('stop', {
      turn_id: 'turn-one',
      last_assistant_message: 'private-note',
      tool_input: { command: 'sensitive-command' },
    });
    expect(JSON.parse(r.stdout).decision).toBe('block');
    expect(r.stderr).toContain('回执没查成');
    expect(r.stderr).not.toMatch(/private-note|sensitive-command|continuation-receipts-/);
    expect(receiptStatus(s.dir, s.sid, s.state().generation)).toMatchObject({ evidence: 'unknown' });
  });
  it('关闭读取句柄失败明确未知，关联观察不抛异常或泄露原始错误', async () => {
    const s = fixture();
    s.run('stop', { turn_id: 'turn-one' });
    const context = { ...s.context({ turn_id: 'turn-two' }), event: 'PostToolUse' };
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const failClose = (fd: number) => {
      actual.closeSync(fd);
      throw Error('private-close-detail');
    };
    vi.mocked(closeSync).mockImplementationOnce(failClose);
    expect(readReceipts(s.dir, fingerprint(s.sid))).toEqual({ ok: false, code: 'IO' });
    vi.mocked(closeSync).mockImplementationOnce(failClose);
    expect(() => observeContinuation(context)).not.toThrow();
    expect(s.rows().some((row) => row.phase === 'fault' && row.decision === 'read_failed')).toBe(true);
    expect(readFileSync(s.file, 'utf8')).not.toContain('private-close-detail');
  });
  it.each(['output-close', 'lock-close', 'unlock'] as const)(
    '写后%s失败不能报追加成功，保留锁使读回明确未知',
    async (kind) => {
      const s = fixture();
      const context = s.context();
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      const failClose = (fd: number) => {
        actual.closeSync(fd);
        throw Error('private-cleanup-error');
      };
      if (kind === 'lock-close') vi.mocked(closeSync).mockImplementationOnce(actual.closeSync);
      if (kind !== 'unlock') vi.mocked(closeSync).mockImplementationOnce(failClose);
      else
        vi.mocked(unlinkSync).mockImplementationOnce(() => {
          throw Error('private-unlink-error');
        });
      expect(appendReceipt(context, { phase: 'entered', decision: 'none' })).toEqual({
        ok: false,
        code: 'IO',
      });
      expect(readReceipts(s.dir, fingerprint(s.sid))).toEqual({ ok: false, code: 'BUSY' });
      expect(readFileSync(s.file, 'utf8')).not.toContain('private-');
    },
  );
  it('真实进展入口的回执读取close失败不挡原有进展登记', () => {
    const s = fixture();
    s.run('stop', { turn_id: 'turn-one' });
    const snapshot = join(s.dir, '.receipts', `${fingerprint(s.sid)}.latest-v2`);
    const before = readFileSync(snapshot);
    const script = new URL('../hooks/continuation-progress.mjs', import.meta.url).href;
    const wrapper = `const fs=require('node:fs');const open=fs.openSync,close=fs.closeSync;let target=null;fs.openSync=(path,flags,...args)=>{const fd=open(path,flags,...args);if(String(path).endsWith('.latest-v2')&&typeof flags==='number'&&!(flags&(fs.constants.O_RDWR|fs.constants.O_WRONLY)))target=fd;return fd};fs.closeSync=fd=>{close(fd);if(fd===target){target=null;throw Error('private-close-error')}};require('node:module').syncBuiltinESMExports();import(${JSON.stringify(script)}).then(m=>m.runProgress());`;
    const r = runChild(process.execPath, ['-e', wrapper], {
      cwd: s.dir,
      env: s.env,
      input: JSON.stringify({
        session_id: s.sid,
        cwd: s.dir,
        turn_id: 'turn-two',
        tool_use_id: 'verified-tool',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' },
        tool_response: { exit_code: 0 },
      }),
    });
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('private-close-error');
    expect(readdirSync(join(s.dir, `${s.sid}.progress`))).toHaveLength(1);
    // 持续关闭失败时连故障快照也不能安全提交，明确报IO并保留原始证据。
    expect(r.stderr).toContain('IO');
    expect(readFileSync(snapshot)).toEqual(before);
  });
  it.each(['close', 'unlock'] as const)('新日志准入锁%s失败不报成功，保留日志锁明确未知', async (kind) => {
    const s = fixture();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const other = receiptContext(s.dir, { session_id: 'new-session' }, null, 'Stop', s.env, 'allowed');
    if (kind === 'close') {
      vi.mocked(closeSync)
        .mockImplementationOnce(actual.closeSync)
        .mockImplementationOnce(actual.closeSync)
        .mockImplementationOnce((fd) => {
          actual.closeSync(fd);
          throw Error('private-admission-close-error');
        });
    } else {
      vi.mocked(unlinkSync).mockImplementationOnce(() => {
        throw Error('private-admission-unlink-error');
      });
    }
    expect(appendReceipt(other, { phase: 'entered', decision: 'none' })).toEqual({ ok: false, code: 'IO' });
    expect(readReceipts(s.dir, fingerprint('new-session'))).toEqual({ ok: false, code: 'BUSY' });
    expect(existsSync(join(s.dir, '.receipts', '.admission.lock'))).toBe(true);
  });
  it('写入达到4096行时不越过可读上限，保留历史投影但覆盖耗尽仍返回LIMIT', () => {
    const s = fixture();
    const row = `${JSON.stringify(s.rows()[0])}\n`;
    writeFileSync(s.file, row.repeat(MAX_RECEIPT_ROWS - 1));
    expect(appendReceipt(s.context(), { phase: 'entered', decision: 'none' })).toEqual({ ok: true });
    expect(s.rows()).toHaveLength(MAX_RECEIPT_ROWS);
    const previous = readFileSync(s.file, 'utf8');
    expect(appendReceipt(s.context(), { phase: 'entered', decision: 'none' })).toEqual({
      ok: false,
      code: 'LIMIT',
    });
    expect(readFileSync(s.file, 'utf8')).toBe(previous);
    expect(s.rows()).toHaveLength(MAX_RECEIPT_ROWS);
    expect(receiptStatus(s.dir, s.sid, s.state().generation)).toMatchObject({
      evidence: 'observed',
      code: 'LIMIT',
      capacity: 'exhausted',
      coverage: 'unknown',
      stages: { Stop: { evidence: 'observed' } },
    });
  });
  it.each([MAX_RECEIPT_ROWS - 1, MAX_RECEIPT_ROWS, MAX_RECEIPT_ROWS + 1])(
    '真实只读CLI在%d行区分历史证据与容量，耗尽或超限非零退出',
    (count) => {
      const s = fixture();
      const context = s.context({ turn_id: 'historical-turn' });
      for (const phase of ['entered', 'prepared', 'emitted'] as const)
        expect(
          appendReceipt(context, {
            phase,
            decision: 'block',
            continuation: fingerprint('historical-request'),
          }),
        ).toEqual({ ok: true });
      for (const event of ['SessionStart', 'PostToolUse'])
        expect(appendReceipt({ ...context, event }, { phase: 'entered', decision: 'none' })).toEqual({
          ok: true,
        });
      expect(appendReceipt(context, { phase: 'fault', decision: 'write_failed' })).toEqual({ ok: true });
      const history = s.rows().map((row) => `${JSON.stringify(row)}\n`);
      const first = history[0];
      if (!first) throw Error('隔离窗口缺少初始回执');
      const raw = first.repeat(count - history.length) + history.join('');
      writeFileSync(s.file, raw);
      const stateBefore = readFileSync(join(s.dir, `${s.sid}.json`), 'utf8');
      const status = runChild(
        process.execPath,
        [fileURLToPath(new URL('../hooks/unattended.mjs', import.meta.url)), 'status', '--receipts'],
        { cwd: s.dir, env: s.env },
      );
      expect(status.status).toBe(count < MAX_RECEIPT_ROWS ? 0 : 1);
      const result = JSON.parse(status.stdout);
      expect(result).toMatchObject({
        evidence: count > MAX_RECEIPT_ROWS ? 'unknown' : 'observed',
        capacity:
          count > MAX_RECEIPT_ROWS ? 'unknown' : count === MAX_RECEIPT_ROWS ? 'exhausted' : 'available',
        coverage: 'unknown',
        rootContinuation: 'unknown',
        resultConsumption: 'unknown',
      });
      if (count >= MAX_RECEIPT_ROWS) expect(result.code).toBe('LIMIT');
      else expect(result).not.toHaveProperty('code');
      if (count <= MAX_RECEIPT_ROWS)
        expect(result).toMatchObject({
          stages: {
            SessionStart: { evidence: 'observed' },
            PostToolUse: { evidence: 'observed' },
            Stop: { evidence: 'observed' },
          },
          requestPrepared: true,
          requestEmitted: true,
          faults: [{ event: 'Stop', decision: 'write_failed' }],
        });
      else {
        expect(result).not.toHaveProperty('stages');
        expect(result).not.toHaveProperty('requestEmitted');
      }
      expect(readFileSync(s.file, 'utf8')).toBe(raw);
      expect(readFileSync(join(s.dir, `${s.sid}.json`), 'utf8')).toBe(stateBefore);
    },
  );
  it('满额只投影当前代次；新on不腾容量，也不借旧代次或其他session证明根续轮', () => {
    const s = fixture();
    expect(appendReceipt(s.context(), { phase: 'entered', decision: 'none' })).toEqual({ ok: true });
    expect(appendReceipt(s.context(), { phase: 'emitted', decision: 'block' })).toEqual({ ok: true });
    const oldGeneration = s.state().generation;
    const historical = s.rows().map((row) => `${JSON.stringify(row)}\n`);
    const first = historical[0];
    if (!first) throw Error('隔离窗口缺少初始回执');
    const raw = first.repeat(MAX_RECEIPT_ROWS - historical.length) + historical.join('');
    writeFileSync(s.file, raw);
    expect(s.command('on')).toBe(0);
    const generation = s.state().generation;
    expect(generation).not.toBe(oldGeneration);
    expect(receiptStatus(s.dir, s.sid, generation)).toMatchObject({
      evidence: 'unknown',
      capacity: 'exhausted',
      coverage: 'unknown',
      code: 'LIMIT',
      latest: null,
      stages: { Stop: { evidence: 'unknown' } },
      requestPrepared: false,
      requestEmitted: false,
      nextTurnObserved: false,
      rootContinuation: 'unknown',
      resultConsumption: 'unknown',
    });
    expect(receiptStatus(s.dir, s.sid, oldGeneration)).toMatchObject({
      evidence: 'observed',
      capacity: 'exhausted',
      code: 'LIMIT',
      stages: { Stop: { evidence: 'observed' } },
      requestEmitted: true,
    });
    expect(receiptStatus(s.dir, s.sid)).toMatchObject({ evidence: 'unknown', requestEmitted: false });
    expect(receiptStatus(s.dir, 'another-session', oldGeneration)).toMatchObject({ evidence: 'unknown' });
    expect(readFileSync(s.file, 'utf8')).toBe(raw);
  });
  it.each(['bad-shape', 'partial', 'locked'] as const)('满额但%s时不展示未验证的历史，仍只读未知', (kind) => {
    const s = fixture();
    const line = `${JSON.stringify(s.rows()[0])}\n`;
    let raw = line.repeat(MAX_RECEIPT_ROWS);
    if (kind === 'bad-shape') raw = `${line.repeat(MAX_RECEIPT_ROWS - 1)}{"private":"sensitive"}\n`;
    if (kind === 'partial') raw = raw.slice(0, -1);
    writeFileSync(s.file, raw);
    if (kind === 'locked') writeFileSync(`${s.file}.lock`, '');
    const result = receiptStatus(s.dir, s.sid, s.state().generation);
    expect(result).toMatchObject({
      evidence: 'unknown',
      capacity: 'unknown',
      coverage: 'unknown',
      rootContinuation: 'unknown',
      resultConsumption: 'unknown',
    });
    expect(result).not.toHaveProperty('stages');
    expect(readFileSync(s.file, 'utf8')).toBe(raw);
  });
  it('跨session文件数满额后不新增、不删旧历史，已有会话仍能追加，原Stop照常block', () => {
    const s = fixture();
    const root = join(s.dir, '.receipts');
    for (let i = 1; i < MAX_RECEIPT_FILES; i++) {
      writeFileSync(join(root, `${fingerprint(`other-${i}`)}.jsonl`), '');
    }
    const other = receiptContext(s.dir, { session_id: 'new-session' }, null, 'Stop', s.env, 'allowed');
    expect(appendReceipt(other, { phase: 'entered', decision: 'none' })).toEqual({
      ok: false,
      code: 'LIMIT',
    });
    expect(existsSync(join(root, `${fingerprint('new-session')}.jsonl`))).toBe(false);
    expect(existsSync(join(root, `${fingerprint('other-1')}.jsonl`))).toBe(true);
    expect(appendReceipt(s.context(), { phase: 'entered', decision: 'none' })).toEqual({ ok: true });
    codexSourceFixture(s.dir, 'new-session');
    const r = s.run('stop', { session_id: 'new-session' }, { CODEX_THREAD_ID: 'new-session' });
    // 新session没有开关，原本应放行；容量失败不能把它误判成已开。
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('WINDOW_UNKNOWN');
    expect(JSON.parse(s.run('stop').stdout).decision).toBe('block');
  });
  it('目录准入锁占用或异常条目都明确失败，不无限扫描或当空目录', () => {
    const s = fixture();
    const root = join(s.dir, '.receipts');
    const other = receiptContext(s.dir, { session_id: 'new-session' }, null, 'Stop', s.env, 'allowed');
    writeFileSync(join(root, '.admission.lock'), '');
    expect(appendReceipt(other, { phase: 'entered', decision: 'none' })).toEqual({
      ok: false,
      code: 'EEXIST',
    });
    rmSync(join(root, '.admission.lock'));
    mkdirSync(join(root, 'unexpected-directory'));
    expect(appendReceipt(other, { phase: 'entered', decision: 'none' })).toEqual({ ok: false, code: 'IO' });
    rmdirSync(join(root, 'unexpected-directory'));
    for (let i = 0; i < MAX_RECEIPT_FILES * 2 + 3; i++) {
      writeFileSync(join(root, `${fingerprint(`orphan-${i}`)}.jsonl.lock`), '');
    }
    expect(appendReceipt(other, { phase: 'entered', decision: 'none' })).toEqual({
      ok: false,
      code: 'LIMIT',
    });
  });
  it.each(['partial', 'oversize', 'bad-shape', 'locked'] as const)(
    '%s不会被读为空或绿，满额不轮转丢历史',
    (kind) => {
      const s = fixture();
      if (kind === 'partial') writeFileSync(s.file, '{"broken":');
      if (kind === 'oversize') writeFileSync(s.file, Buffer.alloc(MAX_RECEIPT_BYTES, 32));
      if (kind === 'bad-shape') writeFileSync(s.file, '{"private":"sensitive"}\n');
      if (kind === 'locked') writeFileSync(`${s.file}.lock`, '');
      const r = readReceipts(s.dir, fingerprint(s.sid));
      expect(r.ok).toBe(false);
      expect(receiptStatus(s.dir, s.sid, s.state().generation)).toMatchObject({ evidence: 'unknown' });
      if (kind === 'oversize') {
        expect(appendReceipt(s.context(), { phase: 'entered', decision: 'none' }).ok).toBe(false);
        expect(statSync(s.file).size).toBe(MAX_RECEIPT_BYTES);
      }
    },
  );
  it('拒绝receipts目录junction/symlink以及日志非普通文件', () => {
    const s = fixture(),
      outside = mkdtempSync(join(tmpdir(), 'receipts-outside-'));
    dirs.push(outside);
    rmSync(join(s.dir, '.receipts'), { recursive: true });
    symlinkSync(outside, join(s.dir, '.receipts'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(appendReceipt(s.context(), { phase: 'entered', decision: 'none' }).ok).toBe(false);
    expect(readReceipts(s.dir, fingerprint(s.sid)).ok).toBe(false);
    rmSync(join(s.dir, '.receipts'));
    mkdirSync(join(s.dir, '.receipts'));
    mkdirSync(s.file);
    expect(appendReceipt(s.context(), { phase: 'entered', decision: 'none' }).ok).toBe(false);
    rmSync(s.file, { recursive: true });
    const target = join(outside, 'not-a-receipt');
    writeFileSync(target, 'private-linked-data');
    symlinkSync(target, s.file, 'file');
    expect(appendReceipt(s.context(), { phase: 'entered', decision: 'none' }).ok).toBe(false);
    expect(readReceipts(s.dir, fingerprint(s.sid)).ok).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('private-linked-data');
  });

  it('读取行数有界，未知字段不能进入白名单回执；同轮不同工具均留真实事件指纹', () => {
    const s = fixture();
    s.run('continuation-progress', { turn_id: 'turn-one', tool_use_id: 'tool-a' });
    s.run('continuation-progress', { turn_id: 'turn-one', tool_use_id: 'tool-b' });
    expect(
      s
        .rows()
        .filter((r) => r.event === 'PostToolUse' && r.phase === 'entered')
        .map((r) => r.eventKey),
    ).toEqual([fingerprint('tool-b')]);
    const row = s.rows()[0];
    writeFileSync(s.file, `${JSON.stringify({ ...row, tool_input: 'private' })}\n`);
    expect(readReceipts(s.dir, fingerprint(s.sid)).ok).toBe(false);
    writeFileSync(s.file, `${JSON.stringify(row)}\n`.repeat(4097));
    expect(readReceipts(s.dir, fingerprint(s.sid))).toMatchObject({ ok: false, code: 'LIMIT' });
  });
  it('off/done/needs-you/到期/机器豁免如实记录且不改变开关和防空转', () => {
    const s = fixture();
    s.run('stop', { agent_id: 'child' });
    s.run('stop', {}, { FLEET_HEADLESS: '1' });
    expect(s.state().totalBlocks).toBe(0);
    s.command('needs-you', 'private reason');
    expect(s.run('stop').stdout).toBe('');
    s.command('on');
    s.command('done', 'private done');
    expect(s.run('stop').stdout).toBe('');
    s.command('off');
    expect(s.run('stop').stdout).toBe('');
    expect(s.run('stop').stdout).toBe('');
    s.command('on');
    const state = { ...s.state(), expiresAt: '2000-01-01T00:00:00.000Z' };
    writeFileSync(join(s.dir, `${s.sid}.json`), JSON.stringify(state));
    s.run('stop');
    expect(readState(s.dir, s.sid)).toMatchObject({ ok: true, state: null });
    const raw = readFileSync(s.file, 'utf8');
    expect(raw).not.toMatch(/private reason|private done|receipt-session|child/);
  });
  it('读不到或无执行回执的只读status明确未知；坏状态不冒充回执正常', () => {
    const s = fixture();
    rmSync(join(s.dir, '.receipts'), { recursive: true });
    const r = s.run('unattended');
    expect(r.status).toBe(2);
    expect(receiptStatus(s.dir, s.sid, s.state().generation)).toMatchObject({
      evidence: 'unknown',
      rootContinuation: 'unknown',
      resultConsumption: 'unknown',
    });
    writeFileSync(join(s.dir, `${s.sid}.json`), '{broken');
    const status = runChild(
      process.execPath,
      [fileURLToPath(new URL('../hooks/unattended.mjs', import.meta.url)), 'status', '--receipts'],
      { cwd: s.dir, env: s.env },
    );
    expect(status.status).toBe(1);
    expect(JSON.parse(status.stdout)).toEqual({ evidence: 'unknown', code: 'STATE_UNKNOWN' });
  });

  it('非根池与根历史逐行格式隔离，默认unknown不借池名改写事件身份', () => {
    const s = fixture();
    const parent = readFileSync(s.file);
    const context = receiptContext(s.dir, { session_id: s.sid }, null, 'PostToolUse', s.env);
    expect(context.authority).toBe('unknown');
    expect(appendReceipt(context, { phase: 'fault', decision: 'identity_unknown' })).toEqual({ ok: true });
    expect(s.diagnostics()).toMatchObject([
      { authority: 'unknown', receipt: { session: fingerprint(s.sid), source: 'unknown', agent: null } },
    ]);
    expect(readReceipts(s.dir, DIAGNOSTIC_RECEIPT_KEY).ok).toBe(false);
    expect(readFileSync(s.file)).toEqual(parent);
    observeContinuation({ ...s.context(), authority: 'machine' });
    expect(readFileSync(s.file)).toEqual(parent);
    // 把池格式塞进根文件也不能通过旧session验证。
    const pool = join(s.dir, '.receipts', `${DIAGNOSTIC_RECEIPT_KEY}.jsonl`);
    writeFileSync(s.file, readFileSync(pool));
    expect(readReceipts(s.dir, fingerprint(s.sid)).ok).toBe(false);
  });

  it('根恰好落入保留键时安全拒绝，已有池和原会话历史均不接管', () => {
    const s = fixture();
    const context = { ...s.context(), authority: 'machine' as const };
    expect(appendReceipt(context, { phase: 'bypass', decision: 'machine' })).toEqual({ ok: true });
    const pool = join(s.dir, '.receipts', `${DIAGNOSTIC_RECEIPT_KEY}.jsonl`);
    const poolBefore = readFileSync(pool);
    const parentBefore = readFileSync(s.file);
    expect(
      appendReceipt(
        { ...s.context(), session: DIAGNOSTIC_RECEIPT_KEY },
        { phase: 'entered', decision: 'none' },
      ),
    ).toEqual({ ok: false, code: 'CONFLICT' });
    expect(readFileSync(pool)).toEqual(poolBefore);
    expect(readFileSync(s.file)).toEqual(parentBefore);
    expect(s.diagnostics()).toHaveLength(1);
  });

  it.each(['authority', 'envelope', 'receipt'] as const)(
    '诊断%s异常时严格拒绝，不把混合文件当根或绿',
    (kind) => {
      const s = fixture();
      const context = { ...s.context(), authority: 'machine' as const };
      expect(appendReceipt(context, { phase: 'bypass', decision: 'machine' })).toEqual({ ok: true });
      const row = s.diagnostics()[0];
      if (!row) throw Error('缺诊断行');
      const bad =
        kind === 'authority'
          ? { ...row, authority: 'allowed' }
          : kind === 'envelope'
            ? { ...row, private: 'canary' }
            : { ...row, receipt: { ...row.receipt, private: 'canary' } };
      const pool = join(s.dir, '.receipts', `${DIAGNOSTIC_RECEIPT_KEY}.jsonl`);
      const raw = `${JSON.stringify(bad)}\n`;
      writeFileSync(pool, raw);
      expect(readDiagnosticReceipts(s.dir)).toEqual({ ok: false, code: 'CONFLICT' });
      expect(appendReceipt(context, { phase: 'entered', decision: 'none' })).toEqual({
        ok: false,
        code: 'CONFLICT',
      });
      expect(readFileSync(pool, 'utf8')).toBe(raw);
    },
  );

  it('诊断池仍有2MiB上限和链接保护，不追加或修改链接目标', () => {
    const s = fixture();
    const context = { ...s.context(), authority: 'machine' as const };
    const pool = join(s.dir, '.receipts', `${DIAGNOSTIC_RECEIPT_KEY}.jsonl`);
    writeFileSync(pool, Buffer.alloc(MAX_RECEIPT_BYTES, 32));
    expect(readDiagnosticReceipts(s.dir)).toMatchObject({ ok: false, code: 'LIMIT' });
    expect(appendReceipt(context, { phase: 'entered', decision: 'none' })).toMatchObject({
      ok: false,
      code: 'LIMIT',
    });
    expect(statSync(pool).size).toBe(MAX_RECEIPT_BYTES);
    unlinkSync(pool);
    const target = join(s.dir, 'outside-diagnostic');
    writeFileSync(target, 'private-linked-history');
    symlinkSync(target, pool, 'file');
    expect(readDiagnosticReceipts(s.dir).ok).toBe(false);
    expect(appendReceipt(context, { phase: 'entered', decision: 'none' }).ok).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('private-linked-history');
  });

  it('诊断池读写close失败同样未知，未确认关闭时留锁而原根仍可读写', async () => {
    const s = fixture();
    const context = { ...s.context(), authority: 'machine' as const };
    expect(appendReceipt(context, { phase: 'entered', decision: 'none' })).toEqual({ ok: true });
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const fail = (fd: number) => {
      actual.closeSync(fd);
      throw Error('private-close-canary');
    };
    vi.mocked(closeSync).mockImplementationOnce(fail);
    expect(readDiagnosticReceipts(s.dir)).toEqual({ ok: false, code: 'IO' });
    vi.mocked(closeSync).mockImplementationOnce(fail);
    expect(appendReceipt(context, { phase: 'entered', decision: 'none' })).toEqual({ ok: false, code: 'IO' });
    expect(readDiagnosticReceipts(s.dir)).toEqual({ ok: false, code: 'BUSY' });
    expect(appendReceipt(s.context(), { phase: 'entered', decision: 'none' })).toEqual({ ok: true });
    expect(readReceipts(s.dir, fingerprint(s.sid)).ok).toBe(true);
  });
});
