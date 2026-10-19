import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { latestBudget, latestRows, MAX_LATEST_BYTES, reduceLatest } from '../hooks/continuation-latest.mjs';
import {
  appendReceipt,
  fingerprint,
  MAX_RECEIPT_ROWS,
  noteReceipt,
  observeContinuation,
  readLatestDiagnosticState,
  readLatestReceiptState,
  readReceipts,
  receiptContext,
  receiptStatus,
} from '../hooks/continuation-receipts.mjs';
import { main, readState } from '../hooks/unattended.mjs';
import { runChild } from './child.ts';
import { codexSourceFixture } from './codex-source-fixture.ts';
import { interactiveHookEnv } from './hook-env.ts';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    closeSync: vi.fn(fs.closeSync),
    fsyncSync: vi.fn(fs.fsyncSync),
    renameSync: vi.fn(fs.renameSync),
    opendirSync: vi.fn(fs.opendirSync),
    unlinkSync: vi.fn(fs.unlinkSync),
    openSync: vi.fn(fs.openSync),
    lstatSync: vi.fn(fs.lstatSync),
  };
});
const made: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of made.splice(0)) {
    const target = resolve(path),
      base = resolve(tmpdir()),
      rel = relative(base, target);
    if (
      !rel ||
      isAbsolute(rel) ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      rel.includes(sep) ||
      !basename(target).startsWith('latest-receipt-')
    )
      throw Error('unsafe generated cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});
function fixture(cli: 'codex' | 'claude' = 'codex', full = false) {
  const dir = mkdtempSync(join(tmpdir(), 'latest-receipt-'));
  made.push(dir);
  const sid = 'isolated-latest-root';
  const { home } = codexSourceFixture(dir, sid);
  const env = {
    ...interactiveHookEnv(),
    CODEX_HOME: home,
    FLEET_UNATTENDED_DIR: dir,
    FLEET_WORK_RUNS_DIR: join(dir, 'runs'),
    ...(cli === 'codex' ? { CODEX_THREAD_ID: sid } : { CLAUDE_CODE_SESSION_ID: sid }),
  };
  const legacy = receiptContext(
    dir,
    { session_id: sid },
    { generation: 'legacy-window' },
    'Command',
    env,
    'allowed',
  );
  expect(appendReceipt(legacy, { phase: 'window', decision: 'on' })).toEqual({ ok: true });
  const root = join(dir, '.receipts');
  const oldFile = join(root, `${fingerprint(sid)}.jsonl`);
  if (full) writeFileSync(oldFile, readFileSync(oldFile, 'utf8').repeat(MAX_RECEIPT_ROWS));
  const oldBytes = readFileSync(oldFile);
  const command = (...args: string[]) => main(args, { env, out: () => {}, err: () => {} });
  expect(command('on')).toBe(0);
  const stateFile = join(dir, `${sid}.json`);
  const state = () => JSON.parse(readFileSync(stateFile, 'utf8'));
  const current = join(root, `${fingerprint(sid)}.latest-v2`);
  const next = join(root, `${fingerprint(sid)}.next-v2`);
  const read = () => {
    const r = readLatestReceiptState(dir, fingerprint(sid));
    if (!r.ok || !r.state) throw Error(r.ok ? 'missing' : r.code);
    return r.state;
  };
  const context = (event = 'PostToolUse', more: object = {}, captured = state()) =>
    receiptContext(
      dir,
      { session_id: sid, turn_id: 'turn-a', ...more },
      captured,
      event,
      env,
      'allowed',
      undefined,
      () => readState(dir, sid),
    );
  const run = (hook: string, input: object = {}, extra: NodeJS.ProcessEnv = {}) =>
    runChild(process.execPath, [fileURLToPath(new URL(`../hooks/${hook}.mjs`, import.meta.url))], {
      cwd: dir,
      env: { ...env, ...extra },
      input: JSON.stringify({ session_id: sid, cwd: dir, ...input }),
    });
  const advance = (blocks: number) =>
    writeFileSync(stateFile, JSON.stringify({ ...state(), totalBlocks: blocks }));
  return {
    dir,
    sid,
    env,
    root,
    oldFile,
    oldBytes,
    command,
    stateFile,
    state,
    current,
    next,
    read,
    context,
    run,
    advance,
  };
}
function emit(s: ReturnType<typeof fixture>, continuation = 'request-a') {
  const c = s.context('Stop');
  expect(noteReceipt(c, { phase: 'entered', decision: 'none' })).toEqual({ ok: true });
  expect(
    noteReceipt(c, { phase: 'prepared', decision: 'block', continuation: fingerprint(continuation) }),
  ).toEqual({ ok: true });
  expect(
    noteReceipt(c, { phase: 'emitted', decision: 'block', continuation: fingerprint(continuation) }),
  ).toEqual({ ok: true });
  return c;
}
describe('根有界最新状态与v1历史分开记账', { timeout: 0 }, () => {
  it.each(['codex', 'claude'] as const)('%s真实入口在旧4096行满额后仍保留Stop/关联，旧hash不动', (cli) => {
    const s = fixture(cli, true);
    const stop = s.run(cli === 'codex' ? 'stop-codex' : 'stop', { turn_id: 'turn-a' });
    expect(stop.status).toBe(0);
    expect(JSON.parse(stop.stdout).decision).toBe('block');
    expect(s.read().stop?.prepared?.continuation).toBe(s.read().pending?.emitted.continuation);
    expect(s.read().pending?.emitted.phase).toBe('emitted');
    expect(
      s.run(cli === 'codex' ? 'continuation-progress-codex' : 'continuation-progress', { turn_id: 'turn-b' })
        .status,
    ).toBe(0);
    expect(s.read().association?.observation.phase).toBe(
      cli === 'codex' ? 'next_turn_observed' : 'association_unknown',
    );
    expect(receiptStatus(s.dir, s.sid, s.state().generation)).toMatchObject({
      capacity: 'exhausted',
      code: 'LIMIT',
      coverage: 'unknown',
      rootContinuation: 'unknown',
      resultConsumption: 'unknown',
      latestState: { evidence: 'observed', retention: 'replaceable_latest_state', unknownLoss: 'unknown' },
    });
    expect(readReceipts(s.dir, fingerprint(s.sid))).toMatchObject({ ok: true, rows: expect.any(Array) });
    expect(readFileSync(s.oldFile)).toEqual(s.oldBytes);
  });
  it('10000次纯协议合并后仍保留关键事实，100次持久更新不增长文件数', () => {
    const s = fixture();
    emit(s);
    const c = s.context();
    let state = s.read();
    if (!state.pending) throw Error('missing emitted request');
    const row = {
      ...state.pending.emitted,
      event: 'PostToolUse',
      phase: 'entered',
      decision: 'none',
      continuation: null,
    };
    for (let i = 0; i < 10000; i++) {
      const next = reduceLatest(state, c, row);
      if (!next.ok) throw Error(next.code);
      state = next.state;
    }
    expect(state.pending?.emitted.continuation).toBe(fingerprint('request-a'));
    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(MAX_LATEST_BYTES);
    for (let i = 0; i < 100; i++)
      expect(noteReceipt(c, { phase: 'entered', decision: 'none' })).toEqual({ ok: true });
    expect(readdirSync(s.root).sort()).toEqual([basename(s.oldFile), basename(s.current)].sort());
    expect(readFileSync(s.oldFile)).toEqual(s.oldBytes);
    expect(s.read()).toMatchObject({
      coverage: 'unknown',
      unknownLoss: 'unknown',
      resultConsumption: 'unknown',
    });
  });
  it('prepared新尝试保留pending；同floor旧entered、旧attempt late emitted均拒绝', () => {
    const s = fixture();
    const old = emit(s);
    s.advance(1);
    const newer = s.context('Stop');
    expect(noteReceipt(newer, { phase: 'entered', decision: 'none' })).toEqual({ ok: true });
    expect(
      noteReceipt(newer, { phase: 'prepared', decision: 'block', continuation: fingerprint('request-b') }),
    ).toEqual({ ok: true });
    expect(s.read().pending?.emitted.continuation).toBe(fingerprint('request-a'));
    const sameFloor = s.context('Stop');
    const bytes = readFileSync(s.current);
    expect(noteReceipt(sameFloor, { phase: 'entered', decision: 'none' })).toEqual({
      ok: false,
      code: 'ORDER_UNKNOWN',
    });
    expect(
      noteReceipt(old, { phase: 'emitted', decision: 'block', continuation: fingerprint('request-a') }),
    ).toEqual({ ok: false, code: 'STALE' });
    expect(readFileSync(s.current)).toEqual(bytes);
    expect(
      noteReceipt(newer, { phase: 'emitted', decision: 'block', continuation: fingerprint('request-b') }),
    ).toEqual({ ok: true });
    expect(s.read().knownPendingReplacements).toBe(1);
    expect(
      noteReceipt(newer, { phase: 'prepared', decision: 'block', continuation: fingerprint('request-b') }),
    ).toEqual({ ok: false, code: 'STALE_STAGE' });
    expect(s.read().stop?.emitted?.continuation).toBe(fingerprint('request-b'));
  });
  it('关联原证据不因后续普通工具/缺turn降级，消费未知独立保留', () => {
    const s = fixture();
    emit(s);
    observeContinuation(s.context('PostToolUse', { turn_id: 'turn-a' }));
    expect(s.read().association?.observation.phase).toBe('same_turn');
    observeContinuation(s.context('PostToolUse', { turn_id: 'turn-b' }));
    const association = s.read().association;
    observeContinuation(s.context('PostToolUse', { turn_id: undefined }));
    expect(s.read().association).toEqual(association);
    expect(association?.origin.turn).toBe(fingerprint('turn-a'));
    expect(association?.observation.turn).toBe(fingerprint('turn-b'));
    expect(receiptStatus(s.dir, s.sid, s.state().generation)).toMatchObject({
      nextTurnObserved: true,
      resultConsumption: 'unknown',
      rootContinuation: 'unknown',
    });
  });
  it('同attempt的final与fault不会被迟到entered/prepared/emitted降级', () => {
    const s = fixture(),
      c = s.context('Stop');
    expect(noteReceipt(c, { phase: 'entered', decision: 'none' })).toEqual({ ok: true });
    expect(noteReceipt(c, { phase: 'fault', decision: 'results_unknown' })).toEqual({ ok: true });
    const fault = s.read().stop?.fault;
    expect(noteReceipt(c, { phase: 'entered', decision: 'none' })).toEqual({
      ok: false,
      code: 'STALE_STAGE',
    });
    expect(s.read().stop?.fault).toEqual(fault);
    // 真实分支中allow之后立即退出；协议仍拒绝迟到阶段，不能依赖调用者永不乱序。
    expect(noteReceipt(c, { phase: 'allow', decision: 'not_on' })).toEqual({ ok: true });
    const final = s.read().stop?.final;
    for (const phase of ['entered', 'prepared', 'emitted'])
      expect(
        noteReceipt(c, {
          phase,
          decision: phase === 'entered' ? 'none' : 'block',
          continuation: fingerprint('late'),
        }),
      ).toEqual({ ok: false, code: 'STALE_STAGE' });
    expect(noteReceipt(c, { phase: 'fault', decision: 'read_failed' })).toEqual({ ok: true });
    expect(s.read().stop?.final).toEqual(final);
    expect(s.read().pending).toBe(null);
    s.advance(1);
    const sent = emit(s, 'sent');
    const emitted = s.read().stop?.emitted;
    expect(noteReceipt(sent, { phase: 'allow', decision: 'not_on' })).toEqual({
      ok: false,
      code: 'STALE_STAGE',
    });
    expect(s.read().stop?.emitted).toEqual(emitted);
  });
  it('真实换代后旧上下文拒写，无代次不迁移旧日志', () => {
    const s = fixture();
    const old = s.context();
    expect(s.command('on')).toBe(0);
    const bytes = readFileSync(s.current);
    expect(noteReceipt(old, { phase: 'entered', decision: 'none' })).toEqual({
      ok: false,
      code: 'WINDOW_UNKNOWN',
    });
    expect(readFileSync(s.current)).toEqual(bytes);
    const legacy = s.state();
    delete legacy.generation;
    writeFileSync(s.stateFile, JSON.stringify(legacy));
    const r = s.run('stop-codex', { turn_id: 'legacy-turn' });
    expect(JSON.parse(r.stdout).decision).toBe('block');
    expect(r.stderr).toContain('WINDOW_UNKNOWN');
    expect(readFileSync(s.current)).toEqual(bytes);
    expect(readFileSync(s.oldFile)).toEqual(s.oldBytes);
  });
  it('写前/live提交前窗口不一致不覆盖current，留下next使未知明确可读', () => {
    const s = fixture();
    const c = s.context();
    const prior = readFileSync(s.current);
    let reads = 0;
    c.window = () => {
      reads++;
      return {
        ok: true,
        state: reads === 1 ? s.state() : { ...s.state(), generation: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
      };
    };
    expect(noteReceipt(c, { phase: 'entered', decision: 'none' })).toEqual({
      ok: false,
      code: 'WINDOW_UNKNOWN',
    });
    expect(readFileSync(s.current)).toEqual(prior);
    expect(existsSync(s.next)).toBe(true);
    expect(readLatestReceiptState(s.dir, fingerprint(s.sid))).toEqual({ ok: false, code: 'BUSY' });
  });
  it('v1损坏/锁住不能被新快照可读洗成成功', () => {
    const s = fixture();
    writeFileSync(s.oldFile, 'corrupt\n');
    expect(receiptStatus(s.dir, s.sid, s.state().generation)).toMatchObject({
      evidence: 'unknown',
      latestState: { evidence: 'observed' },
    });
    writeFileSync(s.oldFile, s.oldBytes);
    writeFileSync(`${s.oldFile}.lock`, '');
    expect(receiptStatus(s.dir, s.sid, s.state().generation)).toMatchObject({
      evidence: 'unknown',
      code: 'BUSY',
      latestState: { evidence: 'observed' },
    });
  });
  it.each(['next', 'lock', 'corrupt', 'directory', 'link', 'budget'] as const)(
    '%s故障保留旧历史、block及进展业务',
    (kind) => {
      const s = fixture();
      const before = readFileSync(s.current);
      if (kind === 'next') writeFileSync(s.next, 'uncommitted\n');
      if (kind === 'lock') writeFileSync(join(s.root, '.admission.lock'), '');
      if (kind === 'corrupt') writeFileSync(s.current, '{broken');
      if (kind === 'directory') {
        rmSync(s.current);
        mkdirSync(s.current);
      }
      if (kind === 'link') {
        rmSync(s.current);
        symlinkSync(s.oldFile, s.current);
      }
      if (kind === 'budget')
        for (let i = 0; i < 126; i++)
          writeFileSync(join(s.root, `${fingerprint(`legacy-${i}`)}.jsonl`), 'x\n');
      const stop = s.run('stop-codex', { turn_id: 'turn-a' });
      expect(stop.status).toBe(0);
      expect(JSON.parse(stop.stdout).decision).toBe('block');
      expect(stop.stderr).toContain('回执没查成');
      const progress = s.run('continuation-progress-codex', {
        tool_name: 'Write',
        tool_response: { success: true },
        tool_input: { content: 'new-work' },
      });
      expect(progress.status).toBe(0);
      expect(existsSync(join(s.dir, `${s.sid}.progress`))).toBe(true);
      expect(readFileSync(s.oldFile)).toEqual(s.oldBytes);
      if (['next', 'lock', 'budget'].includes(kind)) expect(readFileSync(s.current)).toEqual(before);
      expect(s.command('needs-you', 'isolated')).toBe(0);
      expect(s.command('done', 'isolated')).toBe(0);
      expect(s.command('off')).toBe(0);
    },
  );
  it('机器/unknown/共享父session子代理不改父快照，仍可创建新版诊断池', () => {
    const s = fixture();
    const before = readFileSync(s.current);
    const state = readFileSync(s.stateFile);
    for (const hook of ['continuation-start', 'stop-codex', 'continuation-progress-codex']) {
      const r = s.run(hook, { agent_id: 'child', turn_id: 'child-turn' });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    }
    expect(readFileSync(s.current)).toEqual(before);
    expect(readFileSync(s.stateFile)).toEqual(state);
    expect(existsSync(join(s.root, `${'0'.repeat(64)}.latest-v2`))).toBe(true);
  });
  it.each(['rename', 'fsync', 'close'] as const)(
    '%s失败不报成功、不覆盖旧快照或删除孤立next',
    async (kind) => {
      const s = fixture();
      const before = readFileSync(s.current);
      const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
      if (kind === 'rename')
        vi.mocked(renameSync).mockImplementationOnce(() => {
          throw Error('private-rename');
        });
      if (kind === 'fsync')
        vi.mocked(fsyncSync).mockImplementationOnce(() => {
          throw Error('private-sync');
        });
      if (kind === 'close') {
        // 第一次close关闭current读取fd；第二次是next输出fd。
        vi.mocked(closeSync)
          .mockImplementationOnce(fs.closeSync)
          .mockImplementationOnce((fd) => {
            fs.closeSync(fd);
            throw Error('private-close');
          });
      }
      expect(noteReceipt(s.context(), { phase: 'entered', decision: 'none' })).toMatchObject({ ok: false });
      expect(readFileSync(s.current)).toEqual(before);
      expect(readFileSync(s.oldFile)).toEqual(s.oldBytes);
      expect(existsSync(s.next)).toBe(true);
      expect(readLatestReceiptState(s.dir, fingerprint(s.sid))).toMatchObject({ ok: false });
    },
  );
  it('有界目录close失败拒写；只预留未来v1最大值不看当前小文件size', async () => {
    const s = fixture();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(opendirSync).mockImplementationOnce((...args) => {
      const dir = actual.opendirSync(...args);
      const close = dir.closeSync.bind(dir);
      dir.closeSync = () => {
        close();
        throw Error('private-directory-close');
      };
      return dir;
    });
    expect(latestBudget(s.root, fingerprint(s.sid))).toEqual({ ok: false, code: 'IO' });
    expect(latestBudget(s.root, fingerprint(s.sid))).toMatchObject({
      ok: true,
      reservedSlots: 3,
      reservedBytes: 2 * 1024 * 1024 + MAX_LATEST_BYTES * 2,
      peakEntries: 5,
    });
  });
  it('计数溢出拒写，旧快照的可证计数不回0', () => {
    const s = fixture();
    const snapshot = s.read();
    snapshot.revision = Number.MAX_SAFE_INTEGER;
    snapshot.knownReplacements = snapshot.revision - 1;
    writeFileSync(s.current, `${JSON.stringify(snapshot)}\n`);
    const before = readFileSync(s.current);
    expect(noteReceipt(s.context(), { phase: 'entered', decision: 'none' })).toEqual({
      ok: false,
      code: 'LIMIT',
    });
    expect(readFileSync(s.current)).toEqual(before);
  });
  it('latestRows只给保留事实，不宣称保留每条工具历史', () => {
    const s = fixture();
    emit(s);
    const rows = latestRows(s.read());
    expect(rows.some((row) => row?.phase === 'prepared')).toBe(true);
    expect(rows.some((row) => row?.phase === 'emitted')).toBe(true);
    expect(rows.length).toBeLessThan(12);
  });
  it('新版非根诊断也不改既有v1池；一百次替换维持一份v2且根和业务状态不变', () => {
    const s = fixture();
    // 先删除本夹具自建的v2，模拟升级前存在的诊断池，再重新建立v2根。
    rmSync(s.current);
    const child = receiptContext(
      s.dir,
      { session_id: s.sid, agent_id: 'child' },
      null,
      'PostToolUse',
      s.env,
      'machine',
    );
    expect(appendReceipt(child, { phase: 'bypass', decision: 'subagent' })).toEqual({ ok: true });
    const pool = join(s.root, `${'0'.repeat(64)}.jsonl`),
      oldPool = readFileSync(pool);
    expect(s.command('on')).toBe(0);
    const parent = readFileSync(s.current),
      business = readFileSync(s.stateFile);
    for (let i = 0; i < 100; i++)
      expect(noteReceipt(child, { phase: 'bypass', decision: 'subagent' })).toEqual({ ok: true });
    expect(readLatestDiagnosticState(s.dir)).toMatchObject({
      ok: true,
      state: {
        kind: 'diagnostic',
        revision: 100,
        knownReplacements: 99,
        receipt: { session: fingerprint(s.sid), agent: fingerprint('child') },
      },
    });
    expect(readFileSync(pool)).toEqual(oldPool);
    expect(readFileSync(s.oldFile)).toEqual(s.oldBytes);
    expect(readFileSync(s.current)).toEqual(parent);
    expect(readFileSync(s.stateFile)).toEqual(business);
    expect(readdirSync(s.root).sort()).toEqual(
      [
        basename(s.current),
        basename(s.oldFile),
        `${'0'.repeat(64)}.jsonl`,
        `${'0'.repeat(64)}.latest-v2`,
      ].sort(),
    );
  });
  it('混用旧writer：已有桶可到原上限，新桶在v2出现后安全拒绝；共享准入锁只试一次', () => {
    const s = fixture();
    const legacy = s.context();
    const current = readFileSync(s.current);
    expect(appendReceipt(legacy, { phase: 'entered', decision: 'none' })).toEqual({ ok: true });
    const afterOld = readFileSync(s.oldFile);
    expect(
      appendReceipt(receiptContext(s.dir, { session_id: 'new-old-root' }, null, 'Stop', s.env, 'allowed'), {
        phase: 'entered',
        decision: 'none',
      }),
    ).toEqual({ ok: false, code: 'IO' });
    expect(existsSync(join(s.root, `${fingerprint('new-old-root')}.jsonl`))).toBe(false);
    writeFileSync(join(s.root, '.admission.lock'), '');
    expect(noteReceipt(s.context(), { phase: 'entered', decision: 'none' })).toEqual({
      ok: false,
      code: 'EEXIST',
    });
    expect(
      appendReceipt(receiptContext(s.dir, { session_id: 'other-old-root' }, null, 'Stop', s.env, 'allowed'), {
        phase: 'entered',
        decision: 'none',
      }),
    ).toEqual({ ok: false, code: 'EEXIST' });
    expect(readFileSync(s.oldFile)).toEqual(afterOld);
    expect(readFileSync(s.current)).toEqual(current);
  });
  it.each(['current', 'next'] as const)('%s inode在提交前被替换，拒写并保留替身与v1', async (kind) => {
    const s = fixture(),
      before = readFileSync(s.current);
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    if (kind === 'current')
      vi.mocked(fsyncSync).mockImplementationOnce((fd) => {
        actual.fsyncSync(fd);
        actual.renameSync(s.current, `${s.current}.old`);
        actual.writeFileSync(s.current, 'replacement-current\n');
      });
    else
      vi.mocked(closeSync)
        .mockImplementationOnce(actual.closeSync)
        .mockImplementationOnce((fd) => {
          actual.closeSync(fd);
          actual.renameSync(s.next, `${s.next}.old`);
          actual.writeFileSync(s.next, 'replacement-next\n');
        });
    expect(noteReceipt(s.context(), { phase: 'entered', decision: 'none' })).toEqual({
      ok: false,
      code: 'IO',
    });
    expect(readFileSync(kind === 'current' ? `${s.current}.old` : s.current)).toEqual(before);
    expect(readFileSync(kind === 'current' ? s.current : s.next, 'utf8')).toBe(`replacement-${kind}\n`);
    expect(readFileSync(s.oldFile)).toEqual(s.oldBytes);
    expect(readLatestReceiptState(s.dir, fingerprint(s.sid))).toMatchObject({ ok: false });
  });
  it.each(['read-close', 'lock-close', 'unlock', 'lock-replaced'] as const)(
    '%s故障返回未知，锁或旧current留作诊断',
    async (kind) => {
      const s = fixture(),
        before = readFileSync(s.current),
        lock = join(s.root, '.admission.lock');
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      if (kind === 'read-close')
        vi.mocked(closeSync).mockImplementationOnce((fd) => {
          actual.closeSync(fd);
          throw Error('private-read-close');
        });
      if (kind === 'lock-close' || kind === 'lock-replaced')
        vi.mocked(closeSync)
          .mockImplementationOnce(actual.closeSync)
          .mockImplementationOnce(actual.closeSync)
          .mockImplementationOnce((fd) => {
            actual.closeSync(fd);
            if (kind === 'lock-close') throw Error('private-lock-close');
            actual.renameSync(lock, `${lock}.old`);
            actual.writeFileSync(lock, 'replacement-lock\n');
          });
      if (kind === 'unlock')
        vi.mocked(unlinkSync).mockImplementationOnce(() => {
          throw Error('private-unlock');
        });
      expect(noteReceipt(s.context(), { phase: 'entered', decision: 'none' })).toEqual({
        ok: false,
        code: 'IO',
      });
      if (kind === 'read-close') expect(readFileSync(s.current)).toEqual(before);
      else expect(readLatestReceiptState(s.dir, fingerprint(s.sid))).toEqual({ ok: false, code: 'BUSY' });
      if (kind === 'lock-replaced') expect(readFileSync(lock, 'utf8')).toBe('replacement-lock\n');
      expect(readFileSync(s.oldFile)).toEqual(s.oldBytes);
    },
  );
  it.each([
    'foreign-key',
    'foreign-generation',
    'unknown-field',
    'bad-association',
    'mismatched-pending',
    'bad-counter',
  ] as const)('%s快照语义拒绝，不能投影为可读成功', (kind) => {
    const s = fixture();
    emit(s);
    observeContinuation(s.context('PostToolUse', { turn_id: 'turn-b' }));
    const snapshot = s.read();
    if (!snapshot.stop || !snapshot.pending || !snapshot.association)
      throw Error('missing retained evidence');
    if (kind === 'foreign-key') snapshot.session = fingerprint('other');
    if (kind === 'foreign-generation') snapshot.stop.entered.generation = fingerprint('other');
    if (kind === 'unknown-field') Reflect.set(snapshot, 'raw', 'private-canary');
    if (kind === 'bad-association') snapshot.association.observation.originTurn = fingerprint('other');
    if (kind === 'mismatched-pending') snapshot.pending.emitted.turn = fingerprint('other');
    if (kind === 'bad-counter') snapshot.knownReplacements = 0;
    writeFileSync(s.current, `${JSON.stringify(snapshot)}\n`);
    const before = readFileSync(s.current);
    expect(readLatestReceiptState(s.dir, fingerprint(s.sid))).toEqual({ ok: false, code: 'CORRUPT' });
    expect(noteReceipt(s.context(), { phase: 'entered', decision: 'none' })).toEqual({
      ok: false,
      code: 'CORRUPT',
    });
    expect(readFileSync(s.current)).toEqual(before);
    expect(receiptStatus(s.dir, s.sid, s.state().generation)).toMatchObject({ evidence: 'unknown' });
  });
  it('根和诊断格式不能互认，保留键冲突拒写；旧锁先占一个未来2MiB桶', () => {
    const s = fixture();
    const child = receiptContext(s.dir, { session_id: s.sid }, null, 'Stop', s.env, 'unknown');
    expect(noteReceipt(child, { phase: 'fault', decision: 'identity_unknown' })).toEqual({ ok: true });
    const diagnostic = join(s.root, `${'0'.repeat(64)}.latest-v2`);
    const rootBytes = readFileSync(s.current),
      childBytes = readFileSync(diagnostic);
    writeFileSync(s.current, childBytes);
    writeFileSync(diagnostic, rootBytes);
    expect(readLatestReceiptState(s.dir, fingerprint(s.sid))).toEqual({ ok: false, code: 'CORRUPT' });
    expect(readLatestDiagnosticState(s.dir)).toEqual({ ok: false, code: 'CORRUPT' });
    expect(
      noteReceipt({ ...s.context(), session: '0'.repeat(64) }, { phase: 'entered', decision: 'none' }),
    ).toEqual({ ok: false, code: 'CONFLICT' });
    writeFileSync(join(s.root, `${fingerprint('pending-old-writer')}.jsonl.lock`), '');
    expect(latestBudget(s.root, fingerprint(s.sid))).toMatchObject({
      ok: true,
      reservedSlots: 6,
      peakEntries: 9,
      reservedBytes: 4 * 1024 * 1024 + MAX_LATEST_BYTES * 4,
    });
  });
  it('126个旧桶含锁与v2双槽正好128；不按当前小文件腾新诊断空间', () => {
    const s = fixture();
    for (let i = 0; i < 125; i++) {
      const file = join(s.root, `${fingerprint(`old-budget-${i}`)}.jsonl`);
      writeFileSync(file, 'old\n');
      writeFileSync(`${file}.lock`, '');
    }
    writeFileSync(`${s.oldFile}.lock`, '');
    expect(latestBudget(s.root, fingerprint(s.sid))).toMatchObject({
      ok: true,
      reservedSlots: 128,
      peakEntries: 255,
      reservedBytes: 126 * 2 * 1024 * 1024 + 2 * MAX_LATEST_BYTES,
    });
    expect(noteReceipt(s.context(), { phase: 'entered', decision: 'none' })).toEqual({ ok: true });
    const before = readdirSync(s.root).sort();
    expect(
      noteReceipt(receiptContext(s.dir, { session_id: s.sid }, null, 'Stop', s.env, 'machine'), {
        phase: 'bypass',
        decision: 'machine',
      }),
    ).toEqual({ ok: false, code: 'LIMIT' });
    expect(readdirSync(s.root).sort()).toEqual(before);
    expect(readFileSync(s.oldFile)).toEqual(s.oldBytes);
  });
  it.each(['file-open', 'directory-after-read'] as const)(
    '%s中途消失返回IO，不当首次无状态成功',
    async (kind) => {
      const s = fixture(),
        before = readFileSync(s.current);
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      if (kind === 'file-open')
        vi.mocked(openSync).mockImplementationOnce(() => {
          throw Object.assign(Error('private-disappeared'), { code: 'ENOENT' });
        });
      else {
        let reads = 0;
        vi.mocked(lstatSync).mockImplementation((...args) => {
          if (String(args[0]) === s.root && ++reads === 2)
            throw Object.assign(Error('private-directory-disappeared'), { code: 'ENOENT' });
          return actual.lstatSync(...args);
        });
      }
      expect(readLatestReceiptState(s.dir, fingerprint(s.sid))).toEqual({ ok: false, code: 'IO' });
      expect(readFileSync(s.current)).toEqual(before);
      expect(readFileSync(s.oldFile)).toEqual(s.oldBytes);
    },
  );
  it.each(['legacy-open', 'legacy-directory-after-read'] as const)(
    '%s不被可读v2洗成observed成功',
    async (kind) => {
      const s = fixture(),
        bytes = readFileSync(s.oldFile);
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      let failures = 2,
        reads = 0;
      if (kind === 'legacy-open')
        vi.mocked(openSync).mockImplementation((...args) => {
          if (String(args[0]) === s.oldFile && failures-- > 0)
            throw Object.assign(Error('private-old-disappeared'), { code: 'ENOENT' });
          return actual.openSync(...args);
        });
      else
        vi.mocked(lstatSync).mockImplementation((...args) => {
          if (String(args[0]) === s.root && ++reads === 2)
            throw Object.assign(Error('private-root-disappeared'), { code: 'ENOENT' });
          return actual.lstatSync(...args);
        });
      expect(readReceipts(s.dir, fingerprint(s.sid))).toEqual({ ok: false, code: 'IO' });
      reads = 0;
      expect(receiptStatus(s.dir, s.sid, s.state().generation)).toMatchObject({
        evidence: 'unknown',
        code: 'IO',
        latestState: { evidence: 'observed' },
      });
      expect(readFileSync(s.oldFile)).toEqual(bytes);
    },
  );
  it('rename后可检测到current被外部替换，明确IO而非成功，不承诺回滚', async () => {
    const s = fixture();
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(renameSync).mockImplementationOnce((from, to) => {
      actual.renameSync(from, to);
      actual.renameSync(s.current, `${s.current}.replaced`);
      actual.writeFileSync(s.current, 'external-replacement\n');
    });
    expect(noteReceipt(s.context(), { phase: 'entered', decision: 'none' })).toEqual({
      ok: false,
      code: 'IO',
    });
    expect(readFileSync(s.current, 'utf8')).toBe('external-replacement\n');
    expect(readFileSync(s.oldFile)).toEqual(s.oldBytes);
    expect(readLatestReceiptState(s.dir, fingerprint(s.sid))).toMatchObject({ ok: false });
  });
});
