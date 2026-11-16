// 派子代理时落一行本机归属（单 #3911）：agentId → 会话 id → 进程号 → 工作树 → 派出时间。
// 记在 ~/.fleet-dao/subagent-ownership.jsonl（FLEET_DAO_HOME 可换），不进仓。这里直接调记录函数，不起真会话。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const mod = (await import(
  pathToFileURL(join(import.meta.dirname, '../hooks/subagent-ownership.mjs')).href
)) as {
  recordDispatch(
    raw: string,
    deps?: { home?: string; pid?: number; now?: () => Date },
  ): {
    recorded: boolean;
    why?: string;
  };
  readOwnership(home: string): Array<{
    agentId: string;
    sessionId: string;
    pid: number;
    worktree: string;
    at: string;
  }>;
  findOwnership(
    home: string,
    key: string,
  ): { agentId: string; sessionId: string; pid: number; worktree: string; at: string } | null;
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const home = () => {
  const d = mkdtempSync(join(tmpdir(), 'subagent-own-'));
  dirs.push(d);
  return d;
};

const NOW = new Date('2026-11-16T08:00:00.000Z');
const input = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    tool_name: 'Agent',
    tool_use_id: 'toolu_3911',
    session_id: 'sess-3911',
    cwd: 'D:/frank/fleet-dao/.claude/worktrees/w3911',
    tool_input: { prompt: '做 #3911', subagent_type: 'general-purpose', run_in_background: true },
    ...over,
  });

describe('派子代理时记一行归属，能按 agentId 和工作树读回来', () => {
  it('放行一次 Agent 派工：写下 agentId、会话、进程号、工作树、时刻，两种键都读得回同一行', () => {
    const dir = home();
    const r = mod.recordDispatch(input(), { home: dir, pid: 4242, now: () => NOW });
    expect(r.recorded).toBe(true);
    const rows = mod.readOwnership(dir);
    expect(rows).toEqual([
      {
        agentId: 'toolu_3911',
        sessionId: 'sess-3911',
        pid: 4242,
        worktree: 'D:/frank/fleet-dao/.claude/worktrees/w3911',
        at: NOW.toISOString(),
      },
    ]);
    expect(mod.findOwnership(dir, 'toolu_3911')?.sessionId).toBe('sess-3911');
    expect(mod.findOwnership(dir, 'D:/frank/fleet-dao/.claude/worktrees/w3911')?.agentId).toBe('toolu_3911');
    expect(mod.findOwnership(dir, '没有这个')).toBeNull();
  });

  it('同一个 agentId 再记一次不覆盖第一行；文件里仍是两行 JSON', () => {
    const dir = home();
    mod.recordDispatch(input(), { home: dir, pid: 1, now: () => NOW });
    mod.recordDispatch(input({ tool_use_id: 'toolu_3911', cwd: 'D:/other' }), {
      home: dir,
      pid: 2,
      now: () => new Date(NOW.getTime() + 1000),
    });
    const text = readFileSync(join(dir, 'subagent-ownership.jsonl'), 'utf8');
    expect(text.trim().split('\n')).toHaveLength(2);
    expect(mod.findOwnership(dir, 'toolu_3911')?.pid).toBe(1);
  });

  it('不是派子代理、缺 agentId、缺会话号、缺工作树：都不写，并说明为什么', () => {
    const dir = home();
    expect(mod.recordDispatch(input({ tool_name: 'Bash' }), { home: dir, pid: 1 }).recorded).toBe(false);
    expect(mod.recordDispatch(input({ tool_use_id: '' }), { home: dir, pid: 1 }).why).toMatch(/agentId/);
    expect(mod.recordDispatch(input({ session_id: '' }), { home: dir, pid: 1 }).why).toMatch(/会话/);
    expect(mod.recordDispatch(input({ cwd: '' }), { home: dir, pid: 1 }).why).toMatch(/工作树/);
    expect(mod.readOwnership(dir)).toEqual([]);
  });
});
