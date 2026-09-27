// 会话脱开引擎进程（detached.ts）：输入输出走收发目录里的文件、退出码由外壳写。引擎重启后接回（attach）：从头重读输出，
// 确认过的行只重放、不再报；会话在引擎不在时跑完的照样收场；退出码丢了、认不出照实报，不当成 0。
// 外壳是 /bin/sh：只在 Linux、macOS 上跑（CI 是 Linux）。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClaudeCodeRunSpec } from '../src/claude-code/run.ts';
import { judgeClaudeRun, runClaudeCode } from '../src/claude-code/run.ts';
import type { LineMeta } from '../src/cli-run.ts';
import { IO_FILES, parseExitFile, prepareIo, WRAPPER } from '../src/detached.ts';
import { fakeAgent, fixtureInit, fixtureLines, fixturePath, pidAlive, tempDir } from './helpers.ts';

const onPosix = process.platform !== 'win32';
const FIXTURE = 'cc-haiku-edit';
const ALL = fixtureLines('claude-code', FIXTURE);

function spec(over: Partial<ClaudeCodeRunSpec> = {}): ClaudeCodeRunSpec {
  return {
    runId: `run-${randomUUID()}`,
    cwd: tempDir(),
    prompt: '把 notes.md 里的「TODO: 写测试」改成「DONE: 写测试」',
    model: 'claude-haiku-4-5',
    session: { mode: 'new', id: fixtureInit(FIXTURE).sessionId },
    permissionMode: 'bypassPermissions',
    env: { base: process.env, fleetApi: 'http://127.0.0.1:7070', fleetToken: 'tok-7' },
    limits: { startupMs: 10_000, wallClockMs: 20_000, killGraceMs: 300 },
    ...over,
  };
}

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('等不到');
}

const outLines = (dir: string) =>
  readFileSync(join(dir, IO_FILES.out), 'utf8')
    .split('\n')
    .filter((l) => l.trim()).length;

type Seen = { kind: string; seq: number; replay: boolean };

describe('退出码文件', () => {
  it('空的是还没写；写了数就是退出码；写的认不出照实抛（不当成 0）', () => {
    expect(parseExitFile('')).toBeUndefined();
    expect(parseExitFile('\n')).toBeUndefined();
    expect(parseExitFile('0\n')).toBe(0);
    expect(parseExitFile('143\n')).toBe(143);
    expect(() => parseExitFile('oops\n')).toThrow(/认不出/);
    expect(() => parseExitFile('-1\n')).toThrow(/认不出/);
  });

  it('外壳接住挂断、TERM：写退出码之前不会被带走', () => {
    expect(WRAPPER).toContain("trap '' HUP");
    expect(WRAPPER).toContain("trap 'got=1' TERM INT");
  });
});

