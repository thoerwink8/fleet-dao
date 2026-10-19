import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  codexSessionSource,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_ENTRIES,
  MAX_SOURCE_MS,
} from '../hooks/codex-session-source.mjs';
import { run as logPrompt } from '../hooks/prompt-log.mjs';
import { main } from '../hooks/unattended.mjs';
import { watchRuns } from '../hooks/work-watch.mjs';
import { runChild } from './child.ts';
import { codexSourceFixture } from './codex-source-fixture.ts';

const made: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const parent = 'root-session-redacted';
// 两份本机session_meta白名单结构的等价脱敏fixture，不复制instructions、对话或工具输出。
const children = ['vps-followup-child', 'coordination-review-child'].map((id, index) => ({
  id,
  source: {
    subagent: {
      thread_spawn: {
        parent_thread_id: parent,
        depth: 1,
        agent_path: index ? '/root/review' : '/root/followup',
        agent_nickname: index ? 'Reviewer' : 'Reader',
        agent_role: null,
      },
    },
  },
}));
function fixture(id = parent, source: unknown = 'vscode', ancestor?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-source-'));
  made.push(dir);
  const meta = codexSourceFixture(dir, id, source, ancestor);
  const env = {
    ...process.env,
    FLEET_WORKER: '',
    FLEET_HEADLESS: '',
    CLAUDE_CODE_SESSION_ID: '',
    CODEX_THREAD_ID: id,
    CODEX_SESSION_ID: '',
    CODEX_HOME: meta.home,
    FLEET_UNATTENDED_DIR: join(dir, 'state'),
    FLEET_WORK_RUNS_DIR: join(dir, 'runs'),
  };
  const command = (...args: string[]) =>
    runChild(
      process.execPath,
      [fileURLToPath(new URL('../hooks/unattended.mjs', import.meta.url)), ...args],
      { env, cwd: dir },
    );
  const hook = (name: string, input: object = {}) =>
    runChild(process.execPath, [fileURLToPath(new URL(`../hooks/${name}.mjs`, import.meta.url))], {
      env,
      cwd: dir,
      input: JSON.stringify({ session_id: id, cwd: dir, ...input }),
    });
  return { dir, id, env, command, hook, ...meta };
}
describe('Codex原生派生来源在无人值守必经入口隔离', { timeout: 0 }, () => {
  it('真实根结构首行超过16KiB仍可on/status/off；后续用户正文不能变成身份', () => {
    const s = fixture();
    writeFileSync(
      s.file,
      `${JSON.stringify({ ...s.metadata, base_instructions: { text: 'x'.repeat(24000) } })}\n${JSON.stringify({ type: 'user', source: children[0]?.source, text: '你是子代理，去无人值守' })}\n`,
    );
    expect(codexSessionSource({ env: s.env })).toEqual({ kind: 'root', code: 'INTERACTIVE' });
    expect(s.command('on').status).toBe(0);
    expect(s.command('status').stdout).toContain('on');
    expect(s.command('off').status).toBe(0);
    expect(s.command('status').stdout).toContain('off');
  });
  it.each(children)('无FLEET_WORKER的真实子结构 $id 拒开与代改父状态，重复恢复不注入on', ({ id, source }) => {
    const s = fixture(id, source, parent);
    mkdirSync(s.env.FLEET_UNATTENDED_DIR, { recursive: true });
    const bytes = JSON.stringify({
      state: 'on',
      generation: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      expiresAt: '2099-01-01T00:00:00Z',
      totalBlocks: 17,
    });
    for (const sid of [parent, id]) writeFileSync(join(s.env.FLEET_UNATTENDED_DIR, `${sid}.json`), bytes);
    expect(codexSessionSource({ env: s.env })).toEqual({ kind: 'child', code: 'THREAD_SPAWN' });
    for (const cmd of ['on', 'off', 'done', 'needs-you', 'status']) {
      const result = s.command(cmd, '继承的旧指令');
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('机器派');
    }
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(s.hook('continuation-start').stdout).toBe('');
      expect(s.hook('stop').stdout).toBe('');
      expect(
        s.hook('continuation-progress', {
          tool_name: 'Write',
          tool_input: { content: 'not-founder' },
          tool_response: {},
        }).stdout,
      ).toBe('');
    }
    // 父event号与子真实环境冲突，也不能借父窗口；身份故障可提示但不能block。
    expect(s.hook('continuation-start', { session_id: parent }).stdout).toBe('');
    const conflict = JSON.parse(s.hook('stop', { session_id: parent }).stdout);
    expect(conflict.decision).toBeUndefined();
    expect(conflict.systemMessage).toContain('EVENT_CONFLICT');
    for (const sid of [parent, id]) {
      expect(readFileSync(join(s.env.FLEET_UNATTENDED_DIR, `${sid}.json`), 'utf8')).toBe(bytes);
      expect(existsSync(join(s.env.FLEET_UNATTENDED_DIR, `${sid}.progress`))).toBe(false);
    }
  });
  it('两家开场实现对原生child和unknown不注入父历史/开关，恢复不读创始人队列', async () => {
    const starts = (await import(new URL('../hooks/session-start.mjs', import.meta.url).href)) as {
      sessionStart(options: Record<string, unknown>): string[];
      fastSessionStart(options: Record<string, unknown>): string[];
    };
    const child = children[0];
    if (!child) throw Error('missing child fixture');
    const s = fixture(child.id, child.source, parent);
    const noRepo = () => ({ status: 1, stdout: '', stderr: 'synthetic non-repository' });
    const progress = vi.fn(() => {
      throw Error('must not read founder queue');
    });
    for (const start of [starts.sessionStart, starts.fastSessionStart]) {
      for (const env of [s.env, { ...s.env, CODEX_THREAD_ID: 'unknown-session' }]) {
        for (let restored = 0; restored < 2; restored++) {
          const lines = start({
            cwd: s.dir,
            home: s.dir,
            git: noRepo,
            sync: noRepo,
            progress,
            env,
            sessionId: env.CODEX_THREAD_ID,
            spawnBackground: () => ({ ok: true }),
          });
          expect(lines.join('\n')).not.toContain('无人值守开着');
          expect(lines.join('\n')).not.toContain('pnpm progress');
        }
      }
    }
    expect(progress).not.toHaveBeenCalled();
  });
  it('Claude共享开场收到agent_id时，即使只有父session_id且没有Codex环境也不注入父历史', async () => {
    const starts = (await import(new URL('../hooks/session-start.mjs', import.meta.url).href)) as {
      sessionStart(options: Record<string, unknown>): string[];
      fastSessionStart(options: Record<string, unknown>): string[];
    };
    const s = fixture();
    expect(s.command('on').status).toBe(0);
    const env = { ...s.env, CODEX_THREAD_ID: '', CODEX_SESSION_ID: '' };
    const never = vi.fn(() => {
      throw Error('must not read founder queue');
    });
    const noRepo = () => ({ status: 1, stdout: '', stderr: 'synthetic non-repository' });
    for (const start of [starts.sessionStart, starts.fastSessionStart]) {
      const lines = start({
        cwd: s.dir,
        home: s.dir,
        git: noRepo,
        sync: noRepo,
        env,
        sessionId: s.id,
        agentId: 'native-child',
        unattendedDir: s.env.FLEET_UNATTENDED_DIR,
        progress: never,
        repoContract: never,
        poolHolds: never,
        spawnBackground: never,
      });
      expect(lines.join('\n')).not.toContain('无人值守开着');
      expect(lines.join('\n')).not.toContain('unattended.mjs on');
    }
    expect(never).not.toHaveBeenCalled();
  });
  it('明确Codex登记入口可用本次事件号，受配sessions根链接不要求终端环境号；直接on仍拒绝', () => {
    const s = fixture();
    expect(s.command('on').status).toBe(0);
    const relay = join(s.dir, 'relay-event-host');
    mkdirSync(relay);
    symlinkSync(join(s.home, 'sessions'), join(relay, 'sessions'), 'junction');
    s.env.CODEX_HOME = relay;
    s.env.CODEX_THREAD_ID = '';
    s.env.CODEX_SESSION_ID = '';
    expect(s.command('on').status).toBe(2);
    expect(s.hook('continuation-start').stdout).toContain('无人值守');
    const stop = s.hook('stop-codex');
    expect(stop.status).toBe(0);
    expect(JSON.parse(stop.stdout).decision).toBe('block');
    const progress = s.hook('continuation-progress-codex', {
      tool_name: 'Write',
      tool_input: { content: 'isolated-progress' },
      tool_response: {},
    });
    expect(progress.status).toBe(0);
    expect(existsSync(join(s.env.FLEET_UNATTENDED_DIR, `${s.id}.progress`))).toBe(true);
    const snapshot = readFileSync(join(s.env.FLEET_UNATTENDED_DIR, `${s.id}.json`), 'utf8');
    for (const session_id of [undefined, '../bad', 'unavailable-other-session']) {
      const refused = s.hook('stop-codex', { session_id });
      expect(refused.status).toBe(0);
      expect(JSON.parse(refused.stdout).decision).toBeUndefined();
      expect(refused.stderr + refused.stdout).toContain('身份');
      expect(readFileSync(join(s.env.FLEET_UNATTENDED_DIR, `${s.id}.json`), 'utf8')).toBe(snapshot);
    }
    expect(s.hook('stop-codex', { agent_id: 'child-event' }).stdout).toBe('');
    expect(readFileSync(join(s.env.FLEET_UNATTENDED_DIR, `${s.id}.json`), 'utf8')).toBe(snapshot);
  });
  it('无终端环境号的Codex事件仍按子metadata拒绝，不读父窗口', () => {
    const child = children[0];
    if (!child) throw Error('missing child fixture');
    const s = fixture(child.id, child.source, parent);
    s.env.CODEX_THREAD_ID = '';
    for (const hook of ['continuation-start', 'stop-codex', 'continuation-progress-codex']) {
      expect(s.hook(hook).stdout).toBe('');
      expect(s.hook(hook, { session_id: parent, agent_id: 'native-child' }).stdout).toBe('');
    }
    expect(existsSync(join(s.env.FLEET_UNATTENDED_DIR, `${parent}.json`))).toBe(false);
    expect(existsSync(join(s.env.FLEET_UNATTENDED_DIR, `${s.id}.progress`))).toBe(false);
  });
  it('子来源不记创始人正文、不claim父任务、不sleep或请求rewake；未知来源明确失败', async () => {
    const child = children[0];
    if (!child) throw Error('missing child fixture');
    const s = fixture(child.id, child.source, parent);
    const log = join(s.dir, 'prompt-log');
    const env = { ...s.env, FLEET_PROMPT_LOG_DIR: log };
    const input = { session_id: s.id, cwd: s.dir, prompt: 'private-child-canary' };
    expect(logPrompt({ stdin: JSON.stringify(input), env })).toMatchObject({ ok: true, skipped: true });
    expect(existsSync(log)).toBe(false);
    const run = join(s.env.FLEET_WORK_RUNS_DIR, 'isolated-parent-task');
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'state.json'), JSON.stringify({ dispatcher: s.id, state: 'done' }));
    writeFileSync(join(run, 'result.json'), JSON.stringify({ state: 'done', summary: 'private-result' }));
    const sleep = vi.fn(async () => {});
    const err = vi.fn();
    expect(await watchRuns(input, { env, sleep, err })).toBe(0);
    expect(sleep).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(existsSync(join(run, 'reported'))).toBe(false);
    writeFileSync(s.file, 'invalid-private-metadata\n');
    const unknown = logPrompt({ stdin: JSON.stringify(input), env });
    expect(unknown).toMatchObject({ ok: false, code: 'IDENTITY_UNKNOWN' });
    expect(JSON.stringify(unknown)).not.toContain('private');
    expect(await watchRuns(input, { env, sleep, err })).toBe(0);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('身份没查成'));
    expect(sleep).not.toHaveBeenCalled();
    expect(existsSync(log)).toBe(false);
    expect(existsSync(join(run, 'reported'))).toBe(false);
  });
  it.each(['CODEX_SESSION_ID', 'CLAUDE_CODE_SESSION_ID'])('%s冲突不借父号，状态不落盘', (name) => {
    const s = fixture();
    s.env[name as keyof typeof s.env] = 'different-parent';
    expect(s.command('on').status).toBe(2);
    expect(existsSync(s.env.FLEET_UNATTENDED_DIR)).toBe(false);
  });
  it('首记录会话错误/来源缺失/坏JSON/非metadata均明确未知且拒开，不回显正文', () => {
    const s = fixture();
    for (const value of [
      JSON.stringify({ type: 'session_meta', payload: { id: 'someone-else', source: 'vscode' } }),
      JSON.stringify({ type: 'session_meta', payload: { id: s.id } }),
      '{private-canary-bad-json',
      JSON.stringify({ type: 'user', payload: { id: s.id, source: 'vscode', text: 'private-canary' } }),
    ]) {
      writeFileSync(s.file, `${value}\n`);
      const result = s.command('on');
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('来源未知');
      expect(result.stderr).not.toContain('private-canary');
      expect(existsSync(s.env.FLEET_UNATTENDED_DIR)).toBe(false);
    }
  });
  it.each([
    { source: children[0]?.source },
    { source: children[0]?.source, parent_thread_id: 'different-parent' },
    { source: 'vscode', parent_thread_id: parent },
    {
      source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 0, agent_path: '/root/x' } } },
      parent_thread_id: parent,
    },
    { source: 'unknown-new-source' },
  ])('不完整或矛盾父来源不能当root %#', (payload) => {
    const s = fixture('child-fixture');
    writeFileSync(s.file, `${JSON.stringify({ type: 'session_meta', payload: { id: s.id, ...payload } })}\n`);
    expect(codexSessionSource({ env: s.env }).kind).toBe('unknown');
    expect(s.command('on').status).toBe(2);
  });
  it('精确文件名匹配，不把含rootID的resume文件当root；多来源歧义拒开', () => {
    const s = fixture();
    const resume = join(s.date, `rollout-old-${s.id}_resume-other.jsonl`);
    renameSync(s.file, resume);
    expect(codexSessionSource({ env: s.env })).toEqual({ kind: 'unknown', code: 'SOURCE_MISSING' });
    renameSync(resume, s.file);
    writeFileSync(join(s.date, `rollout-another-${s.id}.jsonl`), `${JSON.stringify(s.metadata)}\n`);
    expect(codexSessionSource({ env: s.env })).toEqual({ kind: 'unknown', code: 'AMBIGUOUS_SOURCE' });
  });
  it('不能从另一home/另一会话借来源；未完成首记录与非文件来源均未知', () => {
    const s = fixture();
    const wrong = { ...s.env, CODEX_HOME: join(s.dir, 'missing-home') };
    expect(codexSessionSource({ env: wrong }).kind).toBe('unknown');
    writeFileSync(s.file, JSON.stringify(s.metadata));
    expect(codexSessionSource({ env: s.env })).toEqual({ kind: 'unknown', code: 'META_INCOMPLETE' });
    rmSync(s.file);
    mkdirSync(s.file);
    expect(codexSessionSource({ env: s.env })).toEqual({ kind: 'unknown', code: 'SOURCE_TYPE' });
  });
  it('链接来源拒绝，不追到别的会话', () => {
    const s = fixture();
    const actual = join(s.dir, 'actual');
    renameSync(s.date, actual);
    symlinkSync(actual, s.date, 'junction');
    expect(codexSessionSource({ env: s.env })).toEqual({ kind: 'unknown', code: 'SOURCE_TYPE' });
  });
  it.each(['directory', 'file'])('读取时%s换代明确unknown，不借外部root来源', (race) => {
    const child = children[0];
    if (!child) throw Error('missing child fixture');
    const s = fixture(child.id, child.source, parent);
    const outside = join(s.dir, 'outside');
    mkdirSync(outside);
    const foreign = join(outside, s.file.slice(s.date.length + 1));
    writeFileSync(
      foreign,
      `${JSON.stringify({ type: 'session_meta', payload: { id: s.id, source: 'vscode' } })}\n`,
    );
    const code = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const { codexSessionSource } = await import(${JSON.stringify(new URL('../hooks/codex-session-source.mjs', import.meta.url).href)});
      const env = ${JSON.stringify({ CODEX_THREAD_ID: s.id, CODEX_HOME: s.home })};
      const before = codexSessionSource({ env });
      const key = ${JSON.stringify(race === 'directory' ? 'opendirSync' : 'openSync')};
      const target = ${JSON.stringify(race === 'directory' ? s.date : s.file)};
      const original = fs[key];
      let swapped = false;
      fs[key] = function(path, ...args) {
        if (!swapped && String(path) === target) {
          swapped = true;
          fs.renameSync(target, target + '-saved');
          if (key === 'opendirSync') fs.symlinkSync(${JSON.stringify(outside)}, target, 'junction');
          else fs.copyFileSync(${JSON.stringify(foreign)}, target);
        }
        return original.call(this, path, ...args);
      };
      syncBuiltinESMExports();
      const result = codexSessionSource({ env });
      fs[key] = original;
      syncBuiltinESMExports();
      console.log(JSON.stringify({ before, swapped, result }));
    `;
    const probe = runChild(process.execPath, ['--input-type=module', '-e', code], { cwd: s.dir });
    expect(probe.status, probe.stderr).toBe(0);
    expect(JSON.parse(probe.stdout)).toEqual({
      before: { kind: 'child', code: 'THREAD_SPAWN' },
      swapped: true,
      result: { kind: 'unknown', code: 'SOURCE_CHANGED' },
    });
  });
  it('Mirasim显式home的sessions根可稳定链接共享正式来源，仍精确绑定本会话', () => {
    const s = fixture();
    const relay = join(s.dir, 'relay');
    mkdirSync(relay);
    symlinkSync(join(s.home, 'sessions'), join(relay, 'sessions'), 'junction');
    s.env.CODEX_HOME = relay;
    expect(codexSessionSource({ env: s.env })).toEqual({ kind: 'root', code: 'INTERACTIVE' });
    expect(s.command('on').status).toBe(0);
    expect(s.command('off').status).toBe(0);
  });
  it('目录项与时间预算超界均unknown，不当没有子代理', () => {
    const s = fixture();
    for (let i = 0; i <= MAX_SOURCE_ENTRIES; i++)
      writeFileSync(join(s.home, 'sessions', `irrelevant-${i}`), '');
    expect(codexSessionSource({ env: s.env })).toEqual({ kind: 'unknown', code: 'ENTRY_LIMIT' });
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(MAX_SOURCE_MS + 1);
    expect(codexSessionSource({ env: s.env })).toEqual({ kind: 'unknown', code: 'TIME_LIMIT' });
  });
  it('首记录字节超界明确unknown，不跳读后文找root', () => {
    const s = fixture();
    writeFileSync(s.file, `${' '.repeat(MAX_SOURCE_BYTES)}\n${JSON.stringify(s.metadata)}\n`);
    const result = codexSessionSource({ env: s.env });
    expect(result.kind).toBe('unknown');
    expect(['BYTE_LIMIT', 'TIME_LIMIT']).toContain(result.code);
  });
  it('已知worker/反方保持拒开，Claude既有来源不要求Codex目录', () => {
    const s = fixture();
    for (const machine of [{ FLEET_WORKER: '1' }, { FLEET_HEADLESS: '1' }]) {
      const err: string[] = [];
      expect(
        main(['on'], { env: { ...s.env, ...machine }, out: () => {}, err: (line) => err.push(line) }),
      ).toBe(2);
      expect(err.join('')).toContain('机器派');
    }
    const env = {
      FLEET_UNATTENDED_DIR: s.env.FLEET_UNATTENDED_DIR,
      CLAUDE_CODE_SESSION_ID: 'claude-real-root',
    };
    for (const command of [['on'], ['status'], ['off']])
      expect(main(command, { env, out: () => {}, err: () => {} })).toBe(0);
  });
});
