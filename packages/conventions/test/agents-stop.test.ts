// pnpm agents:stop <工作树|agentId>（单 #3911）：按本机归属记录找到归属会话并向它发停止。
// 三种结局：找到并停；记录缺失；会话已不在。后两种退出码非 0，明说「停不了：原因」，不按启动时间猜、不杀整个进程。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const bin = pathToFileURL(join(import.meta.dirname, '../src/agents-stop.ts')).href;
const mod = (await import(bin)) as {
  agentsStop(
    args: string[],
    deps: {
      home: string;
      out: (line: string) => void;
      err: (line: string) => void;
      sessions: () => Array<{ id: string; alive: boolean }>;
      deliver: (sessionId: string, text: string) => { ok: boolean; why?: string };
    },
  ): number;
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const home = () => {
  const d = mkdtempSync(join(tmpdir(), 'agents-stop-'));
  dirs.push(d);
  return d;
};

const row = {
  agentId: 'toolu_3911',
  sessionId: 'sess-3911',
  pid: 4242,
  worktree: 'D:/frank/fleet-dao/.claude/worktrees/w3911',
  at: '2026-11-16T08:00:00.000Z',
};

function run(dir: string, key: string, sessions: Array<{ id: string; alive: boolean }>) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: Array<{ sessionId: string; text: string }> = [];
  const code = mod.agentsStop([key], {
    home: dir,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    sessions: () => sessions,
    deliver: (sessionId, text) => {
      sent.push({ sessionId, text });
      return { ok: true };
    },
  });
  return { code, out, err, sent };
}

describe('pnpm agents:stop', () => {
  it('找到并停：按工作树找到归属会话还在，向它发停止，退出码 0，不碰进程', () => {
    const dir = home();
    writeFileSync(join(dir, 'subagent-ownership.jsonl'), `${JSON.stringify(row)}\n`);
    const r = run(dir, row.worktree, [{ id: 'sess-3911', alive: true }]);
    expect(r.code).toBe(0);
    expect(r.sent).toEqual([{ sessionId: 'sess-3911', text: expect.stringContaining('toolu_3911') }]);
    expect(r.sent[0]?.text).toMatch(/TaskStop|停/);
    expect(JSON.stringify(r)).not.toContain('taskkill');
    expect(JSON.stringify(r)).not.toContain('4242');
  });

  it('记录缺失：退出码非 0，明说「停不了：记录缺失」', () => {
    const dir = home();
    const r = run(dir, 'toolu_missing', [{ id: 'sess-3911', alive: true }]);
    expect(r.code).not.toBe(0);
    expect(r.err.join('\n')).toMatch(/停不了：记录缺失/);
    expect(r.sent).toEqual([]);
  });

  it('会话已不在：记录还在、归属会话没了，退出码非 0，明说「停不了：会话已不在」', () => {
    const dir = home();
    writeFileSync(join(dir, 'subagent-ownership.jsonl'), `${JSON.stringify(row)}\n`);
    const r = run(dir, 'toolu_3911', [{ id: 'sess-3911', alive: false }]);
    expect(r.code).not.toBe(0);
    expect(r.err.join('\n')).toMatch(/停不了：会话已不在/);
    expect(r.sent).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('taskkill');
  });
});