describe.skipIf(!onPosix)('走文件跑会话', { timeout: 30_000 }, () => {
  it('起：提示词、输出、退出码都走收发目录，每行带序号；和接管道时报的事件一样', async () => {
    const io = tempDir('fleet-io-');
    const files = tempDir();
    const seen: Seen[] = [];
    const s = spec();
    const report = await runClaudeCode(s, {
      command: fakeAgent({ stdinTo: join(files, 'stdin'), replay: fixturePath('claude-code', FIXTURE) }),
      io: { dir: io, pollMs: 20 },
      onEvent: (e, m: LineMeta) => seen.push({ kind: e.kind, seq: m.seq, replay: m.replay }),
    });
    expect(report.exitCode).toBe(0);
    expect(report.exitLost).toBeUndefined();
    expect(report.lines).toBe(ALL.length);
    expect(judgeClaudeRun(report)).toEqual({ outcome: 'ok', reason: 'answered', detail: '正常结束' });
    expect(readFileSync(join(files, 'stdin'), 'utf8')).toBe(s.prompt);
    expect(readFileSync(join(io, IO_FILES.prompt), 'utf8')).toBe(s.prompt);
    expect(outLines(io)).toBe(ALL.length);
    expect(readFileSync(join(io, IO_FILES.exit), 'utf8').trim()).toBe('0');
    expect(seen.map((e) => e.kind)).toEqual(['tool', 'tool', 'tool', 'tool', 'file', 'say']);
    expect(seen.every((e) => !e.replay && e.seq >= 0 && e.seq < ALL.length)).toBe(true);
    // 序号只增不减
    expect(seen.map((e) => e.seq)).toEqual([...seen.map((e) => e.seq)].sort((a, b) => a - b));
  });

  it('引擎重启：接回在跑的会话，确认过的行只重放不再报、之后的照常报；会话接着干完，结局收得到', async () => {
    const io = tempDir('fleet-io-');
    const files = tempDir();
    const go = join(files, 'go');
    const s = spec();
    const command = fakeAgent({
      stdinTo: join(files, 'stdin'),
      replay: fixturePath('claude-code', FIXTURE),
      holdUntil: { afterLines: 8, file: go },
    });
    const before: Seen[] = [];
    // 第一个引擎起会话；跑到第 8 行停住（会话还在干活）
    const first = runClaudeCode(s, {
      command,
      io: { dir: io, pollMs: 20 },
      onEvent: (e, m) => before.push({ kind: e.kind, seq: m.seq, replay: m.replay }),
    });
    await until(() => existsSync(join(io, IO_FILES.out)) && outLines(io) === 8);
    await until(() => before.some((e) => e.seq >= 5));
    // 第一个引擎确认进库到第 4 行（序号 0–4）；新引擎接回：不起进程，从第 5 行起照常报
    const confirmed = 4;
    const after: Seen[] = [];
    const second = runClaudeCode(s, {
      command,
      io: { dir: io, attach: true, pollMs: 20 },
      replayUntil: confirmed + 1,
      onEvent: (e, m) => after.push({ kind: e.kind, seq: m.seq, replay: m.replay }),
    });
    writeFileSync(go, '');
    const [, report] = await Promise.all([first, second]);

    expect(report.exitCode).toBe(0);
    expect(report.lines).toBe(ALL.length);
    expect(judgeClaudeRun(report)).toEqual({ outcome: 'ok', reason: 'answered', detail: '正常结束' });
    // 提示词只喂了一次：接回没有重起会话
    expect(readFileSync(join(files, 'stdin'), 'utf8')).toBe(s.prompt);
    expect(after.filter((e) => e.replay).every((e) => e.seq <= confirmed)).toBe(true);
    expect(after.filter((e) => !e.replay).every((e) => e.seq > confirmed)).toBe(true);
    // 去重：第一个引擎确认过的 + 接回后照常报的 = 从头到尾一份，不多不少
    const merged = [...before.filter((e) => e.seq <= confirmed), ...after.filter((e) => !e.replay)];
    expect(merged.map((e) => e.kind)).toEqual(['tool', 'tool', 'tool', 'tool', 'file', 'say']);
  });

  it('会话在引擎不在时跑完了：接回读到外壳写的退出码，照常收场；确认过的全都只重放', async () => {
    const io = tempDir('fleet-io-');
    const s = spec();
    const command = fakeAgent({ replay: fixturePath('claude-code', FIXTURE) });
    await runClaudeCode(s, { command, io: { dir: io, pollMs: 20 } });
    const seen: Seen[] = [];
    const report = await runClaudeCode(s, {
      command,
      io: { dir: io, attach: true, pollMs: 20 },
      replayUntil: ALL.length + 1,
      onEvent: (e, m) => seen.push({ kind: e.kind, seq: m.seq, replay: m.replay }),
    });
    expect(report.exitCode).toBe(0);
    expect(report.exitLost).toBeUndefined();
    expect(judgeClaudeRun(report).outcome).toBe('ok');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((e) => e.replay)).toBe(true);
  });

  it('退出码丢了（外壳被强杀、没写退出码，会话也不在了）：照实报 exitLost，判 exit_lost，不当成 0', async () => {
    const io = tempDir('fleet-io-');
    const s = spec();
    await prepareIo(io, s.prompt, new Date().toISOString());
    // 输出只到一半（没有终帧），外壳的进程号已经没了
    writeFileSync(join(io, IO_FILES.out), `${ALL.slice(0, 5).join('\n')}\n`);
    const dead = await deadPid();
    writeFileSync(join(io, IO_FILES.pid), `${dead}\n`);
    const report = await runClaudeCode(s, {
      command: ['/bin/true'],
      io: { dir: io, attach: true, pollMs: 20, exitGraceMs: 100 },
    });
    expect(report.exitCode).toBeNull();
    expect(report.exitLost).toMatch(/没写退出码/);
    expect(judgeClaudeRun(report)).toMatchObject({ outcome: 'failed', reason: 'exit_lost' });
  });

  it('退出码文件写的认不出：照实报 exitLost（带原话），不当成 0', async () => {
    const io = tempDir('fleet-io-');
    const s = spec();
    await prepareIo(io, s.prompt, new Date().toISOString());
    writeFileSync(join(io, IO_FILES.out), `${ALL.slice(0, 5).join('\n')}\n`);
    writeFileSync(join(io, IO_FILES.pid), `${await deadPid()}\n`);
    writeFileSync(join(io, IO_FILES.exit), 'garbage\n');
    const report = await runClaudeCode(s, {
      command: ['/bin/true'],
      io: { dir: io, attach: true, pollMs: 20, exitGraceMs: 100 },
    });
    expect(report.exitCode).toBeNull();
    expect(report.exitLost).toMatch(/认不出/);
    expect(judgeClaudeRun(report).reason).toBe('exit_lost');
  });

  it('叫停：外壳和执行体一起收到 TERM，外壳等执行体退了再写退出码', async () => {
    const io = tempDir('fleet-io-');
    const abort = new AbortController();
    const s = spec();
    const running = runClaudeCode(s, {
      command: fakeAgent({ replay: fixturePath('claude-code', FIXTURE), replayLines: 3, after: 'hang' }),
      io: { dir: io, pollMs: 20 },
      signal: abort.signal,
    });
    await until(() => existsSync(join(io, IO_FILES.out)) && outLines(io) === 3);
    const pid = Number(readFileSync(join(io, IO_FILES.pid), 'utf8').trim());
    abort.abort();
    const report = await running;
    expect(report.killed?.reason).toBe('aborted');
    expect(report.exitCode).toBe(143);
    expect(report.exitLost).toBeUndefined();
    await until(() => !pidAlive(pid), 3_000);
    expect(judgeClaudeRun(report).outcome).toBe('stopped');
  });

  it('执行体起不来（命令不在）：外壳照实写退出码 127，原话在错误输出里', async () => {
    const io = tempDir('fleet-io-');
    const report = await runClaudeCode(spec(), {
      command: ['/nonexistent/fleet-agent-bin'],
      io: { dir: io, pollMs: 20 },
    });
    expect(report.exitCode).toBe(127);
    expect(report.stderrTail).toMatch(/nonexistent/);
    expect(judgeClaudeRun(report).outcome).toBe('failed');
  });
});

/** 一个已经退出的进程号。 */
function deadPid(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    child.on('exit', () => resolve(child.pid as number));
  });
}
